import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { ShellPermissions, autoApproveShell, validateShellMode, type ShellPermissionEvent } from './shell-permissions.js';
test('real Electron IPC preserves sender ownership and one-time approval', { timeout: 30000 }, async context => {
  let electron: string;
  try { electron = process.env.MUV_TEST_ELECTRON || (await import('electron')).default as unknown as string; }
  catch { context.skip('Electron runtime is not installed; real IPC verification unavailable'); return; }
  const directory = await mkdtemp(path.join(tmpdir(), 'muv-shell-ipc-'));
  try {
    const moduleUrl = pathToFileURL(path.resolve('dist-electron/shell-permissions.js')).href;
    const script = `const { app, BrowserWindow, ipcMain } = require('electron');
      app.whenReady().then(async () => {
        const { ShellPermissions } = await import(${JSON.stringify(moduleUrl)});
        const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
        const manager = new ShellPermissions((sender, event) => window.webContents.send('permission', event));
        let result;
        ipcMain.handle('start', () => { result = manager.request(window.webContents.id, 'whoami', 'test-workspace', new AbortController().signal); });
        ipcMain.handle('respond', (event, value) => manager.respond(event.sender.id, value.id, value.allow));
        ipcMain.handle('result', () => result);
        await window.loadURL('about:blank');
        const ok = await window.webContents.executeJavaScript(\`(async () => {
          const { ipcRenderer } = require('electron');
          const request = new Promise(resolve => ipcRenderer.once('permission', (_, e) => resolve(e.request)));
          await ipcRenderer.invoke('start'); const item = await request;
          if (!await ipcRenderer.invoke('respond', { id: item.id, allow: true })) return false;
          return await ipcRenderer.invoke('result') === true && await ipcRenderer.invoke('respond', { id: item.id, allow: true }) === false;
        })()\`);
        console.log(ok ? 'IPC_PASS' : 'IPC_FAIL'); app.exit(ok ? 0 : 1);
      }).catch(error => { console.error(error); app.exit(1); });`;
    const file = path.join(directory, 'ipc.cjs'); await writeFile(file, script);
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electron as unknown as string, [file], { env, windowsHide: true });
      let output = ''; const timer = setTimeout(() => child.kill(), 20000);
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
    });
    assert.equal(result.code, 0, result.output); assert.match(result.output, /IPC_PASS/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('permission modes validate input and only auto-approve the exact fixed diagnostic', () => {
  for (const mode of ['ask', 'auto', 'full'] as const) assert.equal(validateShellMode(mode), mode);
  for (const value of [undefined, null, '', 'FULL', {}, true]) assert.throws(() => validateShellMode(value));
  assert.equal(autoApproveShell('ask', 'git_status'), false);
  assert.equal(autoApproveShell('auto', 'git_status'), true);
  for (const command of ['git status', 'git_status && whoami', ' git_status', 'git_status\n', 'whoami']) assert.equal(autoApproveShell('auto', command), false);
  assert.equal(autoApproveShell('full', 'whoami'), true);
});
test('deny, sender validation, once only, abort, close and expiry', async () => {
  const events: ShellPermissionEvent[] = [];
  const manager = new ShellPermissions((_sender, event) => { events.push(event); }, 15);
  const start = (signal = new AbortController().signal) => {
    const result = manager.request(7, 'echo hello', 'workspace', signal);
    const event = events.at(-1)!;
    assert.equal(event.type, 'request');
    return { result, id: event.type === 'request' ? event.request.id : '' };
  };
  let item = start();
  assert.equal(manager.respond(8, item.id, true), false);
  assert.equal(manager.respond(7, item.id, false), true);
  assert.equal(await item.result, false);
  assert.equal(manager.respond(7, item.id, true), false);
  item = start(); manager.respond(7, item.id, true); assert.equal(await item.result, true);
  assert.equal(manager.respond(7, item.id, true), false);
  const controller = new AbortController(); item = start(controller.signal); controller.abort(); assert.equal(await item.result, false);
  item = start(); manager.close(7); assert.equal(await item.result, false);
  item = start(); assert.equal(await item.result, false); assert.equal(manager.respond(7, item.id, true), false);
  controller.abort(); assert.equal(await manager.request(7, 'x', 'w', controller.signal), false);
});
