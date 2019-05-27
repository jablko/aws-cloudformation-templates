const main = require('./dist/main');
const https = require('https');
const ganache = require('ganache-core');
const ENS = require('ethereum-ens');
const namehash = require('eth-ens-namehash');
const ensRegistry = require('@ensdomains/ens/build/contracts/ENSRegistry');
const publicResolver = require('@ensdomains/resolver/build/contracts/PublicResolver');
const reverseRegistrar = require('@ensdomains/ens/build/contracts/ReverseRegistrar');
const testRegistrar = require('@ensdomains/ens/build/contracts/TestRegistrar');
const dnsResolver = require('@ensdomains/resolver/build/contracts/DNSResolver');
const util = require('util');

jest.mock('https');

let event, context, response;
beforeEach(() => {
  event = {
    ResourceType: 'Custom::Addr',
    ResourceProperties: {
      PrivateKey:
        '0xc5d2460186f7233C927e7db2dCc703c0E500B653cA82273b7bFaD8045d85A470',
      Inputs: '0x10CA3eff73ebEc87D2394Fc58560afEaB86DAc7A'
    }
  };
  context = {};
  response = {
    Status: 'SUCCESS',
    Data: {}
  };
  https.request.mockReturnValue({
    on: jest.fn(),
    end: jest.fn(chunk => {
      expect(JSON.parse(chunk)).toEqual(expect.objectContaining(response));
      const [call] = https.request.mock.calls;
      // eslint-disable-next-line no-unused-vars
      const [url, options, callback] = call;
      callback({});
    })
  });
});

function mockEnsTest(fn) {
  return async () => {
    const account = {
      address: '0x9cce34F7aB185c7ABA1b7C8140d620B4BDA941d6'
    };
    const resolver = {
      setAddr: jest.fn(),
      addr: jest.fn(),
      resolverAddress: jest.fn()
    };
    const contract = {
      options: {},
      methods: {}
    };
    const ens = {
      web3: {
        eth: {
          accounts: {
            wallet: {
              add: jest.fn().mockReturnValue(account)
            }
          },
          Contract: jest.fn(() => contract)
        }
      },
      setResolver: jest.fn(),
      owner: jest
        .fn()
        .mockReturnValue('0x9cce34F7aB185c7ABA1b7C8140d620B4BDA941d6'),
      resolver: jest.fn().mockReturnValue(resolver)
    };
    fn(resolver, contract, ens);
    await main.default(event, context, undefined, ens);
  };
}

function mockProviderTest(sequence, fn) {
  return async () => {
    const send = jest.fn();
    for (const [method, result] of [
      // https://github.com/ensdomains/ensjs/blob/master/index.js#L219
      ['net_version', 1],
      ...sequence
    ]) {
      send.mockImplementationOnce((payload, callback) => {
        expect(payload.method).toBe(method);
        callback(undefined, {
          jsonrpc: '2.0',
          id: payload.id,
          result
        });
      });
    }
    event.ResourceProperties.Endpoint = {
      send
    };
    fn();
    await main.default(event, context);
  };
}

const web3MethodSend = [
  // https://github.com/ethereum/web3.js/blob/1.0.0-beta.37/packages/web3-core-method/src/index.js#L572
  ['eth_gasPrice', 1],
  // https://github.com/ethereum/web3.js/blob/1.0.0-beta.37/packages/web3-eth-accounts/src/index.js#L223
  ['net_version', 1],
  // https://github.com/ethereum/web3.js/blob/1.0.0-beta.37/packages/web3-eth-accounts/src/index.js#L225
  ['eth_getTransactionCount', 0],
  // https://github.com/ethereum/web3.js/blob/1.0.0-beta.37/packages/web3-core-method/src/index.js#L519
  ['eth_sendRawTransaction', null],
  // https://github.com/ethereum/web3.js/blob/1.0.0-beta.37/packages/web3-core-method/src/index.js#L421
  [
    'eth_getTransactionReceipt',
    {
      blockHash: true,
      contractAddress: '0x0000000000000000000000000000000000000000'
    }
  ]
];

