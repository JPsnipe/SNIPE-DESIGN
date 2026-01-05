const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs/promises");

const { getPresets } = require("../shared/rig/presets.cjs");
const { runPhase1Simulation } = require("../shared/rig/runPhase1.cjs");
const { resultsToCsv } = require("../shared/rig/serialize.cjs");

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("presets:list", async () => getPresets());

ipcMain.handle("sim:runPhase1", async (_evt, payload) => {
  return runPhase1Simulation(payload);
});

ipcMain.handle("export:json", async (_evt, { suggestedName, data }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Export results JSON",
    defaultPath: suggestedName ?? "snipe-results.json",
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  return { ok: true, path: filePath };
});

ipcMain.handle("export:csv", async (_evt, { suggestedName, results }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Export results CSV",
    defaultPath: suggestedName ?? "snipe-results.csv",
    filters: [{ name: "CSV", extensions: ["csv"] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  const csv = resultsToCsv(results);
  await fs.writeFile(filePath, csv, "utf8");
  return { ok: true, path: filePath };
});

