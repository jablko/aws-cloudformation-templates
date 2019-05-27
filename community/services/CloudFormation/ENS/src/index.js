import SSM from 'aws-sdk/clients/ssm';
import ENS from 'ethereum-ens';
import namehash from 'eth-ens-namehash';
import { keccak_256 as sha3 } from 'js-sha3';
import crypto from 'crypto';
// https://github.com/w3c/webcomponents/issues/770
import { abi } from '@ensdomains/resolver/build/contracts/Resolver';
import { abi as reverseRegistrar } from '@ensdomains/ens/build/contracts/ReverseRegistrar';
import { abi as testRegistrar } from '@ensdomains/ens/build/contracts/TestRegistrar';
import { abi as ethRegistrarController } from '@ensdomains/ethregistrar/build/contracts/ETHRegistrarController';
import dnsRegistrar from '@ensdomains/dnsregistrar';
import { bytecode as dnsResolver } from '@ensdomains/resolver/build/contracts/DNSResolver';
import { answer } from 'dns-packet';
import https from 'https';
import util from 'util';

async function myAddress(wallet, privateKey) {
  if (privateKey === undefined) {
    const client = new SSM;
    const Name = 'privateKey';
    const params = {
      Name,
      WithDecryption: true
    };
    let data;
    try {
      data = await client.getParameter(params).promise();
    } catch (err) {
      if (err == 'ParameterNotFound: null') {
        wallet.create(1);
        const account = wallet[wallet.length - 1];
        const params = {
          Name,
          Value: account.privateKey,
          Type: 'SecureString'
        };
        await client.putParameter(params).promise();
        return account.address;
      } else {
        throw err;
      }
    }
    // else
    privateKey = data.Parameter.Value;
  }
  const account = wallet.add(privateKey);
  return account.address;
}

async function claim(ens, from) {
  const registrar = new ens.web3.eth.Contract(reverseRegistrar);
  registrar.options.address = await ens.owner('addr.reverse');
  const options = {
    from,
    gas: 1e5
  };
  await registrar.methods.claim(from).send(options);
}

async function register(ens, Name, from) {
  const i = Name.indexOf('.');
  const [label, parentName] =
    i == -1 ? [Name, ''] : [Name.slice(0, i), Name.slice(i + 1)];
  switch (parentName) {
    case 'test': {
      const registrar = new ens.web3.eth.Contract(testRegistrar);
      registrar.options.address = await ens.owner('test');
      const options = {
        from,
        gas: 1e5
      };
      await registrar.methods.register(`0x${sha3(label)}`, from).send(options);
      break;
    }
    case 'eth': {
      const controller = new ens.web3.eth.Contract(ethRegistrarController);
      controller.options.address = await ens
        .resolver('eth', abi)
        .interfaceImplementer('0x018FaC06');
      const secret = crypto.randomBytes(32);
      const options = {
        from,
        gas: 1e5
      };
      await controller.methods
        .register(label, from, 365 * 24 * 60 * 60, secret)
        .send(options);
      break;
    }
    default: {
      const registrar = new dnsRegistrar;
      try {
      } catch (err) {
        if (err == '') {
          await ens.setSubnodeOwner();
        } else {
          throw err;
        }
      }
    }
  }
}

async function deployDnsResolver(ens, from) {
  const receipt = await ens.web3.eth.sendTransaction({
    data: dnsResolver,
    from,
    gas: 6e6
  });
  return receipt.contractAddress;
}

