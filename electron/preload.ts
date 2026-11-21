import { contextBridge, ipcRenderer } from 'electron';
import type { Change, Event, Run } from './engine.js';
import type { ShellPermissionEvent } from './shell-permissions.js';
export type MuvAPI = {
  setShellMode(input: { workspace: string; mode: import('./shell-permissions.js').ShellMode }): Promise<import('./shell-permissions.js').ShellMode>;
  respondShellPermission(input: { id: string; allow: boolean }): Promise<boolean>;
  onShellPermission(handler: (event: ShellPermissionEvent) => void): () => void;
  bootstrap(): Promise<{ shellModes: Record<string, import('./shell-permissions.js').ShellMode>; settings: { baseUrl: string; model: string; hasKey: boolean; effort: string; contextWindow?: number; multimodal?: boolean }; workspaces: string[]; memories: { id: string; text: string; enabled: boolean }[]; sessions: any[] }>;
  saveSettings(settings: { baseUrl: string; model: string; key?: string; effort: string; contextWindow?: number; multimodal?: boolean }): Promise<void>;
  listModels(input: { baseUrl: string; key?: string }): Promise<string[]>;
  referenceIndex(input: { workspace: string }): Promise<{ kind: 'file' | 'folder' | 'terminal'; path: string }[]>;
  chooseWorkspace(): Promise<string | null>;
  listPlans(input: { workspace: string }): Promise<{ path: string; id: string }[]>;
  readPlan(input: { workspace: string; path: string }): Promise<{ path: string; id: string; content: string }>;
  savePlan(input: { workspace: string; path: string; planId: string; content: string; expected: string }): Promise<{ path: string; id: string; content: string }>;
  openPlan(input: { workspace: string; path: string; planId: string }): Promise<void>;
  run(request: Run & { planPath?: string; planId?: string }): Promise<void>;
  cancel(id: string): Promise<void>;
  onEvent(handler: (event: Event) => void): () => void;
  saveData(data: { memories: { id: string; text: string; enabled: boolean }[]; sessions: any[] }): Promise<void>;
  apply(request: { workspace: string; changes: Change[] }): Promise<void>;
  undo(transactionId?: string): Promise<void>;
  undoableTransactions(): Promise<string[]>;
};
const api: MuvAPI = {
  setShellMode: value => ipcRenderer.invoke('muv:setShellMode', value),
  respondShellPermission: value => ipcRenderer.invoke('muv:respondShellPermission', value),
  onShellPermission: handler => {
    const listener = (_event: Electron.IpcRendererEvent, value: ShellPermissionEvent) => handler(value);
    ipcRenderer.on('muv:shellPermission', listener);
    return () => ipcRenderer.removeListener('muv:shellPermission', listener);
  },
  bootstrap: () => ipcRenderer.invoke('muv:bootstrap'),
  saveSettings: value => ipcRenderer.invoke('muv:saveSettings', value),
  listModels: value => ipcRenderer.invoke('muv:listModels', value),
  referenceIndex: value => ipcRenderer.invoke('muv:referenceIndex', value),
  chooseWorkspace: () => ipcRenderer.invoke('muv:chooseWorkspace'),
  listPlans: value => ipcRenderer.invoke('muv:listPlans', value),
  readPlan: value => ipcRenderer.invoke('muv:readPlan', value),
  savePlan: value => ipcRenderer.invoke('muv:savePlan', value),
  openPlan: value => ipcRenderer.invoke('muv:openPlan', value),
  run: value => ipcRenderer.invoke('muv:run', value),
  cancel: id => ipcRenderer.invoke('muv:cancel', id),
  saveData: value => ipcRenderer.invoke('muv:saveData', value),
  apply: value => ipcRenderer.invoke('muv:apply', value),
  undo: transactionId => ipcRenderer.invoke('muv:undo', transactionId === undefined ? {} : { transactionId }),
  undoableTransactions: () => ipcRenderer.invoke('muv:undoableTransactions'),
  onEvent: handler => {
    if (typeof handler !== 'function') throw new TypeError('Expected event handler');
    const listener = (_event: Electron.IpcRendererEvent, value: Event) => handler(value);
    ipcRenderer.on('muv:event', listener);
    return () => { ipcRenderer.removeListener('muv:event', listener); };
  },
};
contextBridge.exposeInMainWorld('muv', Object.freeze(api));
declare global { interface Window { muv: MuvAPI } }
