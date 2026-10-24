// What the chat window may ask the main process for (the core's actions, by name), and hear from it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatBridge', {
  call: (name, args) => ipcRenderer.invoke('ui', name, args ?? {}),
  onEvent: (fn) => ipcRenderer.on('ui:event', (_e, ev) => fn(ev)),
  close: () => ipcRenderer.send('chat:hide'),
});
