import { contextBridge, ipcRenderer } from 'electron';
import type { HostAPI, ProjectSnapshot } from '@astrisle/contracts';

const invoke = <T>(method: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(`astrisle:${method}`, ...args);
const api: HostAPI = {
  bootstrap: () => invoke('bootstrap'),
  getDailyNewsMailbox: (id) => invoke('getDailyNewsMailbox', id),
  getDailyNewsIssue: (id, date) => invoke('getDailyNewsIssue', id, date),
  setDailyNewsSettings: (id, settings) => invoke('setDailyNewsSettings', id, settings),
  retryDailyNews: (id, date) => invoke('retryDailyNews', id, date),
  openDailyNewsSource: (id, date, url) => invoke('openDailyNewsSource', id, date, url),
  getCharacters: () => invoke('getCharacters'),
  createCharacter: (displayName) => invoke('createCharacter', displayName),
  updateCharacter: (id, patch) => invoke('updateCharacter', id, patch),
  importCharacter: (id) => invoke('importCharacter', id),
  prepareCharacterImport: (id) => invoke('prepareCharacterImport', id),
  completeCharacterImport: (id, token, inspection) =>
    invoke('completeCharacterImport', id, token, inspection),
  cancelCharacterImport: (token) => invoke('cancelCharacterImport', token),
  loadCharacterModel: (assetId) => invoke('loadCharacterModel', assetId),
  createWorkspace: (input) => invoke('createWorkspace', input),
  chooseDirectory: () => invoke('chooseDirectory'),
  submit: (input) => invoke('submit', input),
  snapshot: (id) => invoke('snapshot', id),
  askPartner: (input) => invoke('askPartner', input),
  control: (id, action) => invoke('control', id, action),
  updateBudget: (id, budget, revision) => invoke('updateBudget', id, budget, revision),
  answer: (id, answer, approve) => invoke('answer', id, answer, approve),
  revise: (id, instruction, revision) => invoke('revise', id, instruction, revision),
  accept: (id, artifacts) => invoke('accept', id, artifacts),
  artifact: (id) => invoke('artifact', id),
  compareArtifacts: (input) => invoke('compareArtifacts', input),
  requestArtifactRework: (input) => invoke('requestArtifactRework', input),
  exportSourceArtifact: (input) => invoke('exportSourceArtifact', input),
  openArtifact: (id) => invoke('openArtifact', id),
  exportArtifacts: (id) => invoke('exportArtifacts', id),
  prepareApply: (id) => invoke('prepareApply', id),
  apply: (id) => invoke('apply', id),
  inspectApply: (id) => invoke('inspectApply', id),
  prepareRollback: (id) => invoke('prepareRollback', id),
  openApplyBackups: (id) => invoke('openApplyBackups', id),
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
