import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('spike', {
  onFrame: (callback: (frame: unknown) => void) =>
    ipcRenderer.on('frame', (_event, frame: unknown) => callback(frame)),
  painted: (sequence: number) => ipcRenderer.send('painted', sequence),
});
