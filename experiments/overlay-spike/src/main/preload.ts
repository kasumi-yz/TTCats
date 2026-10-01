import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('spike', {
  send: (channel: string, data: unknown) => ipcRenderer.send(channel, data),
  on: (channel: string, fn: (data: unknown) => void) => ipcRenderer.on(channel, (_e, data) => fn(data)),
  readMask: (name: string): Promise<Uint8Array> => ipcRenderer.invoke('readMask', name),
  manifest: (): Promise<unknown> => ipcRenderer.invoke('manifest'),
});
