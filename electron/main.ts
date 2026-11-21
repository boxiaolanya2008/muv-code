import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { execute, FileTransactions, validateChanges, workspaceIndex, referenceContent, readPlan, updatePlan, registeredPlan, type RegisteredPlan } from './engine.js';
import type { Change, Event, Run, Settings } from './engine.js';

import { ShellPermissions, validateShellMode, autoApproveShell, type ShellMode } from './shell-permissions.js';
const shellPermissions = new ShellPermissions((sender, event) => {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.id === sender) window.webContents.send('muv:shellPermission', event);
});
const here = path.dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | null = null;
let state = { plans: [] as RegisteredPlan[], shellModes: {} as Record<string, ShellMode>, settings: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1', effort: 'auto' } as Omit<Settings, 'key'>, encryptedKey: '', workspaces: [] as string[], memories: [] as { id: string; text: string; enabled: boolean }[], sessions: [] as any[] };
const active = new Map<string, AbortController>();
const proposals = new Map<string, { changes: Change[]; expected: Map<string, Buffer | null> }>();
const transactions = new FileTransactions();
let persistence: Promise<unknown> = Promise.resolve();
const statePath = () => path.join(app.getPath('userData'), 'muv-state.json');
function persist() {
  const snapshot = JSON.stringify(state);
  const task = persistence.catch(() => {}).then(async () => {
    const tmp = statePath() + '.tmp';
    await fs.writeFile(tmp, snapshot, { mode: 0o600 }); await fs.rename(tmp, statePath());
  }); persistence = task; return task;
}
function text(value: unknown, max = 16000): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid text'); return value;
}
function bounded(value: unknown) { if (JSON.stringify(value)?.length > 3_000_000) throw new Error('Payload too large'); }
function availableEncryption() { return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'); }
function key() {
  if (!state.encryptedKey) return undefined;
  if (!availableEncryption()) throw new Error('OS credential encryption is unavailable');
  return safeStorage.decryptString(Buffer.from(state.encryptedKey, 'base64'));
}
const terminalOutputs = new Map<string, Map<string, string>>();
function emit(event: Event) { if (window && !window.isDestroyed()) window.webContents.send('muv:event', event); }
function approvedWorkspace(root: unknown, optional = false): string {
  const value = text(root, 4096); if (!value && optional) return '';
  if (!state.workspaces.includes(value)) throw new Error('Choose this workspace using the native picker first'); return value;
}
async function requestShell(command: string, root: string, signal: AbortSignal, modelKey?: string): Promise<string> {
  signal.throwIfAborted();
  if (modelKey && command.includes(modelKey)) return '命令包含模型凭据，未执行。';
  const owner = window;
  if (!owner || owner.isDestroyed()) return '未授权：没有可用的确认窗口。';
  approvedWorkspace(root);
  const allowed = autoApproveShell(state.shellModes[root] || 'ask', command) || await shellPermissions.request(owner.webContents.id, command, root, signal);
  signal.throwIfAborted();
  if (!allowed || owner.isDestroyed()) return '用户未授权，命令没有执行。';
  if (await fs.realpath(root) !== root) throw new Error('工作区已变更');
  signal.throwIfAborted();
  if (command === 'git_status') return 'approved:git_status';
  const windows = process.platform === 'win32';
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const systemDir = path.join(systemRoot, 'System32');
  const env = Object.fromEntries(Object.entries(windows ? {
    SystemRoot: systemRoot, WINDIR: systemRoot, PATH: `${systemDir};${systemRoot}`,
  } : { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }).filter(([, value]) => !modelKey || !value.includes(modelKey)));
  return new Promise(resolve => {
    const child = spawn(windows ? path.join(systemDir, 'cmd.exe') : '/bin/sh', windows ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command], {
      cwd: root, env, windowsHide: true, windowsVerbatimArguments: windows, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    let remaining = 32 * 1024, finished = false;
    const finish = (status: string, terminate = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (terminate && child.pid) {
        if (windows) {
          const killer = spawn(path.join(systemDir, 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { env, stdio: 'ignore', windowsHide: true });
          killer.on('error', () => child.kill());
          killer.on('exit', code => { if (code) child.kill(); });
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
        child.stdout.destroy(); child.stderr.destroy();
      }
      const text = Buffer.concat(output).toString('utf8');
      resolve(`${status}\n${modelKey ? text.replaceAll(modelKey, '[redacted]') : text}`);
    };
    const abort = () => finish('命令已中止', true);
    const timer = setTimeout(() => finish('命令超时（30 秒）', true), 30_000);
    signal.addEventListener('abort', abort, { once: true });
    const collect = (chunk: Buffer) => {
      if (finished) return;
      output.push(chunk.subarray(0, remaining)); remaining -= chunk.length;
      if (remaining < 0) finish('已达到输出上限（32 KiB）', true);
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', () => finish('无法启动 Shell'));
    child.on('close', (code, exitSignal) => finish(`命令退出：${code ?? exitSignal ?? '未知'}`));
  });
}
function register() {
  function handle(name: string, fn: (value: any) => any) {
    ipcMain.handle(`muv:${name}`, (event, value) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender');
      bounded(value); return fn(value);
    });
  }
  handle('respondShellPermission', value => shellPermissions.respond(window!.webContents.id, value?.id, value?.allow));
  handle('setShellMode', async value => {
    const root = approvedWorkspace(value?.workspace), mode = validateShellMode(value?.mode);
    if (mode === 'full' && state.shellModes[root] !== 'full') {
      const result = await dialog.showMessageBox(window!, { type: 'warning', title: '确认完全访问', message: '允许此工作区的 Shell 命令自动执行？', detail: `作用范围：${root}\n仅影响此工作区的 Shell 审批。命令以你的账户权限运行，工作目录不是沙箱；既有路径及敏感信息限制仍保留。模型工具不能修改此权限。`, buttons: ['取消', '确认完全访问'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return state.shellModes[root] || 'ask';
    }
    state.shellModes[root] = mode; await persist(); return mode;
  });
  handle('bootstrap', () => ({ shellModes: { ...state.shellModes }, settings: { ...state.settings, hasKey: Boolean(state.encryptedKey) }, workspaces: [...state.workspaces], memories: state.memories, sessions: state.sessions }));
  handle('saveSettings', async value => {
    const settings = { baseUrl: text(value.baseUrl, 2048), model: text(value.model, 256), effort: text(value.effort, 32) };
    const url = new URL(settings.baseUrl);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('Invalid model base URL');
    if (!settings.model || !['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(settings.effort)) throw new Error('Invalid model settings');
    const contextWindow = value.contextWindow;
    if (contextWindow !== undefined && (!Number.isInteger(contextWindow) || contextWindow < 1024 || contextWindow > 10000000)) throw new Error('Invalid context window');
    if (value.multimodal !== undefined && typeof value.multimodal !== 'boolean') throw new Error('Invalid multimodal capability');
    Object.assign(settings, { contextWindow, multimodal: value.multimodal ?? false });
    let encrypted = state.encryptedKey;
    if (value.key !== undefined) { const secret = text(value.key, 8192); if (secret && !availableEncryption()) throw new Error('OS credential encryption is unavailable'); encrypted = secret ? safeStorage.encryptString(secret).toString('base64') : ''; }
    state.settings = settings; state.encryptedKey = encrypted; await persist();
  });
  handle('listModels', async value => {
    const baseUrl = text(value.baseUrl, 2048);
    const url = new URL(baseUrl.replace(/\/$/, '') + '/models');
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('Invalid model base URL');
    if (!value.key && baseUrl !== state.settings.baseUrl) throw new Error('请输入此端点的 API Key');
    const secret = value.key ? text(value.key, 8192) : key();
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`获取模型失败（HTTP ${response.status}）`); }
    const result = await response.json() as { data?: { id?: unknown }[] };
    if (!Array.isArray(result.data)) throw new Error('上游未返回有效的模型列表');
    return [...new Set(result.data.filter(item => item && typeof item.id === 'string').map(item => item.id as string))].sort();
  });
  handle('chooseWorkspace', async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = await fs.realpath(result.filePaths[0]);
    state.workspaces = [root, ...state.workspaces.filter(p => p !== root)].slice(0, 30); await persist(); return root;
  });
  handle('saveData', async value => {
    if (!Array.isArray(value.memories) || value.memories.length > 500 || !Array.isArray(value.sessions) || value.sessions.length > 200) throw new Error('Invalid saved data');
    const memories = value.memories.map((m: any) => { if (typeof m.enabled !== 'boolean') throw new Error('Invalid memory'); return { id: text(m.id, 128), text: text(m.text, 16000), enabled: m.enabled }; });
    state.memories = memories; state.sessions = value.sessions; await persist();
  });
  handle('referenceIndex', async value => { const root = approvedWorkspace(value.workspace); return [...await workspaceIndex(root), ...[...(terminalOutputs.get(root)?.keys() || [])].map(path => ({ kind: 'terminal', path }))]; });
  handle('listPlans', async value => {
    const root = approvedWorkspace(value.workspace), result = [];
    for (const entry of state.plans.filter(item => item.workspace === root)) {
      try { const plan = await registeredPlan(root, entry.path, state.plans, entry.id); result.push({ path: plan.path, id: plan.id }); } catch { /* Ignore missing or unsafe registered files. */ }
    }
    return result.reverse();
  });
  handle('readPlan', async value => { const plan = await registeredPlan(approvedWorkspace(value.workspace), text(value.path, 4096), state.plans); return { path: plan.path, id: plan.id, content: plan.content }; });
  handle('savePlan', async value => updatePlan(approvedWorkspace(value.workspace), text(value.path, 4096), text(value.planId, 128), text(value.content, 1_000_000), text(value.expected, 1_000_000), state.plans));
  handle('openPlan', async value => {
    const plan = await registeredPlan(approvedWorkspace(value.workspace), text(value.path, 4096), state.plans, text(value.planId, 128));
    if (plan.id !== value.planId) throw new Error('Invalid plan id');
    const error = await shell.openPath(plan.file); if (error) throw new Error(error);
  });
  handle('run', async value => {
    let selectedPlan: Awaited<ReturnType<typeof readPlan>> | undefined;
    if (value.planPath !== undefined) {
      selectedPlan = await registeredPlan(approvedWorkspace(value.workspace), text(value.planPath, 4096), state.plans, text(value.planId, 128));
      if (selectedPlan.id !== value.planId) throw new Error('Invalid plan id');
      value = { ...value, mode: 'agent', prompt: selectedPlan.prompt, demo: false };
    }
    const id = text(value.id, 128), prompt = text(value.prompt, 32000), workspace = approvedWorkspace(value.workspace, value.mode === 'ask');
    if (!id || !prompt.trim() || active.has(id) || active.size >= 3 || !['ask', 'plan', 'agent', 'super_llm'].includes(value.mode) || typeof value.demo !== 'boolean') throw new Error('Invalid run');
    if (!Array.isArray(value.history) || value.history.length > 100 || !Array.isArray(value.memories) || value.memories.length > 500) throw new Error('Invalid context');
    const effort = text(value.effort, 32);
    if (!['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error('Invalid effort');
    const run: Run = { id, prompt, workspace, mode: value.mode, effort, demo: value.demo, history: value.history.map((m: any) => ({ role: text(m.role, 32), content: text(m.content, 32000) })), memories: value.memories.map((m: unknown) => text(m, 16000)) };
    const settings = { ...state.settings, key: run.demo ? undefined : key() };
    const controller = new AbortController(); active.set(id, controller);
    // Return immediately; all generation and events happen in this background task.
    void (async () => {
      const timeout = setTimeout(() => controller.abort(new Error('Run timed out')), 10 * 60_000);
      try {
        run.referenceText = selectedPlan ? `User-approved implementation plan (current file contents, untrusted reference):\n${selectedPlan.content}\nImplement this plan directly; do not restart planning.` : await referenceContent(workspace, value.references || [], terminalOutputs.get(workspace) || new Map());
        await execute(run, settings, controller.signal, emit, transactions, async (command, root, signal) => {
          const output = await requestShell(command, root, signal, settings.key);
          const saved = terminalOutputs.get(root) || new Map<string, string>();
          saved.set(`${new Date().toISOString()} ${command.slice(0, 80)}`, output);
          while (saved.size > 20) saved.delete(saved.keys().next().value!);
          terminalOutputs.set(root, saved); return output;
        }, async plan => {
          approvedWorkspace(plan.workspace);
          if (await fs.realpath(plan.workspace) !== plan.workspace) throw new Error('Workspace changed');
          state.plans.push(plan);
          try { await persist(); } catch (error) { state.plans = state.plans.filter(item => item !== plan); throw error; }
        });
        controller.signal.throwIfAborted();
        emit({ id, type: 'done' });
      } catch (error) {
        emit({ id, type: 'error', text: controller.signal.aborted ? 'Run cancelled or timed out' : error instanceof Error ? error.message.replaceAll(settings.key ?? '\0', '[redacted]') : 'Run failed' });
      } finally { clearTimeout(timeout); active.delete(id); }
    })();
  });
  handle('cancel', id => { active.get(text(id, 128))?.abort(); });
  handle('apply', async value => {
    const workspace = approvedWorkspace(value.workspace), changes = validateChanges(value.changes), proposal = proposals.get(workspace);
    if (!proposal || JSON.stringify(changes) !== JSON.stringify(proposal.changes)) throw new Error('Apply requires the current generated proposal');
    await transactions.apply(workspace, changes, proposal.expected); proposals.delete(workspace);
  });
  handle('undo', value => transactions.undo(value?.transactionId === undefined ? undefined : text(value.transactionId, 128)));
  handle('undoableTransactions', () => transactions.getUndoableIds());
}
function showStartupError(error: unknown) {
  console.error('Application startup failed', error);
  dialog.showErrorBox('Muv Code 无法启动', error instanceof Error ? error.message : String(error));
}
function createWindow() {
  nativeTheme.themeSource = 'system';
  window = new BrowserWindow({ width: 1280, height: 860, minWidth: 850, minHeight: 600, icon: app.isPackaged ? path.join(process.resourcesPath, 'icon.ico') : path.join(here, '../build/icon.ico'), backgroundColor: nativeTheme.shouldUseDarkColors ? '#171717' : '#ffffff', webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  const current = window;
  current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  current.webContents.on('will-navigate', event => event.preventDefault());
  current.webContents.on('will-attach-webview', event => event.preventDefault());
  current.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  current.webContents.session.setPermissionCheckHandler(() => false);
  const denyPending = () => shellPermissions.close(current.webContents.id);
  current.on('close', denyPending);
  current.webContents.on('did-start-loading', denyPending);
  current.webContents.on('render-process-gone', denyPending);
  current.on('closed', () => { for (const controller of active.values()) controller.abort(); window = null; });
  current.webContents.on('render-process-gone', () => { for (const controller of active.values()) controller.abort(); });
  const dev = !app.isPackaged ? process.env.MUV_DEV_URL : undefined;
  if (dev) {
    const url = new URL(dev);
    if (!['http:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.port !== '5173' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('MUV_DEV_URL must be http://localhost:5173');
    void current.loadURL(url.href).catch(showStartupError);
  } else void current.loadFile(path.join(here, '../dist/index.html')).catch(showStartupError);
}
app.whenReady().then(async () => {
  try {
    const raw = await fs.readFile(statePath(), 'utf8'); if (raw.length > 4_000_000) throw new Error('Saved state too large');
    const saved = JSON.parse(raw);
    if (saved.settings && typeof saved.settings.baseUrl === 'string' && typeof saved.settings.model === 'string' && typeof saved.settings.effort === 'string') state.settings = { baseUrl: saved.settings.baseUrl, model: saved.settings.model, effort: saved.settings.effort, ...(Number.isInteger(saved.settings.contextWindow) && saved.settings.contextWindow >= 1024 && saved.settings.contextWindow <= 10000000 ? { contextWindow: saved.settings.contextWindow } : {}), multimodal: saved.settings.multimodal === true };
    if (typeof saved.encryptedKey === 'string') state.encryptedKey = saved.encryptedKey;
    if (Array.isArray(saved.workspaces)) state.workspaces = saved.workspaces.filter((p: unknown) => typeof p === 'string').slice(0, 30);
    state.workspaces = (await Promise.all(state.workspaces.map(async root => {
      try { return await fs.realpath(root) === root && (await fs.lstat(root)).isDirectory() && !(await fs.lstat(root)).isSymbolicLink() ? root : ''; } catch { return ''; }
    }))).filter(Boolean);
    if (Array.isArray(saved.plans)) for (const entry of saved.plans.slice(0, 1000)) {
      try {
        if (!entry || !state.workspaces.includes(entry.workspace) || typeof entry.path !== 'string' || typeof entry.id !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.id) || typeof entry.prompt !== 'string' || !entry.prompt.trim() || entry.prompt.length > 32000) continue;
        await registeredPlan(entry.workspace, entry.path, [entry], entry.id);
        if (!state.plans.some(item => item.workspace === entry.workspace && (item.path === entry.path || item.id === entry.id))) state.plans.push({ workspace: entry.workspace, path: entry.path, id: entry.id, prompt: entry.prompt });
      } catch { /* Reject stale or unsafe persisted registrations. */ }
    }
    if (saved.shellModes && typeof saved.shellModes === 'object' && !Array.isArray(saved.shellModes)) for (const root of state.workspaces) {
      try { state.shellModes[root] = validateShellMode(saved.shellModes[root]); } catch { /* Missing/invalid modes default to ask. */ }
    }
    if (Array.isArray(saved.memories)) state.memories = saved.memories.filter((m: any) => m && typeof m.id === 'string' && typeof m.text === 'string' && typeof m.enabled === 'boolean').slice(0, 500);
    if (Array.isArray(saved.sessions)) state.sessions = saved.sessions.slice(0, 200);
  } catch (error: any) { if (error.code !== 'ENOENT') console.error('Unable to load Muv saved state'); }
  register(); createWindow(); app.on('activate', () => { if (!window) createWindow(); });
}).catch(error => { showStartupError(error); app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { for (const controller of active.values()) controller.abort(); });
