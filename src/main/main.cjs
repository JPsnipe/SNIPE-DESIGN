const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const { Worker } = require("worker_threads");
const http = require("http");

const { getPresets } = require("../shared/rig/presets.cjs");
const { resultsToCsv } = require("../shared/rig/serialize.cjs");

let mainWindow = null;
let currentWorker = null;
let jobIdCounter = 0;

// Estado global para monitoreo externo
let simulationState = {
  running: false,
  jobId: null,
  startTime: null,
  lastMetrics: null,
  lastResult: null,
  error: null
};

// Servidor HTTP para monitoreo externo (Claude)
const DEBUG_PORT = 3847;
const debugServer = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url === "/status") {
    res.end(JSON.stringify({
      ...simulationState,
      elapsed: simulationState.startTime ? Date.now() - simulationState.startTime : null,
      windowOpen: mainWindow !== null
    }, null, 2));
  } else if (req.url === "/metrics") {
    res.end(JSON.stringify(simulationState.lastMetrics || {}, null, 2));
  } else if (req.url === "/result") {
    res.end(JSON.stringify(simulationState.lastResult || {}, null, 2));
  } else {
    res.end(JSON.stringify({
      endpoints: ["/status", "/metrics", "/result"],
      help: "Monitor SnipeDesign simulation state"
    }));
  }
});

debugServer.listen(DEBUG_PORT, () => {
  console.log(`[DEBUG] Monitor server running at http://localhost:${DEBUG_PORT}`);
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false  // Necesario para worker_threads
    }
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  // Abrir DevTools para debug (Ctrl+Shift+I también funciona)
  // mainWindow.webContents.openDevTools({ mode: "detach" });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (currentWorker) {
      currentWorker.terminate();
      currentWorker = null;
    }
  });
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

// Simulación en segundo plano con worker thread
ipcMain.handle("sim:runPhase1Async", async (_evt, payload) => {
  // Si hay un worker activo, terminarlo
  if (currentWorker) {
    currentWorker.terminate();
    currentWorker = null;
  }

  const jobId = ++jobIdCounter;

  // Actualizar estado para monitoreo
  simulationState = {
    running: true,
    jobId,
    startTime: Date.now(),
    lastMetrics: null,
    lastResult: null,
    error: null
  };

  return new Promise((resolve, reject) => {
    try {
      currentWorker = new Worker(path.join(__dirname, "solverWorker.cjs"), {
        workerData: { payload, jobId }
      });

      currentWorker.on("message", (msg) => {
        if (msg.type === "progress") {
          // Actualizar métricas para monitoreo
          simulationState.lastMetrics = { ...msg.metrics, timestamp: Date.now() };
          if (mainWindow) {
            mainWindow.webContents.send("sim:progress", {
              jobId,
              ...msg.metrics
            });
          }
        } else if (msg.type === "completed") {
          currentWorker = null;
          simulationState.running = false;
          simulationState.lastResult = {
            converged: msg.result?.converged,
            iterations: msg.result?.iterations,
            energy: msg.result?.energy,
            duration: msg.duration
          };
          resolve({
            jobId: msg.jobId,
            result: msg.result,
            duration: msg.duration
          });
        } else if (msg.type === "error") {
          currentWorker = null;
          simulationState.running = false;
          simulationState.error = msg.error.message;
          reject(new Error(msg.error.message));
        } else if (msg.type === "started" && mainWindow) {
          mainWindow.webContents.send("sim:started", { jobId });
        }
      });

      currentWorker.on("error", (err) => {
        currentWorker = null;
        simulationState.running = false;
        simulationState.error = err.message;
        reject(err);
      });

      currentWorker.on("exit", (code) => {
        if (code !== 0 && currentWorker) {
          currentWorker = null;
          simulationState.running = false;
          simulationState.error = `Worker exit code ${code}`;
          reject(new Error(`Worker stopped with exit code ${code}`));
        }
      });
    } catch (err) {
      simulationState.running = false;
      simulationState.error = err.message;
      reject(err);
    }
  });
});

// Cancelar simulación en curso
ipcMain.handle("sim:cancel", async () => {
  if (currentWorker) {
    currentWorker.terminate();
    currentWorker = null;
    return { cancelled: true };
  }
  return { cancelled: false };
});

// Verificar estado de simulación
ipcMain.handle("sim:status", async () => {
  return {
    running: currentWorker !== null
  };
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
