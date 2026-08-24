const { ipcMain } = require('electron');

function registerPricePredictionIpc({ pricePredictionService }) {
  ipcMain.handle('price-prediction:get-source-fields', () => pricePredictionService.getSourceFields());
  ipcMain.handle('price-prediction:predict', (_event, fields) => pricePredictionService.predict(fields));
  ipcMain.handle('price-prediction:list-runs', () => pricePredictionService.listRuns());
  ipcMain.handle('price-prediction:export-budget', (_event, payload) => pricePredictionService.exportBudgetTable(payload));
  ipcMain.handle('price-prediction:update-run-actual', (_event, runId, payload) => pricePredictionService.updateRunActual(runId, payload));
}

module.exports = {
  registerPricePredictionIpc,
};
