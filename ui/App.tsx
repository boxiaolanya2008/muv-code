import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import Markdown from 'react-markdown';
import appIcon from './icon.svg';
import { ShellPermissionModal } from './ShellPermissionModal';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import hljs from 'highlight.js/lib/common';

function HighlightedCode({ text, path = '' }: { text: string; path?: string }) {
  const extension = path.split('.').pop()?.toLowerCase() || '';
  const language = ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', sh: 'bash', yml: 'yaml' } as Record<string, string>)[extension] || extension;
  // highlight.js escapes source text; only its generated markup reaches this sink.
  const html = language && hljs.getLanguage(language) ? hljs.highlight(text, { language, ignoreIllegals: true }).value : hljs.highlightAuto(text).value;
  return <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />;
}

function ToolOutput({ text, path }: { text: string; path?: string }) {
  return <pre className="tool-output-code" tabIndex={0} aria-label="工具完整输出"><HighlightedCode text={text} path={path} /></pre>;
}

const RichText = memo(function RichText({ children }: { children: string }) {
  return <Markdown skipHtml remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{children}</Markdown>;
});

function Reasoning({ text, pending = false }: { text: string; pending?: boolean }) {
  return <details className="reasoning-block" open><summary><ChevronRight size={13} /><strong>{pending ? '正在思考' : '模型返回的思考内容'}</strong></summary><div className="reasoning-body" tabIndex={0}><RichText>{text}</RichText></div></details>;
}
import { ArrowUp, Check, ChevronDown, ChevronRight, Circle, Folder, FolderOpen, MessageSquare, PanelLeft, Plus, Search, Settings, Sparkles, Square, Trash2, X, LoaderCircle } from 'lucide-react';

type MessageBlock = { displayContent?: string; id: string; turnId: string; type: 'text' | 'reasoning' | 'stage' | 'tool'; text: string; label?: string; change?: NonNullable<MuvEvent['change']>; undone?: boolean; toolStatus?: 'running' | 'success' | 'failure' };
type Message = { todos?: import('../electron/engine').Todo[]; role: 'user' | 'assistant'; content: string; summary?: string; changes?: unknown; applied?: boolean; stages?: string[]; blocks?: MessageBlock[]; activeTurnId?: string };
type Session = { id: string; title: string; workspace: string; messages: Message[]; mode: MuvMode };
const modeNames = { ask: '问答', plan: '计划', agent: 'Agent', super_llm: 'Super LLM' };

