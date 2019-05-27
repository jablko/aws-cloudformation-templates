const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  output: {
    libraryTarget: 'commonjs'
  },
  // https://github.com/webpack-contrib/node-loader/issues/12
  plugins: [
    new CopyPlugin([
      {
        from: 'node_modules/scrypt/build/Release/scrypt.node',
        to: 'build/Release'
      }
    ])
  ],
  //devtool: 'source-map',
  target: 'node',
  externals: [
    'aws-sdk/clients/ssm',
    // https://github.com/barrysteyn/node-scrypt/issues/162
    './build/Release/scrypt',
    // https://github.com/sindresorhus/got/issues/345
    'electron'
  ]
};
