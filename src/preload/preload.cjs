const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("snipeApi", {
  listPresets: () => ipcRenderer.invoke("presets:list"),
  runPhase1: (payload) => ipcRenderer.invoke("sim:runPhase1", payload),
  exportJson: ({ suggestedName, data }) =>
    ipcRenderer.invoke("export:json", { suggestedName, data }),
  exportCsv: ({ suggestedName, results }) =>
    ipcRenderer.invoke("export:csv", { suggestedName, results })
});