function usePopover(open: boolean) {
  const [present, setPresent] = useState(open);
  useEffect(() => { if (open) { setPresent(true); return; } const timer = setTimeout(() => setPresent(false), 150); return () => clearTimeout(timer); }, [open]);
  return present || open;
}
function ModeIcon({ mode }: { mode: MuvMode }) {
  const paths = {
    ask: 'M20 14a3 3 0 0 1-3 3H9l-5 4V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3zM8 9h8m-8 4h5',
    plan: 'M8 4H5v17h14V4h-3M8 3h8v4H8zM8 12h2m3 0h3m-8 4h2m3 0h3',
    agent: 'M13 2 4 14h7l-1 8 10-12h-7z',
    super_llm: 'M10 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM18 13l1 3 3 1-3 1-1 3-1-3-3-1 3-1z',
  };
  return <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[mode]} /></svg>;
}
const effortNames = { auto: 'auto', none: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' };
const uid = () => crypto.randomUUID();
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || '未选择工作区';

// Deliberately separate browser preview. It never impersonates a connected backend.
function createPreviewAdapter(): MuvAPI {
  const listeners = new Set<(event: MuvEvent) => void>();
  const emit = (event: MuvEvent) => listeners.forEach(listener => listener(event));
  const unavailable = async (): Promise<never> => { throw new Error('演示预览不支持本地文件操作，请在桌面应用中使用。'); };
  let data: { memories: MuvMemory[]; sessions: Session[] } = { memories: [], sessions: [] };
  let settings: MuvSettings = { baseUrl: '', model: '预览模型', hasKey: false, effort: 'medium' };
  return {
    listPlans: async () => [], readPlan: unavailable, savePlan: unavailable, openPlan: unavailable,
    setShellMode: unavailable,
    respondShellPermission: async () => false,
    onShellPermission: () => () => {},
    bootstrap: async () => ({ shellModes: {}, settings, workspaces: [], ...data }),
    saveSettings: async input => { settings = { baseUrl: input.baseUrl, model: input.model, effort: input.effort, contextWindow: input.contextWindow, multimodal: input.multimodal, hasKey: false }; },
    listModels: unavailable,
    referenceIndex: async () => [],
    chooseWorkspace: unavailable, apply: unavailable, undo: unavailable,
    saveData: async input => { data = input; },
    onEvent: handler => { listeners.add(handler); return () => { listeners.delete(handler); }; },
    cancel: async () => {},
    undoableTransactions: async () => [],
    run: async input => {
      if (!input.demo) throw new Error('浏览器预览仅支持演示。');
      const stages = input.mode === 'super_llm' ? ['understanding', 'spec', 'plan', 'review:1', '等待用户构建'] : input.mode === 'agent' ? ['build'] : [input.mode === 'plan' ? 'plan' : 'understanding'];
      for (const stage of stages) emit({ id: input.id, type: 'stage', text: stage });
      const turnId = uid();
      emit({ id: input.id, type: 'turn-start', turnId });
      for (const [blockType, text] of [
        ['reasoning', '先确认这是本地浏览器预览。这里不会连接模型、执行命令或修改文件。\n\n桌面版可连接真实模型和工作区。'],
        ['text', '这是浏览器演示。行内代码：`const title`。\n\n```js\nconst title = "Muv Code";\n```'],
      ] as const) {
        const blockId = uid();
        emit({ id: input.id, type: 'block-start', turnId, blockId, blockType });
        emit({ id: input.id, type: 'block-delta', turnId, blockId, blockType, text });
      }
      emit({ id: input.id, type: 'done' });
    },
  };
}
const preview = !window.muv;
const api = window.muv ?? createPreviewAdapter();
const stageName = (value: string) => value.startsWith('review:') ? `自审第 ${value.split(':')[1]} 轮` : ({ understanding: '理解目标', spec: '明确规格', plan: '制定计划', build: '制作' }[value] || value);
function fileDiff(before: string | null, after: string) {
  const left = before ? before.split('\n') : [], right = after ? after.split('\n') : [];
  if (left.length * right.length > 160_000 || left.length + right.length > 2_000) return [...left.slice(0, 200).map(text => ({ kind: 'remove' as const, text })), ...right.slice(0, 200).map(text => ({ kind: 'add' as const, text })), { kind: 'context' as const, text: '…diff 已截断…' }];
  const rows = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) rows[i][j] = left[i] === right[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  const result: { kind: 'add' | 'remove' | 'context'; text: string }[] = [];
  let i = 0, j = 0;
  while (i < left.length && j < right.length && result.length < 500) {
    if (left[i] === right[j]) { result.push({ kind: 'context', text: left[i++] }); j++; }
    else if (rows[i + 1][j] >= rows[i][j + 1]) result.push({ kind: 'remove', text: left[i++] });
    else result.push({ kind: 'add', text: right[j++] });
  }
  while (i < left.length && result.length < 500) result.push({ kind: 'remove', text: left[i++] });
  while (j < right.length && result.length < 500) result.push({ kind: 'add', text: right[j++] });
  if (i < left.length || j < right.length) result.push({ kind: 'context', text: '…diff 已截断…' });
  return result;
}
function FileDiffCard({ change, undone, canUndo, busy, onUndo }: { change: NonNullable<MuvEvent['change']>; undone?: boolean; canUndo: boolean; busy: boolean; onUndo: () => void }) {
  const rows = fileDiff(change.before, change.after);
  const added = rows.filter(row => row.kind === 'add').length, removed = rows.filter(row => row.kind === 'remove').length;
  let oldLine = 0, newLine = 0;
  return <section className="file-change"><header><span className="hover-anchor" tabIndex={0}><strong>{change.path}</strong><span className="hover-panel file-hover" role="tooltip"><strong>变更预览</strong>{rows.filter(row => row.kind !== 'context').slice(0, 5).map((row, index) => <code className={`diff-${row.kind}`} key={index}>{row.kind === 'add' ? '+' : '−'} {row.text.slice(0, 180)}</code>)}</span></span><span><i>+{added}</i> <b>−{removed}</b></span></header><pre className="diff-editor" tabIndex={0} aria-label={`${change.path}差异预览`}>{rows.map((row, index) => {
    const oldNumber = row.kind === 'add' ? '' : ++oldLine;
    const newNumber = row.kind === 'remove' ? '' : ++newLine;
    return <span className={`diff-line diff-${row.kind}`} key={`${index}-${row.kind}`}><span className="diff-number" aria-hidden="true">{row.kind === 'remove' ? oldNumber : newNumber}</span><span className="diff-sign" aria-hidden="true">{row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '}</span><HighlightedCode text={row.text || ' '} path={change.path} /></span>;
  })}</pre>{change.truncated && <div className="diff-notice">文件较大，差异预览已截断；撤销仍会还原完整文件。</div>}<footer>{undone ? <span className="change-undone">已撤销</span> : <button className="text-button" disabled={busy || !canUndo} title={!canUndo ? '仅能撤销最近一次文件写入' : undefined} onClick={onUndo}>撤销此变更</button>}</footer></section>;
}
const toolFailed = (text: string) => /^\s*(?:工具失败\s*[:：]|Error\s*:|执行失败\s*[:：])/i.test(text) || /(?:exit code|退出码)\s*[:：=]?\s*[1-9]\d*/i.test(text);
const toolNames: Record<string, string> = { read_file: '读取文件', edit_file: '编辑文件', run_command: '执行命令', write_file: '写入文件', list_files: '列出文件', search_files: '搜索文件', git_status: '查看 Git 状态', shell: '执行命令', run_shell: '执行命令' };
function toolState(block: MessageBlock) {
  if (toolFailed(block.text)) return 'failure';
  return block.toolStatus || (block.text || block.change ? 'success' : 'running');
}
const OrderedBlocks = memo(function OrderedBlocks({ blocks, busy, undoableTransactions, onUndo }: { blocks: MessageBlock[]; busy: boolean; undoableTransactions: string[]; onUndo: (transactionId: string) => void }) {
  const groups: MessageBlock[][] = [];
  for (const block of blocks) {
    const previous = groups.at(-1);
    if (block.type === 'tool' && previous?.[0].type === 'tool' && previous[0].turnId === block.turnId) previous.push(block);
    else groups.push([block]);
  }
  return <div className="ordered-blocks">{groups.map(group => {
    const block = group[0];
    if (block.type === 'tool') {
      const failures = group.filter(item => toolState(item) === 'failure').length;
      const running = group.filter(item => toolState(item) === 'running').length;
      return <details className="tool-log" key={block.id} open><summary aria-label={`工具执行汇总：${group.length} 次，${failures} 次失败，${running} 次运行中`}><ChevronRight size={13} aria-hidden="true" /><span>执行工具 {group.length} 次，其中 {failures} 次失败</span>{running > 0 && <span className="tool-log-pending">{running} 次运行中</span>}</summary><div className="tool-log-rows">{group.map(item => {
        const status = toolState(item);
        const statusText = { success: '成功', failure: '失败', running: '运行中' }[status];
        const name = toolNames[item.label || ''] || item.label || '工作区工具';
        const excerpt = item.change?.path || item.text.split('\n').find(line => line.trim())?.replace(/ \([a-f0-9]{64}\)$/, '') || '等待工具结果…';
        return <details className={`tool-log-row ${status}`} key={item.id}><summary aria-label={`${statusText}：${name}，${excerpt}`}><span className="tool-state" title={statusText}>{status === 'running' ? <LoaderCircle size={13} aria-hidden="true" /> : status === 'failure' ? <X size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}</span><span className="tool-status-text">{statusText}</span><strong>{name}</strong><span className="tool-excerpt" title={excerpt}>{excerpt}</span><ChevronRight className="tool-row-chevron" size={12} aria-hidden="true" /></summary><div className="tool-log-body">{item.change && <FileDiffCard change={item.change} undone={item.undone} busy={busy} canUndo={undoableTransactions.at(-1) === item.change.transactionId} onUndo={() => onUndo(item.change!.transactionId)} />}{(!item.change || item.text) && <ToolOutput text={(item.displayContent ?? item.text) || (status === 'running' ? '执行中，等待工具结果…' : '工具未返回输出。')} path={item.change?.path} />}</div></details>;
      })}</div></details>;
    }
    return <div className={`event-block ${block.type}`} key={block.id}>{block.label?.startsWith('[agent-') && <small className="muted">{block.label}</small>}{block.type === 'stage' ? <div className="event-stage"><span className="status-dot" />{stageName(block.text)}</div> : block.type === 'reasoning' ? <Reasoning text={block.text} pending={busy && block.turnId === blocks.at(-1)?.turnId && !blocks.some(item => item.turnId === block.turnId && (item.type === 'text' || item.type === 'tool'))} /> : <div className="event-text">{block.text ? <RichText>{block.text}</RichText> : busy ? <span className="thinking">正在生成<span>···</span></span> : null}</div>}</div>;
  })}</div>;
});

// Children capture only conversation state; typing is deliberately excluded from this boundary.
const MessageHistory = memo(function MessageHistory({ children }: { children: React.ReactNode; messages: Message[]; busy: boolean; operation: boolean; session?: Session; undoable: string[] }) {
  if ((import.meta as ImportMeta & { env: { DEV: boolean } }).env.DEV) {
    const metrics = window as Window & { __muvHistoryRenders?: number };
    metrics.__muvHistoryRenders = (metrics.__muvHistoryRenders || 0) + 1;
  }
  return <>{children}</>;
}, (a, b) => a.messages === b.messages && a.busy === b.busy && a.operation === b.operation && a.session === b.session && a.undoable === b.undoable);

function SidebarSeparator({ side, width, min, max, onResize }: {
  side: 'left' | 'right'; width: number; min: number; max: number;
  onResize: (width: number) => void;
}) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const direction = side === 'left' ? 1 : -1;
  const resize = (value: number) => onResize(Math.max(min, Math.min(max, value)));
  const finish = (target: HTMLDivElement, id: number, cancel: boolean) => {
    const start = drag.current;
    if (!start || start.id !== id) return;
    drag.current = null;
    setDragging(false);
    if (cancel) resize(start.width);
    if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start?.id === event.pointerId) resize(start.width + direction * (event.clientX - start.x));
  };
  return <div
    className="sidebar-separator"
    data-dragging={dragging}
    role="separator"
    tabIndex={0}
    aria-orientation="vertical"
    aria-label={side === 'left' ? '调整最近任务栏宽度' : '调整任务活动栏宽度'}
    aria-controls={side === 'left' ? 'task-sidebar' : 'task-activity'}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={width}
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary || drag.current) return;
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, width };
      setDragging(true);
      event.preventDefault();
    }}
    onPointerMove={move}
    onPointerUp={event => { move(event); finish(event.currentTarget, event.pointerId, false); }}
    onPointerCancel={event => finish(event.currentTarget, event.pointerId, true)}
    onLostPointerCapture={event => finish(event.currentTarget, event.pointerId, true)}
    onKeyDown={event => {
      if (event.key === 'Escape' && drag.current) {
        event.preventDefault();
        finish(event.currentTarget, drag.current.id, true);
      } else if (!drag.current && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        resize(width + direction * (event.key === 'ArrowLeft' ? -16 : 16));
      }
    }}
  />;
}