const setResource = [
  // ENS.resolver(Name)
  [
    'eth_call',
    '0x0000000000000000000000001CF8eebF67dF4CC8De3bC92242C7a5691A7Cdd7e'
  ],
  // https://github.com/ensdomains/ensjs/blob/master/index.js#L109
  ['eth_accounts', []],
  // Resolver[`set${resource}`](Name, ...Inputs)
  ...web3MethodSend
];

const setResolver = [
  // ENS.resolver('resolver.eth')
  [
    'eth_call',
    '0x0000000000000000000000001CF8eebF67dF4CC8De3bC92242C7a5691A7Cdd7e'
  ],
  // Resolver.addr('resolver.eth')
  [
    'eth_call',
    '0x0000000000000000000000001CF8eebF67dF4CC8De3bC92242C7a5691A7Cdd7e'
  ],
  // https://github.com/ensdomains/ensjs/blob/master/index.js#L109
  ['eth_accounts', []],
  // ENS.setResolver(Name, resolver)
  ...web3MethodSend
];

let ganacheEns;
beforeAll(async () => {
  ganacheEns = new ENS(ganache.provider());
  ganacheEns.web3.currentProvider.send = util.promisify(
    ganacheEns.web3.currentProvider.send
  );
  const accounts = await ganacheEns.web3.eth.getAccounts();
  const from = accounts[0];
  const registry = await new ganacheEns.web3.eth.Contract(ensRegistry.abi)
    .deploy({
      data: ensRegistry.bytecode
    })
    .send({
      from,
      gas: 6e6
    });
  (await ganacheEns.registryPromise).options.address = registry.options.address;
  const resolver = await new ganacheEns.web3.eth.Contract(publicResolver.abi)
    .deploy({
      data: publicResolver.bytecode,
      arguments: [registry.options.address]
    })
    .send({
      from,
      gas: 6e6
    });
  await ganacheEns.setSubnodeOwner('eth', from);
  await ganacheEns.setSubnodeOwner('resolver.eth', from);
  await ganacheEns.setResolver('resolver.eth', resolver.options.address);
  await ganacheEns.resolver('resolver.eth').setAddr(resolver.options.address);
  {
    const registrar = await new ganacheEns.web3.eth.Contract(
      reverseRegistrar.abi
    )
      .deploy({
        data: reverseRegistrar.bytecode,
        arguments: [
          registry.options.address,
          '0x0000000000000000000000000000000000000000'
        ]
      })
      .send({
        from,
        gas: 6e6
      });
    await ganacheEns.setSubnodeOwner('reverse', from);
    await ganacheEns.setSubnodeOwner('addr.reverse', registrar.options.address);
  }
  {
    const registrar = await new ganacheEns.web3.eth.Contract(testRegistrar.abi)
      .deploy({
        data: testRegistrar.bytecode,
        arguments: [registry.options.address, namehash.hash('test')]
      })
      .send({
        from,
        gas: 6e6
      });
    await ganacheEns.setSubnodeOwner('test', registrar.options.address);
  }
  await ganacheEns.web3.eth.sendTransaction({
    value: 1e18,
    from,
    to: '0x9cce34F7aB185c7ABA1b7C8140d620B4BDA941d6'
  });
});

function ganacheTest(fn) {
  return async () => {
    const result = await ganacheEns.web3.currentProvider.send({
      method: 'evm_snapshot'
    });
    try {
      await fn();
      await main.default(event, context, undefined, ganacheEns);
    } finally {
      await ganacheEns.web3.currentProvider.send({
        method: 'evm_revert',
        params: result.result
      });
    }
  };
}

test(
  'Addr, mock ENS',
  mockEnsTest((resolver, contract, ens) => {
    response.Data.Name = event.ResourceProperties.Name = 'foo.test';
    response.Data.Namehash =
      '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
  })
);

