import { useEffect, useState } from 'react';
// Kept as an inline message-region component; no modal or focus capture.
export function ShellPermissionModal({ api }: { api: MuvAPI }) {
  const [requests, setRequests] = useState<ShellRequest[]>([]);
  const [error, setError] = useState('');
  useEffect(() => api.onShellPermission(event => {
    if (event.type === 'request') setRequests(all => all.some(item => item.id === event.request.id) ? all : [...all, event.request]);
    else setRequests(all => all.filter(item => item.id !== event.id));
  }), [api]);
  return <div className="shell-permissions" aria-live="polite">{requests.map(request => <section className="shell-permission-card" key={request.id} aria-labelledby={`shell-${request.id}`}>
    <strong id={`shell-${request.id}`}>Shell 权限请求</strong>
    <p>命令以你的账户权限运行，工作目录不是沙箱。60 秒未确认自动拒绝；可继续输入或停止任务。</p>
    <strong>工作目录</strong><pre>{request.workspace}</pre>
    <strong>完整命令</strong><pre tabIndex={0} aria-label="待审批完整命令">{request.command}</pre>
    <div>{[false, true].map(allow => <button key={String(allow)} onClick={() => { void api.respondShellPermission({ id: request.id, allow }).then(accepted => { if (accepted) setRequests(all => all.filter(item => item.id !== request.id)); }).catch(reason => setError(String(reason))); }}>{allow ? '允许一次' : '拒绝'}</button>)}</div>
  </section>)}{error && <p role="alert">{error}</p>}</div>;
}
