import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('astrisleCharacterValidation', {
  read: () => ipcRenderer.invoke('astrisle:private-character-validator:read'),
  report: (result: unknown) =>
    ipcRenderer.invoke('astrisle:private-character-validator:report', result),
});
