const { ipcMain } = require('electron');

function registerPricePredictionIpc({ pricePredictionService }) {
  ipcMain.handle('price-prediction:predict', () => pricePredictionService.predict());
}

module.exports = {
  registerPricePredictionIpc,
};