export default async (event, context, callback, ens) => {
  let response;
  try {
    // Dependency injection, for testing. Code splitting [1] or using
    // Babel [2] are alternatives?
    //
    // [1] https://webpack.js.org/guides/code-splitting
    // [2] https://jestjs.io/docs/en/getting-started#using-babel
    if (ens === undefined) {
      ens = new ENS(
        event.ResourceProperties.Endpoint === undefined
          ? 'https://mainnet.infura.io'
          : event.ResourceProperties.Endpoint
      );
    }
    // ens.web3.defaultAccount doesn't work. Yet.
    // https://web3js.readthedocs.io/en/1.0/web3.html#defaultaccount
    const from = await myAddress(
      ens.web3.eth.accounts.wallet,
      event.ResourceProperties.PrivateKey
    );
    // No name? Update our revese record!
    const Name =
      event.ResourceProperties.Name === undefined
        ? `${from.slice(2)}.addr.reverse`
        : event.ResourceProperties.Name;
    let Inputs = Array.isArray(event.ResourceProperties.Inputs)
      ? event.ResourceProperties.Inputs
      : [event.ResourceProperties.Inputs];
    let options;
    const resource = event.ResourceType.slice('Custom::'.length);
    switch (resource) {
      case 'Dnsrr':
        Inputs = [
          Buffer.concat(
            [].concat(
              ...Inputs.map(rrs =>
                (Array.isArray(rrs.ResourceRecords)
                  ? rrs.ResourceRecords
                  : [rrs.ResourceRecords]
                ).map(rdata =>
                  answer.encode({
                    // https://github.com/mafintosh/dns-packet/pull/52
                    name: rrs.Name === undefined ? '.' : rrs.Name,
                    type: rrs.Type,
                    data: rdata
                  })
                )
              )
            )
          )
        ];
        options = {
          from,
          gas: 1e5
        };
        break;
      default:
        options = {
          from,
          gas: 1e5
        };
    }
    let Reason;
    try {
      Reason = await ens
        .resolver(Name, abi)
        [`set${resource}`](...Inputs, options);
    } catch (err) {
      // switch won't work, too strict.
      // https://tc39.github.io/ecma262/#sec-runtime-semantics-caseclauseisselected
      if (err == 'Error: ENS name not found') {
        console.log(err);
        const reverseName = `${from.slice(2)}.addr.reverse`;
        if (await ens.owner(Name) != from) {
          if (namehash.normalize(Name) == namehash.normalize(reverseName)) {
            await claim(ens, from);
          } else {
            await register(ens, Name, from);
          }
        }
        let resolver;
        if (resource == 'Dnsrr') {
          if (namehash.normalize(Name) == namehash.normalize(reverseName)) {
            resolver = await deployDnsResolver(ens, from);
          } else {
            try {
              resolver = await ens.resolver(reverseName).resolverAddress();
            } catch (err) {
              if (err == 'Error: ENS name not found') {
                if (await ens.owner(reverseName) != from) {
                  await claim(ens, from);
                }
                resolver = await deployDnsResolver(ens, from);
                const options = {
                  from,
                  gas: 1e5
                };
                await ens.setResolver(reverseName, resolver, options);
              } else {
                throw err;
              }
            }
          }
        } else {
          resolver = await ens.resolver('resolver.eth', abi).addr();
        }
        const options = {
          from,
          gas: 1e5
        };
        await ens.setResolver(Name, resolver, options);
      } else if (
        err ==
          'Error: Returned error: insufficient funds for gas * price + value' &&
        await ens.web3.eth.net.getId() == 3 // Ropsten
      ) {
        console.log(err);
        const res = await new Promise((resolve, reject) => {
          const req = https.request(
            `https://faucet.ropsten.be/donate/${from}`,
            resolve
          );
          req.on('error', reject);
          req.end();
        });
        if (res.statusCode < 200 || res.statusCode > 299) {
          throw new Error;
        }
      } else {
        throw err;
      }
      Reason = await ens
        .resolver(Name, abi)
        [`set${resource}`](...Inputs, options);
    }
    response = {
      Status: 'SUCCESS',
      Reason,
      Data: {
        Name,
        Namehash: namehash.hash(Name).slice(2)
      },
      RequestId: event.RequestId,
      StackId: event.StackId,
      LogicalResourceId: event.LogicalResourceId,
      // https://github.com/aws/aws-lambda-go/blob/master/cfn/wrap.go#L39
      // https://github.com/awsdocs/aws-cloudformation-user-guide/blob/6c35b11cc64b0b7142aa4f34191e841c877eb05b/doc_source/aws-properties-lambda-function-code.md#module-source-code
      PhysicalResourceId: context.logStreamName
    };
  } catch (err) {
    console.log(err);
    response = {
      Status: 'FAILED',
      Reason: util.inspect(err),
      RequestId: event.RequestId,
      StackId: event.StackId,
      LogicalResourceId: event.LogicalResourceId,
      PhysicalResourceId: context.logStreamName
    };
  }
  const options = {
    method: 'PUT'
  };
  const res = await new Promise((resolve, reject) => {
    const req = https.request(event.ResponseURL, options, resolve);
    req.on('error', reject);
    req.end(JSON.stringify(response));
  });
  if (res.statusCode < 200 || res.statusCode > 299) {
    throw new Error;
  }
};
