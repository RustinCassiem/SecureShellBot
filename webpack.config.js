const path = require('path');

module.exports = {
  mode: 'production', // or 'development'
  entry: './src/bot.ts',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.node$/,
        loader: 'node-loader',
      },
    ],
  },
  target: 'node', // since you're building a Telegram bot
  externals: {
    // Mark .node files as external
    'cpu-features': 'commonjs cpu-features',
    'sshcrypto': 'commonjs sshcrypto',
  },
};