test(
  'Addr, mock provider',
  mockProviderTest(setResource, () => {
    response.Data.Name = event.ResourceProperties.Name = 'foo.test';
    response.Data.Namehash =
      '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
  })
);

test(
  'Addr, Ganache',
  ganacheTest(async () => {
    response.Data.Name = event.ResourceProperties.Name = 'foo.test';
    response.Data.Namehash =
      '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
    const accounts = await ganacheEns.web3.eth.getAccounts();
    const from = accounts[0];
    const resolver = await ganacheEns.resolver('resolver.eth').addr();
    await ganacheEns.setSubnodeOwner('test', from);
    await ganacheEns.setSubnodeOwner('foo.test', from);
    await ganacheEns.setResolver('foo.test', resolver);
    await ganacheEns.setOwner(
      'foo.test',
      '0x9cce34F7aB185c7ABA1b7C8140d620B4BDA941d6'
    );
  })
);

test(
  'Set resolver, mock ENS',
  mockEnsTest((resolver, contract, ens) => {
    response.Data.Name = event.ResourceProperties.Name = 'foo.test';
    response.Data.Namehash =
      '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
    resolver.setAddr.mockRejectedValueOnce(new Error('ENS name not found'));
  })
);

test(
  'Set resolver, mock provider',
  mockProviderTest(
    [
      // ENS.resolver(Name)
      [
        'eth_call',
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ],
      // ENS.owner(Name)
      [
        'eth_call',
        '0x0000000000000000000000009cce34F7aB185c7ABA1b7C8140d620B4BDA941d6'
      ],
      ...setResolver,
      ...setResource
    ],
    () => {
      response.Data.Name = event.ResourceProperties.Name = 'foo.test';
      response.Data.Namehash =
        '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
    }
  )
);

test(
  'Set resolver, Ganache',
  ganacheTest(async () => {
    response.Data.Name = event.ResourceProperties.Name = 'foo.test';
    response.Data.Namehash =
      '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
    const accounts = await ganacheEns.web3.eth.getAccounts();
    const from = accounts[0];
    await ganacheEns.setSubnodeOwner('test', from);
    await ganacheEns.setSubnodeOwner(
      'foo.test',
      '0x9cce34F7aB185c7ABA1b7C8140d620B4BDA941d6'
    );
  })
);

test(
  'Reverse registrar, mock ENS',
  mockEnsTest((resolver, contract, ens) => {
    response.Data.Name =
      '9cce34F7aB185c7ABA1b7C8140d620B4BDA941d6.addr.reverse';
    response.Data.Namehash =
      'fc7dbc645f087605b95a014daff1543d7895e72dd8068e4b816f37553aa82b1b';
    resolver.setAddr.mockRejectedValueOnce(new Error('ENS name not found'));
    ens.owner.mockReturnValue('0x0000000000000000000000000000000000000000');
    contract.methods.claim = jest.fn().mockReturnValue({
      send: jest.fn()
    });
  })
);

test(
  'Reverse registrar, mock provider',
  mockProviderTest(
    [
      // ENS.resolver(Name)
      [
        'eth_call',
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ],
      // ENS.owner(Name)
      [
        'eth_call',
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ],
      // ENS.owner('addr.reverse')
      [
        'eth_call',
        '0x0000000000000000000000005608cA83F9a41A423Fa54D5a12C1DD1212E5C699'
      ],
      // ReverseRegistrar.claim(owner)
      ...web3MethodSend,
      ...setResolver,
      ...setResource
    ],
    () => {
      response.Data.Name =
        '9cce34F7aB185c7ABA1b7C8140d620B4BDA941d6.addr.reverse';
      response.Data.Namehash =
        'fc7dbc645f087605b95a014daff1543d7895e72dd8068e4b816f37553aa82b1b';
    }
  )
);

