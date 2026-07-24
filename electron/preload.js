const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("widgetAPI", {
  expand: () => ipcRenderer.invoke("widget:expand"),
  collapse: () => ipcRenderer.invoke("widget:collapse"),
  setState: (state) => ipcRenderer.invoke("widget:set-state", state),
  setAlertSize: (size) => ipcRenderer.invoke("widget:set-alert-size", size),
  hide: () => ipcRenderer.invoke("widget:hide"),
  openMain: () => ipcRenderer.invoke("widget:openMain"),
  openMainWindow: (path) => ipcRenderer.invoke("widget:openMainWindow", path),
  notify: (payload) => ipcRenderer.invoke("widget:notify", payload),
  dragStart: (sx, sy) => ipcRenderer.send("widget:drag-start", sx, sy),
  dragMove: (sx, sy) => ipcRenderer.send("widget:drag-move", sx, sy),
  dragEnd: () => ipcRenderer.send("widget:drag-end"),
  onSetExpanded: (cb) => ipcRenderer.on("widget:set-expanded", (_e, v) => cb(v))
});
