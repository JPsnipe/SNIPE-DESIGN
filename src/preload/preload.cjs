const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("snipeApi", {
  listPresets: () => ipcRenderer.invoke("presets:list"),

  // Simulación asíncrona (no bloquea UI)
  runPhase1Async: (payload) => ipcRenderer.invoke("sim:runPhase1Async", payload),

  // Cancelar simulación en curso
  cancelSimulation: () => ipcRenderer.invoke("sim:cancel"),

  // Verificar estado
  getSimulationStatus: () => ipcRenderer.invoke("sim:status"),

  // Suscribirse a eventos de progreso
  onSimulationProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("sim:progress", handler);
    return () => ipcRenderer.removeListener("sim:progress", handler);
  },

  // Suscribirse a evento de inicio
  onSimulationStarted: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("sim:started", handler);
    return () => ipcRenderer.removeListener("sim:started", handler);
  },

  // Export
  exportJson: ({ suggestedName, data }) =>
    ipcRenderer.invoke("export:json", { suggestedName, data }),
  exportCsv: ({ suggestedName, results }) =>
    ipcRenderer.invoke("export:csv", { suggestedName, results })
});