test(
  'Reverse registrar, Ganache',
  ganacheTest(async () => {
    response.Data.Name =
      '9cce34F7aB185c7ABA1b7C8140d620B4BDA941d6.addr.reverse';
    response.Data.Namehash =
      'fc7dbc645f087605b95a014daff1543d7895e72dd8068e4b816f37553aa82b1b';
  })
);

test(
  'Test registrar, mock ENS',
  mockEnsTest((resolver, contract, ens) => {
    response.Data.Name = event.ResourceProperties.Name = 'foo.test';
    response.Data.Namehash =
      '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
    resolver.setAddr.mockRejectedValueOnce(new Error('ENS name not found'));
    ens.owner.mockReturnValue('0x0000000000000000000000000000000000000000');
    contract.methods.register = jest.fn().mockReturnValue({
      send: jest.fn()
    });
  })
);

test(
  'Test registrar, mock provider',
  mockProviderTest(
    [
      // ENS.resolver(Name)
      [
        'eth_call',
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ],
      // ENS.owner(Name)
      [
        'eth_call',
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ],
      // ENS.owner('.test')
      [
        'eth_call',
        '0x000000000000000000000000f84E0FD035cB7Aa5B5D93Fb7A3e3bAff3911A59c'
      ],
      // TestRegistrar.register(label, owner)
      ...web3MethodSend,
      ...setResolver,
      ...setResource
    ],
    () => {
      response.Data.Name = event.ResourceProperties.Name = 'foo.test';
      response.Data.Namehash =
        '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
    }
  )
);

test(
  'Test registrar, Ganache',
  ganacheTest(async () => {
    response.Data.Name = event.ResourceProperties.Name = 'foo.test';
    response.Data.Namehash =
      '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
  })
);

test(
  '.eth registrar, mock ENS',
  mockEnsTest((resolver, contract, ens) => {
    response.Data.Name = event.ResourceProperties.Name = 'foo.eth';
    response.Data.Namehash =
      'de9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f';
    resolver.setAddr.mockRejectedValueOnce(new Error('ENS name not found'));
    ens.owner.mockReturnValue('0x0000000000000000000000000000000000000000');
    resolver.interfaceImplementer = jest.fn();
    contract.methods.register = jest.fn().mockReturnValue({
      send: jest.fn()
    });
  })
);

test(
  '.eth registrar, mock provider',
  mockProviderTest(
    [
      // ENS.resolver(Name)
      [
        'eth_call',
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ],
      // ENS.owner(Name)
      [
        'eth_call',
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ],
      // ENS.resolver('.eth')
      [
        'eth_call',
        '0x0000000000000000000000001CF8eebF67dF4CC8De3bC92242C7a5691A7Cdd7e'
      ],
      // Resolver.interfaceImplementer('.eth', controller)
      [
        'eth_call',
        '0x000000000000000000000000Bf20e740D22F181BfDd8F8db34136a75F0CCD86b'
      ],
      // ETHRegistrarController.register(label, owner)
      ...web3MethodSend,
      ...setResolver,
      ...setResource
    ],
    () => {
      response.Data.Name = event.ResourceProperties.Name = 'foo.eth';
      response.Data.Namehash =
        'de9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f';
    }
  )
);

test(
  'Dnsrr, mock ENS',
  mockEnsTest((resolver, contract, ens) => {
    response.Data.Name = event.ResourceProperties.Name = 'foo.test';
    response.Data.Namehash =
      '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
    event.ResourceType = 'Custom::Dnsrr';
    event.ResourceProperties.Inputs = {
      Type: 'A',
      ResourceRecords: '1.2.3.4'
    };
    resolver.setDnsrr = jest.fn();
  })
);

test(
  'Dnsrr, mock provider',
  mockProviderTest(setResource, () => {
    response.Data.Name = event.ResourceProperties.Name = 'foo.test';
    response.Data.Namehash =
      '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
    event.ResourceType = 'Custom::Dnsrr';
    event.ResourceProperties.Inputs = {
      Type: 'A',
      ResourceRecords: '1.2.3.4'
    };
  })
);

