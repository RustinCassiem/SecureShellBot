const path = require('path');

module.exports = {
  mode: 'production', // or 'development' for local builds
  entry: './src/bot.ts , 
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
  },
};