export default function App() {
  const [settings, setSettings] = useState<MuvSettings>({ baseUrl: '', model: '', hasKey: false, effort: 'medium' });
  const [sessions, setSessions] = useState<Session[]>([]);
  const [memories, setMemories] = useState<MuvMemory[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState('');
  const [plans, setPlans] = useState<{ path: string; id: string }[]>([]);
  const [plan, setPlan] = useState<{ path: string; id: string; content: string; workspace: string }>();
  const [current, setCurrent] = useState('');
  const [mode, setMode] = useState<MuvMode>('ask');
  const [prompt, setPrompt] = useState('');
  const [references, setReferences] = useState<MuvReference[]>([]);
  const [referenceIndex, setReferenceIndex] = useState<MuvReference[]>([]);
  const [mention, setMention] = useState(false);
  const [referenceKind, setReferenceKind] = useState<MuvReference['kind']>('file');
  const [referenceRow, setReferenceRow] = useState(0);
  const [shellModes, setShellModes] = useState<Record<string, import('../electron/shell-permissions').ShellMode>>({});
  const [permissionSaving, setPermissionSaving] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  useEffect(() => { setReferences([]); setReferenceIndex([]); }, [workspace]);
  useEffect(() => { if (workspace) void api.referenceIndex({ workspace }).then(setReferenceIndex).catch(reason => setError(String(reason))); }, [workspace, mention]);
  const referenceQuery = prompt.match(/@([^@\n]*)$/)?.[1]?.toLowerCase() || '';
  const candidates = referenceIndex.filter(item => item.kind === referenceKind && item.path.toLowerCase().includes(referenceQuery));
  const selectReference = (item: MuvReference) => { setReferences(all => all.some(ref => ref.kind === item.kind && ref.path === item.path) ? all : [...all, item].slice(0, 12)); setPrompt(value => value.replace(/@[^@\n]*$/, '')); setMention(false); textRef.current?.focus(); };
  const [active, setActive] = useState<{ id: string; session: string } | null>(null);
  const activeRef = useRef(active);
  useEffect(() => { let live = true; if (workspace) void api.listPlans({ workspace }).then(value => { if (live) setPlans(value); }).catch(reason => setError(String(reason))); else setPlans([]); return () => { live = false; }; }, [workspace, active]);
  useEffect(() => { setPlan(undefined); }, [workspace]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(false);
  const [tab, setTab] = useState<'model' | 'appearance' | 'memory'>('model');
  const [draft, setDraft] = useState({ baseUrl: '', model: '', key: '', effort: 'medium' as MuvEffort, contextWindow: '', multimodal: false });
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const loadModels = async () => {
    setLoadingModels(true);
    try { const list = await api.listModels({ baseUrl: draft.baseUrl.trim(), ...(draft.key ? { key: draft.key } : {}) }); setModels(list); if (list.length && !list.includes(draft.model)) setDraft(value => ({ ...value, model: list[0] })); }
    catch (reason) { setError(String(reason)); } finally { setLoadingModels(false); }
  };
  const [menu, setMenu] = useState<'workspace' | 'mode' | 'model' | null>(null);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const modePresent = usePopover(menu === 'mode'), modelPresent = usePopover(menu === 'model'), workspacePresent = usePopover(menu === 'workspace');
  const mentionPresent = usePopover(mention), contextPresent = usePopover(contextOpen), permissionPresent = usePopover(permissionOpen);
  const [usageBySession, setUsageBySession] = useState<Record<string, { run: string; usage?: MuvEvent['usage']; estimate?: MuvEvent['estimate'] }>>({});
  useEffect(() => {
    const outside = (event: globalThis.PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest('.menu-anchor:not(.context-meter):not(.shell-mode)')) setMenu(null);
      if (!target.closest('.context-meter')) setContextOpen(false);
      if (!target.closest('.shell-mode')) setPermissionOpen(false);
      if (!target.closest('.reference-picker') && !target.closest('[aria-label="添加上下文引用"]') && !target.closest('textarea')) setMention(false);
    };
    const scroll = (event: globalThis.Event) => { const target = event.target; if (!(target instanceof HTMLElement)) return; target.dataset.scrolling = 'true'; const previous = timers.get(target); if (previous) clearTimeout(previous); timers.set(target, setTimeout(() => { delete target.dataset.scrolling; timers.delete(target); }, 700)); };
    const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
    document.addEventListener('pointerdown', outside); document.addEventListener('scroll', scroll, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('scroll', scroll, true); timers.forEach(clearTimeout); };
  }, []);
  const [query, setQuery] = useState('');
  const [memoryText, setMemoryText] = useState('');
  const [sidebar, setSidebar] = useState(false);
  const [activity, setActivity] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [leftPreference, setLeftPreference] = useState<number>();
  const [rightPreference, setRightPreference] = useState<number>();
  useEffect(() => {
    const updateViewport = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);
  const minSidebarWidth = 180;
  // Reserve at least 360px for the conversation when both sidebars are open.
  const sharedLimit = Math.max(minSidebarWidth, Math.floor((viewportWidth - 360) / 2));
  const leftMax = Math.min(420, activity ? sharedLimit : Math.max(minSidebarWidth, viewportWidth - 360));
  const rightMax = Math.min(480, sharedLimit);
  const compact = viewportWidth <= 1050;
  const leftWidth = Math.min(leftMax, leftPreference ?? (compact ? 190 : viewportWidth >= 1500 ? 240 : 222));
  const rightWidth = Math.min(rightMax, rightPreference ?? (compact ? 190 : 226));
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => {
    const saved = localStorage.getItem('muv-theme');
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  });
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('muv-theme', theme); }, [theme]);
  const [operation, setOperation] = useState(false);
  const [undoableTransactions, setUndoableTransactions] = useState<string[]>([]);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const estimate = usageBySession[current]?.estimate;
  const usage = usageBySession[current]?.usage;
  const session = sessions.find(item => item.id === current);
  const messages = session?.messages || [];
  const busy = !!active;
  const updateLast = (id: string, transform: (message: Message) => Message) => setSessions(all => all.map(item => item.id !== id ? item : { ...item, messages: item.messages.map((message, index) => index === item.messages.length - 1 ? transform(message) : message) }));

  useEffect(() => {
    let mounted = true;
    api.bootstrap().then(data => {
      if (!mounted) return;
      setShellModes(data.shellModes); setSettings(data.settings); setWorkspaces(data.workspaces); setMemories(data.memories);
      void api.undoableTransactions().then(ids => { if (mounted) setUndoableTransactions(ids); }).catch(() => {});
      if (!preview && data.settings.baseUrl) void api.listModels({ baseUrl: data.settings.baseUrl }).then(setModels).catch(() => {});
      setSessions(data.sessions.filter(item => item && typeof item.id === 'string' && Array.isArray(item.messages)));
      setReady(true);
    }).catch(reason => { if (mounted) setError(String(reason)); });
    const unsubscribe = api.onEvent(event => {
      const running = activeRef.current;
      if (!running || running.id !== event.id) return;
      if (!event.agentId && (event.type === 'context' || event.type === 'usage')) setUsageBySession(all => ({ ...all, [running.session]: { ...all[running.session], run: event.id, ...(event.type === 'context' ? { estimate: event.estimate, usage: undefined } : { usage: event.usage }) } }));
      if (event.todos) updateLast(running.session, message => ({ ...message, todos: event.todos }));
      if (event.type === 'turn-start') updateLast(running.session, message => ({ ...message, activeTurnId: event.turnId }));
      if (event.type === 'block-start' && event.blockId && event.blockType) updateLast(running.session, message => ({ ...message, blocks: [...(message.blocks || []), { id: event.blockId!, turnId: event.turnId || message.activeTurnId || uid(), type: event.blockType!, text: '', label: event.agentId ? `[${event.agentId}] ${event.text || event.blockType}` : event.text || '', ...(event.blockType === 'tool' ? { toolStatus: 'running' as const } : {}) }] } as Message));
      if (event.type === 'block-delta' && event.blockId) updateLast(running.session, message => ({ ...message, blocks: (message.blocks || []).map(block => block.id === event.blockId ? { ...block, text: block.text + (event.text || '') } : block) }));
      if (event.type === 'block-update' && event.blockId) { updateLast(running.session, message => ({ ...message, blocks: (message.blocks || []).map(block => block.id === event.blockId ? { ...block, text: event.text || '', displayContent: event.displayContent, ...(block.type === 'tool' ? { toolStatus: event.text?.startsWith('待写') ? 'running' as const : toolFailed(event.text || '') ? 'failure' as const : 'success' as const } : {}), ...(event.change ? { change: event.change } : {}) } : block) })); if (event.change) setUndoableTransactions(ids => [...ids.filter(id => id !== event.change!.transactionId), event.change!.transactionId]); }
      if (event.type === 'delta') updateLast(running.session, message => ({ ...message, content: message.content + (event.text || '') }));
      if (event.type === 'stage' && event.text && !event.text.startsWith('已')) updateLast(running.session, message => ({ ...message, stages: [...(message.stages || []), event.text || '处理中'] }));
      if (event.type === 'summary') updateLast(running.session, message => ({ ...message, summary: (message.summary || '') + (event.text || '') }));
      if (event.type === 'changes') updateLast(running.session, message => ({ ...message, changes: event.changes }));
      if (event.type === 'error') setError(event.text || '任务执行失败');
      if (event.type === 'done' || event.type === 'error') { activeRef.current = null; setActive(null); }
    });
    return () => { mounted = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!ready || busy) return;
    const timer = setTimeout(() => { api.saveData({ memories, sessions }).catch(reason => setError(`保存失败：${String(reason)}`)); }, 400);
    return () => clearTimeout(timer);
  }, [sessions, memories, ready, busy]);
  useEffect(() => { const element = textRef.current; if (element) { element.style.height = '0px'; element.style.height = `${Math.min(160, Math.max(44, element.scrollHeight))}px`; } }, [prompt]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' }); }, [sessions, active]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenu(null); setMention(false); setContextOpen(false); setPermissionOpen(false); if (!saving) setModal(false); setSidebar(false); } };
    document.addEventListener('keydown', handler); return () => document.removeEventListener('keydown', handler);
  }, [saving]);

  const send = async () => {
    if (!prompt.trim() || busy || !ready) return;
    if (mode !== 'ask' && !workspace) { setError('当前模式需要先选择工作区。'); return; }
    const content = prompt.trim();
    const sessionId = session?.id || uid();
    const runId = uid();
    const retained = editing === null ? messages : messages.slice(0, editing);
    const history = retained.map(message => ({ role: message.role, content: message.content }));
    const nextMessages: Message[] = [...retained, { role: 'user', content }, { role: 'assistant', content: '', stages: [] }];
    setSessions(all => session ? all.map(item => item.id === sessionId ? { ...item, messages: nextMessages, workspace, mode } : item) : [{ id: sessionId, title: content.slice(0, 48), workspace, mode, messages: nextMessages }, ...all]);
    setCurrent(sessionId); setPrompt(''); setEditing(null); setError(''); setMenu(null);
    setUsageBySession(all => ({ ...all, [sessionId]: { run: runId } }));
    const running = { id: runId, session: sessionId }; activeRef.current = running; setActive(running);
    try { await api.run({ id: runId, prompt: content, workspace, mode, effort: settings.effort, history, memories: memories.filter(item => item.enabled).map(item => item.text), demo: preview, references }); setReferences([]); }
    catch (reason) { if (activeRef.current?.id === runId) { setError(String(reason)); activeRef.current = null; setActive(null); } }
  };
  const [planDraft, setPlanDraft] = useState<string | null>(null);
  const [planEditing, setPlanEditing] = useState(false);
  const [planSaving, setPlanSaving] = useState(false);
  const [closeWarning, setCloseWarning] = useState(false);
  const dirty = !!plan && planDraft !== null && planDraft !== plan.content;
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, [dirty]);
  const savePlanFile = async () => {
    if (!plan || planSaving) return false;
    setPlanSaving(true);
    try { const saved = await api.savePlan({ workspace: plan.workspace, path: plan.path, planId: plan.id, content: planDraft ?? plan.content, expected: plan.content }); setPlan({ ...saved, workspace: plan.workspace }); setPlanDraft(saved.content); setError(''); return true; }
    catch (reason) { setError(String(reason)); return false; } finally { setPlanSaving(false); }
  };
  const buildPlan = async () => {
    if (!plan || plan.workspace !== workspace || busy || planSaving) return;
    if (dirty && !await savePlanFile()) return;
    const sessionId = uid(), runId = uid();
    setSessions(all => [{ id: sessionId, title: `构建 ${basename(plan.path)}`, workspace, mode: 'agent', messages: [{ role: 'user', content: `构建计划：${plan.path}` }, { role: 'assistant', content: '' }] }, ...all]);
    setCurrent(sessionId); setMode('agent'); setPlan(undefined);
    const running = { id: runId, session: sessionId }; activeRef.current = running; setActive(running);
    try { await api.run({ id: runId, prompt: '构建所选计划', workspace, mode: 'agent', effort: settings.effort, history: [], memories: memories.filter(item => item.enabled).map(item => item.text), demo: false, planPath: plan.path, planId: plan.id }); }
    catch (reason) { setError(String(reason)); activeRef.current = null; setActive(null); }
  };
  const stop = async () => {
    const running = activeRef.current; if (!running) return;
    try { await api.cancel(running.id); if (activeRef.current?.id === running.id) { updateLast(running.session, message => ({ ...message, summary: '已停止生成' })); activeRef.current = null; setActive(null); } }
    catch (reason) { setError(`停止失败：${String(reason)}`); }
  };
  const chooseWorkspace = async () => {
    try { const path = await api.chooseWorkspace(); if (path) { setWorkspace(path); setWorkspaces(all => [path, ...all.filter(item => item !== path)]); setMenu(null); } } catch (reason) { setError(String(reason)); }
  };
  const openSettings = () => { setDraft({ baseUrl: settings.baseUrl, model: settings.model, key: '', effort: settings.effort, contextWindow: String(settings.contextWindow || ''), multimodal: !!settings.multimodal }); setModal(true); setMenu(null); };
  const saveSettings = async () => {
    setSaving(true);
    try {
      await api.saveSettings({ baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), effort: draft.effort, contextWindow: draft.contextWindow ? Number(draft.contextWindow) : undefined, multimodal: draft.multimodal, ...(draft.key ? { key: draft.key } : {}) });
      setSettings({ baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), effort: draft.effort, contextWindow: draft.contextWindow ? Number(draft.contextWindow) : undefined, multimodal: draft.multimodal, hasKey: settings.hasKey || (!!draft.key && !preview) });
      setDraft(value => ({ ...value, key: '' })); setModal(false);
    } catch (reason) { setError(String(reason)); } finally { setSaving(false); }
  };
  const undoFileChange = useCallback(async (transactionId: string) => {
    setOperation(true);
    try {
      await api.undo(transactionId);
      setUndoableTransactions(ids => ids.filter(id => id !== transactionId));
      setSessions(all => all.map(item => ({ ...item, messages: item.messages.map(message => ({ ...message, blocks: message.blocks?.map(block => block.change?.transactionId === transactionId ? { ...block, undone: true } : block) })) })));
    } catch (reason) { setError(String(reason)); } finally { setOperation(false); }
  }, []);
  const updateLastForSession = (sessionId: string, transform: (message: Message) => Message) => setSessions(all => all.map(item => item.id !== sessionId ? item : { ...item, messages: item.messages.map((message, index) => index === item.messages.length - 1 ? transform(message) : message) }));
  const apply = async (index: number, changes: unknown) => {
    if (!session?.workspace) return;
    setOperation(true);
    try { await api.apply({ workspace: session.workspace, changes }); setSessions(all => all.map(item => item.id === current ? { ...item, messages: item.messages.map((message, i) => i === index ? { ...message, applied: true } : message) } : item)); setUndoableTransactions(await api.undoableTransactions()); }
    catch (reason) { setError(String(reason)); } finally { setOperation(false); }
  };

  return <div className="app" style={{ '--left-sidebar-width': `${leftWidth}px`, '--right-sidebar-width': `${rightWidth}px` } as CSSProperties}>
    {sidebar && <div className="sidebar-scrim" onClick={() => setSidebar(false)} />}
    <aside id="task-sidebar" className={`sidebar ${sidebar ? 'open' : ''}`}>
      <div className="brand"><span className="brand-symbol"><img src={appIcon} alt="" width={28} height={28} /></span><strong>muv</strong><span className="brand-caption">你的想法，即刻开始</span></div>
      <button className="new-task" onClick={() => { setCurrent(''); setPrompt(''); setEditing(null); setSidebar(false); }}><Plus size={16} />新建任务<span>↗</span></button>
      <div className="section-label">最近任务 <span>{sessions.length || ''}</span></div>
      <nav className="task-list" aria-label="最近任务">{sessions.length ? [...new Set(sessions.map(item => item.workspace))].map(root => <section className="workspace-group" key={root}><h3 title={root}><Folder size={12} />{root ? basename(root) : '独立问答'}</h3>{sessions.filter(item => item.workspace === root).map(item => <button key={item.id} className={`task ${current === item.id ? 'selected' : ''}`} onClick={() => { setCurrent(item.id); setEditing(null); setPrompt(''); setWorkspace(item.workspace || ''); setMode(item.mode || 'ask'); setSidebar(false); }}><MessageSquare size={14} /><span>{item.title || '未命名任务'}</span>{active?.session === item.id && <span className="live-dot" />}</button>)}</section>) : <p className="task-empty">从一个新想法开始，<br />任务会保留在这里。</p>}</nav>
      <section className="plan-list" aria-label="工作区计划"><div className="section-label">计划文件</div>{plans.map(item => <button className="task" key={item.path} onClick={async () => { try { if (dirty) { setCloseWarning(true); return; } const root = workspace; const value = await api.readPlan({ workspace: root, path: item.path }); setPlan({ ...value, workspace: root }); setPlanDraft(null); setPlanEditing(false); setCloseWarning(false); } catch (reason) { setError(String(reason)); } }}>{basename(item.path)}</button>)}</section>
      <div className="sidebar-bottom"><div className="local-label"><span className="status-dot" />{preview ? '浏览器演示' : '本地工作空间'}</div><button className="settings-button" onClick={openSettings}><Settings size={16} />设置<span className="shortcut">偏好与模型</span></button></div>
    </aside>
    {viewportWidth > 760 && <SidebarSeparator side="left" width={leftWidth} min={minSidebarWidth} max={leftMax} onResize={setLeftPreference} />}
    <main className="main">
      <header className="topbar"><button className="icon mobile-toggle" aria-label="切换任务列表" onClick={() => setSidebar(!sidebar)}><PanelLeft size={18} /></button><span className="breadcrumb-root">工作空间</span><ChevronRight size={13} /><span className="breadcrumb-name" title={workspace}>{workspace ? basename(workspace) : '新任务'}</span>{preview && <span className="demo-badge">演示</span>}<button className={`icon activity-toggle ${activity ? 'active' : ''}`} aria-label="切换任务活动" title="任务活动" onClick={() => setActivity(!activity)}><PanelLeft size={16} /></button></header>
      {plan ? <section className="plan-file-page" aria-label="计划 Markdown"><header><strong>{basename(plan.path)}{dirty ? ' · 未保存' : ''}</strong><button onClick={() => setPlanEditing(!planEditing)}>{planEditing ? '预览' : '编辑'}</button><button disabled={!dirty || planSaving} onClick={() => void savePlanFile()}>{planSaving ? '保存中…' : '保存'}</button><button disabled={busy || planSaving || plan.workspace !== workspace} onClick={() => void buildPlan()}>构建</button><button disabled={planSaving} onClick={() => dirty ? setCloseWarning(true) : setPlan(undefined)}>关闭</button></header><small>{plan.path}</small>{error && <div className="error" role="alert">{error}</div>}{closeWarning && <div className="editing-notice">计划有未保存的修改。<button onClick={() => setCloseWarning(false)}>继续编辑</button><button onClick={async () => { if (await savePlanFile()) { setPlan(undefined); setCloseWarning(false); } }}>保存并关闭</button><button onClick={() => { setPlan(undefined); setCloseWarning(false); setPlanDraft(null); }}>放弃修改并关闭</button></div>}{planEditing ? <textarea className="plan-editor" aria-label="编辑计划 Markdown" value={planDraft ?? plan.content} onChange={event => setPlanDraft(event.target.value)} /> : <div className="plan-document"><Markdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={() => undefined} components={{ a: ({ children }) => <span>{children}</span>, img: () => null }}>{planDraft ?? plan.content}</Markdown></div>}</section> : <div className="content-layout"><div className={`conversation ${messages.length ? 'has-messages' : ''}`}>
        <div className="scroll-area">{messages.length === 0 ? <div className="empty"><div className="empty-mark"><img src={appIcon} alt="Muv Code" width={54} height={54} /></div><h1>今天想做些什么？</h1><p>说说你的想法，我们一起把它变成现实。</p><div className="suggestions">{['帮我梳理一个产品想法', '如何规划一个新项目？', '给我一些界面设计建议'].map(text => <button key={text} onClick={() => { setPrompt(text); textRef.current?.focus(); }}><MessageSquare size={13} />{text}<ChevronRight size={13} /></button>)}</div><div className="empty-hint"><span />从提问开始，或选择工作区开始制作<span /></div></div> : <div className="messages"><MessageHistory messages={messages} busy={busy} operation={operation} session={session} undoable={undoableTransactions}>{messages.map((message, index) => <article key={index} className={`message ${message.role}`}><div className="message-label">{message.role === 'user' ? '你' : <><Sparkles size={14} />muv{preview && <span className="muted">· 演示</span>}</>}</div>{!message.blocks?.length && !!message.stages?.length && <details className="stages"><summary><span className={busy && index === messages.length - 1 ? 'live-dot' : 'status-dot'} />{stageName(message.stages[message.stages.length - 1])}<ChevronDown size={12} /></summary><div>{message.stages.map((stage, i) => <p key={i}><Check size={12} />{stageName(stage)}</p>)}</div></details>}{message.todos && <section className="todo-list" aria-label="任务进度">{message.todos.map(todo => <div key={todo.id} data-status={todo.status}><span>{{ pending: '待处理', in_progress: '进行中', completed: '已完成' }[todo.status]}</span> {todo.text}</div>)}</section>}<div className="message-content">{message.blocks?.length ? <OrderedBlocks blocks={message.blocks} busy={busy && index === messages.length - 1} undoableTransactions={undoableTransactions} onUndo={undoFileChange} /> : (message.content ? (message.role === 'assistant' ? <RichText>{message.content}</RichText> : message.content) : '') || (message.role === 'assistant' && busy && index === messages.length - 1 ? <span className="thinking">正在思考<span>···</span></span> : '')}</div>{message.role === 'user' && <button className="edit-message" disabled={busy} onClick={() => { setEditing(index); setPrompt(message.content); textRef.current?.focus(); }}>编辑</button>}{!message.blocks?.length && message.summary && <Reasoning text={message.summary} />}{message.changes !== undefined && <details className="changes"><summary>查看文件变更<ChevronDown size={13} /></summary><pre>{typeof message.changes === 'string' ? message.changes : JSON.stringify(message.changes, null, 2)}</pre><button className="secondary" disabled={operation || busy || !session?.workspace || message.applied} onClick={() => apply(index, message.changes)}>{message.applied ? '已应用' : '应用变更'}</button>{message.applied && <button className="text-button" disabled={operation} onClick={async () => { setOperation(true); try { await api.undo(); setUndoableTransactions(await api.undoableTransactions()); setSessions(all => all.map(item => ({ ...item, messages: item.messages.map(m => ({ ...m, applied: false })) }))); } catch (reason) { setError(String(reason)); } finally { setOperation(false); } }}>撤销上次应用</button>}</details>}</article>)}</MessageHistory><div ref={endRef} /></div>}<ShellPermissionModal api={api} /></div>
        <div className="composer-region">{error && <div className="error" role="alert"><span>{error}</span><button className="icon" aria-label="关闭提示" onClick={() => setError('')}><X size={14} /></button></div>}
          {editing !== null && <div className="editing-notice">编辑后发送将重新生成后续回复<button onClick={() => { setEditing(null); setPrompt(''); }}>取消编辑</button></div>}<div className="composer">{mentionPresent && <div inert={!mention} data-closing={!mention} className="reference-picker" role="dialog" aria-label="选择上下文引用"><div role="tablist">{(['file', 'folder', 'terminal'] as const).map(kind => <button role="tab" aria-selected={referenceKind === kind} key={kind} onClick={() => { setReferenceKind(kind); setReferenceRow(0); }}>{{ file: '文件', folder: '文件夹', terminal: '终端输出' }[kind]}</button>)}</div><small>{preview ? 'Mock 浏览器预览：无真实工作区或终端数据' : '来自选定工作区；文件夹仅引用有界目录列表'}</small><div role="listbox">{candidates.map((item, index) => <button role="option" aria-selected={index === referenceRow} key={item.path} onMouseEnter={() => setReferenceRow(index)} onClick={() => selectReference(item)}>{item.path}</button>)}{!candidates.length && <p>没有可引用的{referenceKind === 'terminal' ? '已有 Shell 输出' : '条目'}{!workspace && '，请先选择工作区'}</p>}</div></div>}<div className="reference-chips">{references.map(item => <button key={item.kind + item.path} onClick={() => setReferences(all => all.filter(ref => ref !== item))}>@{item.path} ×</button>)}</div><textarea ref={textRef} rows={1} aria-label="任务描述" placeholder={mode === 'ask' ? '有什么想问的，或想做的…' : '描述你想完成的任务…'} value={prompt} onChange={event => { setPrompt(event.target.value); setMention(/@[^@\n]*$/.test(event.target.value)); setReferenceRow(0); }} onKeyDown={event => { if (mention && !event.nativeEvent.isComposing) { if (event.key === 'Escape') { event.preventDefault(); setMention(false); return; } if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const kinds = ['file', 'folder', 'terminal'] as const; setReferenceKind(kinds[(kinds.indexOf(referenceKind) + (event.key === 'ArrowRight' ? 1 : 2)) % 3]); setReferenceRow(0); return; } if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); setReferenceRow(value => (value + (event.key === 'ArrowDown' ? 1 : Math.max(1, candidates.length) - 1)) % Math.max(1, candidates.length)); return; } if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); if (candidates[referenceRow]) selectReference(candidates[referenceRow]); return; } } if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div className="composer-toolbar"><div className="menu-anchor"><button className="toolbar-button" aria-expanded={menu === 'mode'} onClick={() => setMenu(menu === 'mode' ? null : 'mode')}><ModeIcon mode={mode} />{modeNames[mode]}<span className="hover-panel mode-hover" role="tooltip"><strong>{modeNames[mode]}</strong><span>{{ ask: '只回答问题，不修改文件。', plan: '梳理实施步骤并保存计划。', agent: '直接在工作区执行任务。', super_llm: '先理解、定规格和自审，再制作。' }[mode]}</span></span><ChevronDown size={12} /></button>{modePresent && <div inert={menu !== 'mode'} data-closing={menu !== 'mode'} className="popover mode-menu">{(['ask', 'plan', 'agent', 'super_llm'] as const).map(value => <button key={value} onClick={() => { setMode(value); setMenu(null); }}><ModeIcon mode={value} /><span className="mode-option-text"><strong>{modeNames[value]}</strong><small>{{ ask: '探索想法，解答问题', plan: '先梳理目标与实施计划', agent: '直接执行', super_llm: '理解 → 规格 → 计划 → 自审 → 制作' }[value]}</small></span>{mode === value && <Check size={14} />}</button>)}</div>}</div><div className="toolbar-right"><button className="toolbar-button" aria-label="添加上下文引用" onClick={() => { setPrompt(value => value + '@'); setMention(true); textRef.current?.focus(); }}>@</button><div className="menu-anchor"><button className="toolbar-button model-button" aria-expanded={menu === 'model'} onClick={() => setMenu(menu === 'model' ? null : 'model')}><span>{settings.model || '配置模型'}</span><span className="effort-label">{effortNames[settings.effort] || settings.effort}</span><ChevronDown size={12} /></button>{modelPresent && <div inert={menu !== 'model'} data-closing={menu !== 'model'} className="popover model-menu"><div className="popover-label">模型</div><div className="model-list">{[...new Set([settings.model, ...models])].filter(Boolean).map(model => <button key={model} disabled={busy} onClick={async () => { try { await api.saveSettings({ baseUrl: settings.baseUrl, model, effort: settings.effort, contextWindow: settings.contextWindow, multimodal: settings.multimodal }); setSettings(item => ({ ...item, model })); setMenu(null); } catch (reason) { setError(String(reason)); } }}><span>{model}</span>{settings.model === model && <Check size={14} />}</button>)}</div><button onClick={openSettings}>获取 / 管理模型</button><div className="popover-label">reasoning_effort</div>{(Object.keys(effortNames) as MuvEffort[]).map(value => <button key={value} onClick={() => { setSettings(item => ({ ...item, effort: value })); setMenu(null); }}>{effortNames[value]}{settings.effort === value && <Check size={14} />}</button>)}<button className="menu-separated" onClick={openSettings}><Settings size={14} />模型设置</button></div>}</div><button className={`send ${busy ? 'stop' : ''}`} aria-label={busy ? '停止生成' : '发送'} disabled={!busy && (!prompt.trim() || !ready)} onClick={() => void (busy ? stop() : send())}>{busy ? <Square size={13} fill="currentColor" /> : <ArrowUp size={17} />}</button></div></div></div>
          <footer className="composer-footer"><div className="menu-anchor workspace-anchor"><button className="workspace-button" title={workspace || '选择工作区'} aria-expanded={menu === 'workspace'} onClick={() => setMenu(menu === 'workspace' ? null : 'workspace')}><Folder size={13} /><span>{workspace ? basename(workspace) : '选择工作区'}</span><ChevronDown size={11} /></button>{workspacePresent && <div inert={menu !== 'workspace'} data-closing={menu !== 'workspace'} className="popover workspace-menu"><label className="workspace-search"><Search size={14} /><input autoFocus placeholder="搜索最近工作区" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="popover-label">最近工作区</div><div className="workspace-recents">{workspaces.filter(path => path.toLowerCase().includes(query.toLowerCase())).map(path => <button key={path} title={path} onClick={() => { setWorkspace(path); setMenu(null); }}><Folder size={15} /><span><strong>{basename(path)}</strong><small>{path}</small></span>{workspace === path && <Check size={13} />}</button>)}{!workspaces.filter(path => path.toLowerCase().includes(query.toLowerCase())).length && <p className="no-results">{query ? '没有匹配的工作区' : '还没有最近工作区'}</p>}</div><button className="menu-separated" onClick={() => void chooseWorkspace()}><FolderOpen size={15} />选择文件夹…</button>{workspace && <button onClick={() => { setWorkspace(''); setMode('ask'); setMenu(null); }}>不使用工作区 · 仅问答</button>}</div>}</div><div className="menu-anchor shell-mode"><span>Shell</span><button className="toolbar-button" aria-label="Shell 审批权限" aria-expanded={permissionOpen} disabled={!workspace || preview || permissionSaving || !ready} onClick={() => setPermissionOpen(!permissionOpen)}>{{ ask: '每次询问', auto: '自动审批', full: '完全访问' }[shellModes[workspace] || 'ask']}<ChevronDown size={11} /></button>{permissionPresent && <div className="popover" inert={!permissionOpen} data-closing={!permissionOpen}><small>仅影响当前工作区 Shell；工作目录不是沙箱。</small>{(['ask', 'auto', 'full'] as const).map(value => <button key={value} disabled={permissionSaving} onClick={async () => { const root = workspace; setPermissionOpen(false); setPermissionSaving(true); try { const selected = await api.setShellMode({ workspace: root, mode: value }); setShellModes(all => ({ ...all, [root]: selected })); } catch (reason) { setError(String(reason)); } finally { setPermissionSaving(false); } }}>{{ ask: '每次询问', auto: '自动审批（仅 git_status）', full: '完全访问' }[value]}</button>)}</div>}</div><div className="menu-anchor context-meter" onKeyDown={event => { if (event.key === 'Escape') setContextOpen(false); }}><button className="toolbar-button" aria-label="上下文估计详情" aria-expanded={contextOpen} aria-controls="context-details" onClick={() => setContextOpen(!contextOpen)}><span className="context-bar" aria-hidden="true"><span style={{ width: `${estimate?.limit ? Math.min(100, estimate.total / estimate.limit * 100) : 0}%` }} /></span><span>{estimate?.limit ? `≈${Math.round(estimate.total / estimate.limit * 100)}%` : '—%'}</span></button>{contextPresent && <div id="context-details" inert={!contextOpen} data-closing={!contextOpen} className="popover context-details"><strong>本任务最近请求 · 实际 usage</strong><small>Run：{usageBySession[current]?.run || '尚无请求'}</small><div>输入 {usage?.prompt ?? '未提供'} · 输出 {usage?.completion ?? '未提供'} · 总计 {usage?.total ?? '未提供'}</div><div>缓存命中 {usage?.cached ?? '未提供'} · 未命中 {usage?.cacheMiss ?? '未提供'}</div><div>缓存命中率 {usage?.cacheRate === undefined ? '未提供' : `${(usage.cacheRate * 100).toFixed(1)}%`}（命中 / 输入 tokens）</div><strong>上下文估计</strong><small>字符启发式估计，非模型实际 usage；不含输出预留。占比依据用户设置的模型上限。</small>{estimate ? <>{(['system', 'reference', 'history', 'prompt', 'tools'] as const).map(key => <div key={key}>{{ system: '系统指令', reference: '引用与工具结果', history: '历史', prompt: '当前消息', tools: '工具定义' }[key]} ≈{estimate[key]}<div className="context-bar" role="meter" aria-label={key} aria-valuemin={0} aria-valuemax={estimate.total || 1} aria-valuenow={estimate[key]}><span style={{ width: `${estimate.total ? estimate[key] / estimate.total * 100 : 0}%` }} /></div></div>)}<p>总计 ≈{estimate.total} / {estimate.limit || '未设置上限，无法计算百分比'}</p></> : <p>{preview ? '演示没有真实模型请求' : '发送真实请求后显示'}</p>}</div>}</div></footer>
        </div>
      </div>
      {activity && viewportWidth > 760 && <SidebarSeparator side="right" width={rightWidth} min={minSidebarWidth} max={rightMax} onResize={setRightPreference} />}
      {activity && <aside id="task-activity" className="activity-panel"><div className="activity-heading">任务活动<button className="icon" aria-label="关闭任务活动" onClick={() => setActivity(false)}><X size={15} /></button></div><p className="activity-subtitle">{mode === 'agent' ? '自动推进每个阶段' : '当前任务的执行过程'}</p>{['understanding', 'spec', 'plan', 'build'].map(stage => { const stages = messages.flatMap(message => message.stages || []); const reached = stages.includes(stage) || stages.some(value => value.includes(stageName(stage))); return <div className={`activity-stage ${reached ? 'reached' : ''}`} key={stage}>{reached ? <Check size={14} /> : <Circle size={13} />}<span>{stageName(stage)}</span></div>; })}{!messages.length && <p className="activity-note">任务开始后，进展会出现在这里。</p>}</aside>}</div>}
    </main>
        {modal && <div className="settings-page"><aside className="settings-nav"><button autoFocus className="settings-back" disabled={saving} onClick={() => setModal(false)}>← 返回应用</button><h2>设置</h2><nav aria-label="设置分类">{(['model', 'appearance', 'memory'] as const).map(value => <button key={value} aria-current={tab === value ? 'page' : undefined} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>{{ model: '模型', appearance: '外观', memory: '记忆' }[value]}</button>)}</nav></aside><section className="settings-content" aria-labelledby="settings-title">{error && <div className="error" role="alert"><span>{error}</span><button className="icon" aria-label="关闭设置提示" onClick={() => setError('')}><X size={14} /></button></div>}<header className="settings-heading"><h1 id="settings-title">{{ model: '模型', appearance: '外观', memory: '记忆' }[tab]}</h1><p>{{ model: '管理模型连接与默认思考深度', appearance: '选择适合你的界面主题', memory: '管理协作中的偏好与项目约定' }[tab]}</p></header>{tab === 'model' ? <form onSubmit={event => { event.preventDefault(); void saveSettings(); }}><div className="modal-body"><p className="modal-description">连接你的模型，让想法开始生长。{preview && ' 当前配置仅用于演示预览。'}</p><label className="field">API 端点<input type="url" placeholder="https://api.example.com/v1" value={draft.baseUrl} onChange={event => setDraft(value => ({ ...value, baseUrl: event.target.value }))} /></label><label className="field">模型<select value={draft.model} onChange={event => setDraft(value => ({ ...value, model: event.target.value }))}><option value={draft.model}>{draft.model || '先获取上游模型'}</option>{models.filter(model => model !== draft.model).map(model => <option key={model} value={model}>{model}</option>)}</select></label><button type="button" className="secondary fetch-models" disabled={loadingModels || !draft.baseUrl.trim()} onClick={() => void loadModels()}>{loadingModels ? '获取中…' : '使用 API 和 Key 获取模型'}{models.length ? ` · ${models.length}` : ''}</button><label className="field">API Key <span className="muted">可选</span><input type="password" autoComplete="new-password" placeholder={settings.hasKey ? '已保存密钥 · 留空保留' : '输入 API Key（可选）'} value={draft.key} onChange={event => setDraft(value => ({ ...value, key: event.target.value }))} /><small>已保存的密钥不会在界面中显示。</small></label><label className="field">上下文窗口（tokens，可选）<input type="number" min={1024} max={10000000} value={draft.contextWindow} onChange={event => setDraft(value => ({ ...value, contextWindow: event.target.value }))} /><small>用户声明的模型上限，用于估计占比。</small></label><label className="field"><input type="checkbox" checked={draft.multimodal} onChange={event => setDraft(value => ({ ...value, multimodal: event.target.checked }))} />声明模型支持多模态<small>仅声明能力；当前实际输入仅文本，不支持上传图片。</small></label><label className="field">默认思考深度<select value={draft.effort} onChange={event => setDraft(value => ({ ...value, effort: event.target.value as MuvEffort }))}>{Object.entries(effortNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><div className="modal-footer"><button type="button" className="secondary" disabled={saving} onClick={() => setModal(false)}>取消</button><button className="primary" disabled={saving}>{saving ? '保存中…' : '保存设置'}</button></div></form> : tab === 'appearance' ? <div className="modal-body"><div className="appearance"><span>界面主题</span><div className="theme-options" role="group" aria-label="界面主题">{(['system', 'light', 'dark'] as const).map(value => <button type="button" key={value} aria-pressed={theme === value} className={theme === value ? 'selected' : ''} onClick={() => setTheme(value)}>{{ system: '跟随系统', light: '浅色', dark: '深色' }[value]}</button>)}</div></div></div> : <div className="modal-body"><p className="modal-description">保留你的偏好和项目约定。只有启用的记忆会随任务发送。</p><form className="memory-add" onSubmit={event => { event.preventDefault(); if (memoryText.trim()) { setMemories(all => [...all, { id: uid(), text: memoryText.trim(), enabled: true }]); setMemoryText(''); } }}><input aria-label="新增记忆" placeholder="例如：优先使用 TypeScript" value={memoryText} onChange={event => setMemoryText(event.target.value)} /><button className="secondary" disabled={!memoryText.trim()}><Plus size={15} />添加</button></form><div className="memory-list">{memories.length ? memories.map(item => <div className="memory-item" key={item.id}><button role="switch" aria-checked={item.enabled} aria-label={`启用记忆：${item.text}`} className={`toggle ${item.enabled ? 'on' : ''}`} onClick={() => setMemories(all => all.map(memory => memory.id === item.id ? { ...memory, enabled: !memory.enabled } : memory))}><span /></button><span>{item.text}</span><button className="icon" aria-label={`删除记忆：${item.text}`} onClick={() => setMemories(all => all.filter(memory => memory.id !== item.id))}><Trash2 size={15} /></button></div>) : <div className="memory-empty"><Sparkles size={22} /><p>还没有记忆</p><small>添加一条偏好，让每次协作更合拍。</small></div>}</div></div>}</section></div>}
  </div>;
}