test(
  'Dnsrr, Ganache',
  ganacheTest(async () => {
    response.Data.Name = event.ResourceProperties.Name = 'foo.test';
    response.Data.Namehash =
      '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
    event.ResourceType = 'Custom::Dnsrr';
    event.ResourceProperties.Inputs = {
      Type: 'A',
      ResourceRecords: '1.2.3.4'
    };
    const accounts = await ganacheEns.web3.eth.getAccounts();
    const from = accounts[0];
    const testAccount = ganacheEns.web3.eth.accounts.wallet.add(
      '0xc5d2460186f7233C927e7db2dCc703c0E500B653cA82273b7bFaD8045d85A470'
    );
    const resolver = await new ganacheEns.web3.eth.Contract(dnsResolver.abi)
      .deploy({
        data: dnsResolver.bytecode
      })
      .send({
        from: testAccount.address,
        gas: 6e6
      });
    await ganacheEns.setSubnodeOwner('test', from);
    await ganacheEns.setSubnodeOwner('foo.test', from);
    await ganacheEns.setResolver('foo.test', resolver.options.address);
  })
);

test(
  'Set DNS resolver, mock ENS',
  mockEnsTest((resolver, contract, ens) => {
    response.Data.Name = event.ResourceProperties.Name = 'foo.test';
    response.Data.Namehash =
      '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
    event.ResourceType = 'Custom::Dnsrr';
    event.ResourceProperties.Inputs = {
      Type: 'A',
      ResourceRecords: '1.2.3.4'
    };
    resolver.setDnsrr = jest
      .fn()
      .mockRejectedValueOnce(new Error('ENS name not found'));
  })
);

test(
  'Set DNS resolver, mock provider',
  mockProviderTest(
    [
      // ENS.resolver(Name)
      [
        'eth_call',
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ],
      // ENS.owner(Name)
      [
        'eth_call',
        '0x0000000000000000000000009cce34F7aB185c7ABA1b7C8140d620B4BDA941d6'
      ],
      // ENS.resolver(reverseName)
      [
        'eth_call',
        '0x00000000000000000000000049eeBf720C26adCe6D5321848F714894BC76b0A4'
      ],
      // https://github.com/ensdomains/ensjs/blob/master/index.js#L109
      ['eth_accounts', []],
      // ENS.setResolver(Name, resolver)
      ...web3MethodSend,
      ...setResource
    ],
    () => {
      response.Data.Name = event.ResourceProperties.Name = 'foo.test';
      response.Data.Namehash =
        '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
      event.ResourceType = 'Custom::Dnsrr';
      event.ResourceProperties.Inputs = {
        Type: 'A',
        ResourceRecords: '1.2.3.4'
      };
    }
  )
);

test(
  'Set DNS resolver, Ganache',
  ganacheTest(async () => {
    response.Data.Name = event.ResourceProperties.Name = 'foo.test';
    response.Data.Namehash =
      '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
    event.ResourceType = 'Custom::Dnsrr';
    event.ResourceProperties.Inputs = {
      Type: 'A',
      ResourceRecords: '1.2.3.4'
    };
    const accounts = await ganacheEns.web3.eth.getAccounts();
    const from = accounts[0];
    const testAccount = ganacheEns.web3.eth.accounts.wallet.add(
      '0xc5d2460186f7233C927e7db2dCc703c0E500B653cA82273b7bFaD8045d85A470'
    );
    const resolver = await new ganacheEns.web3.eth.Contract(dnsResolver.abi)
      .deploy({
        data: dnsResolver.bytecode
      })
      .send({
        from: testAccount.address,
        gas: 6e6
      });
    await ganacheEns.setSubnodeOwner('addr.reverse', from);
    await ganacheEns.setSubnodeOwner(
      '9cce34F7aB185c7ABA1b7C8140d620B4BDA941d6.addr.reverse',
      from
    );
    await ganacheEns.setResolver(
      '9cce34F7aB185c7ABA1b7C8140d620B4BDA941d6.addr.reverse',
      resolver.options.address
    );
    await ganacheEns.setSubnodeOwner('test', from);
    await ganacheEns.setSubnodeOwner(
      'foo.test',
      '0x9cce34F7aB185c7ABA1b7C8140d620B4BDA941d6'
    );
  })
);

