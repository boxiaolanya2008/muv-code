import { randomUUID } from 'node:crypto';
export type ShellMode = 'ask' | 'auto' | 'full';
export function validateShellMode(value: unknown): ShellMode {
  if (value !== 'ask' && value !== 'auto' && value !== 'full') throw new Error('Invalid Shell permission mode');
  return value;
}
export function autoApproveShell(mode: ShellMode, command: string): boolean {
  return mode === 'full' || (mode === 'auto' && command === 'git_status');
}
export type ShellRequest = { id: string; command: string; workspace: string };
export type ShellPermissionEvent = { type: 'request'; request: ShellRequest } | { type: 'closed'; id: string };
export class ShellPermissions {
  private pending = new Map<string, { sender: number; finish: (allow: boolean) => void }>();
  constructor(private notify: (sender: number, event: ShellPermissionEvent) => void, private timeout = 60_000) {}
  request(sender: number, command: string, workspace: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const id = randomUUID();
    return new Promise(resolve => {
      const finish = (allow: boolean) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        resolve(allow); this.notify(sender, { type: 'closed', id });
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort, this.timeout);
      this.pending.set(id, { sender, finish });
      signal.addEventListener('abort', abort, { once: true });
      try { this.notify(sender, { type: 'request', request: { id, command, workspace } }); } catch { finish(false); }
    });
  }
  respond(sender: number, id: unknown, allow: unknown): boolean {
    if (typeof id !== 'string' || typeof allow !== 'boolean') return false;
    const item = this.pending.get(id);
    if (!item || item.sender !== sender) return false;
    item.finish(allow); return true;
  }
  close(sender: number) { for (const item of [...this.pending.values()]) if (item.sender === sender) item.finish(false); }
}
