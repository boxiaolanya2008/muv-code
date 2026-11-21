/// <reference types="vite/client" />
export {};
declare global {
  type MuvMode = 'ask' | 'plan' | 'agent' | 'super_llm';
  type MuvEffort = 'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  interface MuvMemory { id: string; text: string; enabled: boolean }
  interface MuvSettings { baseUrl: string; model: string; hasKey: boolean; effort: MuvEffort; contextWindow?: number; multimodal?: boolean }
  interface MuvReference { kind: 'file' | 'folder' | 'terminal'; path: string }
  interface MuvEvent { todos?: import('../electron/engine').Todo[]; usage?: import('../electron/engine').Usage; displayContent?: string; agentId?: string; estimate?: { system: number; reference: number; history: number; prompt: number; tools: number; total: number; limit?: number }; id: string; type: 'usage' | 'context' | 'stage' | 'delta' | 'summary' | 'changes' | 'turn-start' | 'block-start' | 'block-delta' | 'block-update' | 'done' | 'error'; text?: string; changes?: unknown; turnId?: string; blockId?: string; blockType?: 'text' | 'reasoning' | 'stage' | 'tool'; change?: { transactionId: string; path: string; before: string | null; after: string; truncated?: boolean } }
  type ShellRequest = import('../electron/shell-permissions').ShellRequest;
  type ShellPermissionEvent = import('../electron/shell-permissions').ShellPermissionEvent;
  interface MuvAPI {
    setShellMode(input: { workspace: string; mode: import('../electron/shell-permissions').ShellMode }): Promise<import('../electron/shell-permissions').ShellMode>;
    respondShellPermission(input: { id: string; allow: boolean }): Promise<boolean>;
    onShellPermission(handler: (event: ShellPermissionEvent) => void): () => void;
    bootstrap(): Promise<{shellModes: Record<string, import('../electron/shell-permissions').ShellMode>; settings: MuvSettings; workspaces: string[]; memories: MuvMemory[]; sessions: any[]}>;
    saveSettings(settings: {baseUrl: string; model: string; key?: string; effort: MuvEffort; contextWindow?: number; multimodal?: boolean}): Promise<unknown>;
    listModels(input: {baseUrl: string; key?: string}): Promise<string[]>;
    referenceIndex(input: {workspace: string}): Promise<MuvReference[]>;
    chooseWorkspace(): Promise<string | null>;
    listPlans(input: { workspace: string }): Promise<{ path: string; id: string }[]>;
    readPlan(input: { workspace: string; path: string }): Promise<{ path: string; id: string; content: string }>;
    savePlan(input: { workspace: string; path: string; planId: string; content: string; expected: string }): Promise<{ path: string; id: string; content: string }>;
    openPlan(input: { workspace: string; path: string; planId: string }): Promise<void>;
    run(input: {planPath?: string; planId?: string; id: string; prompt: string; workspace: string; mode: MuvMode; effort: MuvEffort; history: {role: string; content: string}[]; memories: string[]; demo: boolean; references?: MuvReference[]}): Promise<unknown>;
    cancel(id: string): Promise<unknown>;
    onEvent(handler: (event: MuvEvent) => void): () => void;
    saveData(data: {memories: MuvMemory[]; sessions: any[]}): Promise<unknown>;
    apply(input: {workspace: string; changes: unknown}): Promise<unknown>;
    undo(transactionId?: string): Promise<unknown>;
    undoableTransactions(): Promise<string[]>;
  }
  interface Window { muv?: MuvAPI }
}
