const path = require('path');
const { handleInquiryRequest, handlePdfAssetRequest, handlePdfExportRequest } = require('./pdf-server');

module.exports = (env = {}, argv = {}) => ({
  entry: './src/index.js', // vstupní JS soubor
  output: {
    filename: 'bundle.js', // název výstupního JS
    path: path.resolve(__dirname, 'dist'), // cílová složka (ale používá se jen při buildu, ne dev serveru)
    publicPath: 'auto',
  },
  mode: argv.mode === 'production' ? 'production' : 'development',
  devtool: argv.mode === 'production' ? false : 'eval-source-map',
  devServer: {
    static: {
      directory: path.join(__dirname, 'public'), // odkud se podávají statické soubory
    },
    port: 8080,
    open: true,
    setupMiddlewares: (middlewares, devServer) => {
      if (devServer?.app) {
        devServer.app.options('/api/export-recap-pdf', (req, res) => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.status(204).end();
        });
        devServer.app.get('/api/pdf-asset', handlePdfAssetRequest);
        devServer.app.post('/api/export-recap-pdf', handlePdfExportRequest);
        devServer.app.post('/api/send-recap-inquiry', handleInquiryRequest);
      }

      return middlewares;
    },
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader', // pokud máš babel, jinak tento blok můžeš vypustit
        },
      },
    ],
  },
});
