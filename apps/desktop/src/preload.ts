import { contextBridge, ipcRenderer } from 'electron';
import type { HostAPI, ProjectSnapshot } from '@astrisle/contracts';

const invoke = <T>(method: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(`astrisle:${method}`, ...args);
const api: HostAPI = {
  bootstrap: () => invoke('bootstrap'),
  getCharacters: () => invoke('getCharacters'),
  updateCharacter: (id, patch) => invoke('updateCharacter', id, patch),
  importCharacter: (id) => invoke('importCharacter', id),
  loadCharacterModel: (assetId) => invoke('loadCharacterModel', assetId),
  createWorkspace: (input) => invoke('createWorkspace', input),
  chooseDirectory: () => invoke('chooseDirectory'),
  submit: (input) => invoke('submit', input),
  snapshot: (id) => invoke('snapshot', id),
  control: (id, action) => invoke('control', id, action),
  answer: (id, answer, approve) => invoke('answer', id, answer, approve),
  revise: (id, instruction, revision) => invoke('revise', id, instruction, revision),
  accept: (id, artifacts) => invoke('accept', id, artifacts),
  artifact: (id) => invoke('artifact', id),
  openArtifact: (id) => invoke('openArtifact', id),
  exportArtifacts: (id) => invoke('exportArtifacts', id),
  prepareApply: (id) => invoke('prepareApply', id),
  apply: (id) => invoke('apply', id),
  saveProvider: (input) => invoke('saveProvider', input),
  testProvider: () => invoke('testProvider'),
  onSnapshot: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, snapshot: ProjectSnapshot) =>
      listener(snapshot);
    ipcRenderer.on('astrisle:snapshot', callback);
    return () => ipcRenderer.removeListener('astrisle:snapshot', callback);
  },
};
contextBridge.exposeInMainWorld('astrisle', api);
