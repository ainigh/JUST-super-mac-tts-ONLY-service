// The few things the page may ask the main process for.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag:move', dx, dy),
  dragEnd: () => ipcRenderer.send('drag:end'),
  showMenu: () => ipcRenderer.send('menu:show'),
  on: (channel, fn) => {
    if (!['menu', 'shortcut', 'click-through'].includes(channel)) return;
    ipcRenderer.on(channel, (_e, ...args) => fn(...args));
  },
});
