import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('probe', {
  send: (ev: unknown) => ipcRenderer.send('probe-event', ev),
});
