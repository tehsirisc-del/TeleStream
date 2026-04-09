const webpack = require('webpack');
const path = require('path');

module.exports = {
  mode: 'production',
  entry: './build-entry.js',
  output: {
    filename: 'telegram.browser.js',
    path: path.resolve(__dirname, 'web/js/vendor'),
    library: 'TelegramModule',
    libraryTarget: 'window'
  },
  resolve: {
    fallback: {
      stream: require.resolve('stream-browserify'),
      buffer: require.resolve('buffer/'),
      crypto: require.resolve('crypto-browserify'),
      os: require.resolve('os-browserify/browser'),
      path: require.resolve('path-browserify'),
      util: require.resolve('util/'),
      fs: false,
      net: false,
      tls: false,
      dns: false,
      http: false,
      https: false,
      zlib: false,
      http2: false,
      child_process: false
    }
  },
  plugins: [
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser'
    }),
    new webpack.DefinePlugin({
      'process.env.NODE_ENV': JSON.stringify('production')
    }),
    // Stub modules that are not for browser
    new webpack.NormalModuleReplacementPlugin(
      /node-localstorage/,
      path.resolve(__dirname, 'build-stub.js')
    )
  ],
  optimization: {
    minimize: true
  },
  stats: { errorDetails: true }
};