test(
  'Deploy DNS resolver, mock ENS',
  mockEnsTest((resolver, contract, ens) => {
    response.Data.Name = event.ResourceProperties.Name = 'foo.test';
    response.Data.Namehash =
      '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
    event.ResourceType = 'Custom::Dnsrr';
    event.ResourceProperties.Inputs = {
      Type: 'A',
      ResourceRecords: '1.2.3.4'
    };
    resolver.setDnsrr = jest
      .fn()
      .mockRejectedValueOnce(new Error('ENS name not found'));
    resolver.resolverAddress.mockRejectedValueOnce(
      new Error('ENS name not found')
    );
    ens.web3.eth.sendTransaction = jest.fn().mockReturnValue({});
  })
);

test(
  'Deploy DNS resolver, mock provider',
  mockProviderTest(
    [
      // ENS.resolver(Name)
      [
        'eth_call',
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ],
      // ENS.owner(Name)
      [
        'eth_call',
        '0x0000000000000000000000009cce34F7aB185c7ABA1b7C8140d620B4BDA941d6'
      ],
      // ENS.resolver(reverseName)
      [
        'eth_call',
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ],
      // ENS.owner(reverseName)
      [
        'eth_call',
        '0x0000000000000000000000009cce34F7aB185c7ABA1b7C8140d620B4BDA941d6'
      ],
      // web3.eth.sendTransaction({ data: bytecode })
      ...web3MethodSend,
      // https://github.com/ethereum/web3.js/blob/1.0.0-beta.37/packages/web3-core-method/src/index.js#L310
      ['eth_getCode', dnsResolver.bytecode],
      // https://github.com/ensdomains/ensjs/blob/master/index.js#L109
      ['eth_accounts', []],
      // ENS.setResolver(reverseName, resolver)
      ...web3MethodSend,
      // https://github.com/ensdomains/ensjs/blob/master/index.js#L109
      ['eth_accounts', []],
      // ENS.setResolver(Name, resolver)
      ...web3MethodSend,
      ...setResource
    ],
    () => {
      response.Data.Name = event.ResourceProperties.Name = 'foo.test';
      response.Data.Namehash =
        '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
      event.ResourceType = 'Custom::Dnsrr';
      event.ResourceProperties.Inputs = {
        Type: 'A',
        ResourceRecords: '1.2.3.4'
      };
    }
  )
);

test(
  'Deploy DNS resolver, Ganache',
  ganacheTest(async () => {
    response.Data.Name = event.ResourceProperties.Name = 'foo.test';
    response.Data.Namehash =
      '9c0b37f867935a43b7bc2f2532bc37fde70bb660008b33d3bffa413bf9e869e9';
    event.ResourceType = 'Custom::Dnsrr';
    event.ResourceProperties.Inputs = {
      Type: 'A',
      ResourceRecords: '1.2.3.4'
    };
    const accounts = await ganacheEns.web3.eth.getAccounts();
    const from = accounts[0];
    await ganacheEns.setSubnodeOwner('addr.reverse', from);
    await ganacheEns.setSubnodeOwner(
      '9cce34F7aB185c7ABA1b7C8140d620B4BDA941d6.addr.reverse',
      '0x9cce34F7aB185c7ABA1b7C8140d620B4BDA941d6'
    );
    await ganacheEns.setSubnodeOwner('test', from);
    await ganacheEns.setSubnodeOwner(
      'foo.test',
      '0x9cce34F7aB185c7ABA1b7C8140d620B4BDA941d6'
    );
  })
);
