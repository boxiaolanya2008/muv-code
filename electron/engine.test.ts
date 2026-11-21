import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute, FileTransactions, workspaceIndex, referenceContent, estimateContext, actualUsage, validateTodos, pendingWrite, listPlans, readPlan, updatePlan, registeredPlan, type RegisteredPlan, type Event } from './engine.js';

test('todo validation and streamed write previews reject invalid state and hide old text', () => {
  assert.deepEqual(validateTodos([{ id: 'a', text: '真实任务', status: 'in_progress' }]), [{ id: 'a', text: '真实任务', status: 'in_progress' }]);
  for (const value of [[{ id: 'a', text: 'a', status: 'done' }], [{ id: 'a', text: '', status: 'pending' }], [{ id: 'a', text: 'a', status: 'pending' }, { id: 'a', text: 'b', status: 'completed' }]]) assert.throws(() => validateTodos(value));
  assert.equal(pendingWrite('{"path":"x","content":"a\\n\\u4e2d', 'write_file'), '待写 · 2 行\na\n中');
  assert.equal(pendingWrite(JSON.stringify({ old_text: 'secret new_text', path: 'x' }), 'edit_file'), undefined);
  assert.equal(pendingWrite('{"old_text":"secret","new_text":"safe', 'edit_file'), '待写 · 1 行\nsafe');
});

test('actual cache usage preserves missing fields and guards denominators', () => {
  assert.equal(actualUsage(undefined), undefined);
  assert.equal(actualUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 25 } })?.cacheRate, .25);
  assert.equal(actualUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 })?.cacheMiss, 40);
  for (const prompt_tokens of [0, -1, undefined, NaN]) assert.equal(actualUsage({ prompt_tokens, prompt_cache_hit_tokens: 2 })?.cacheRate, undefined);
  assert.equal(actualUsage({ prompt_tokens: 1, prompt_cache_hit_tokens: 2 })?.cacheRate, undefined);
  assert.equal(actualUsage({ prompt_tokens: 100 })?.cached, undefined);
  assert.equal(actualUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 0 })?.cacheRate, 0);
});

test('usage reaches events from JSON and the final empty-choice SSE chunk', async () => {
  const original = globalThis.fetch;
  try {
    for (const stream of [true, false]) {
      globalThis.fetch = async (_, init) => {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.stream_options, { include_usage: true });
        const usage = { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 30 } };
        return stream ? new Response(`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`) : Response.json({ choices: [{ message: { content: 'ok' } }], usage });
      };
      const events: Event[] = [];
      await execute({ id: 'usage', prompt: 'test', workspace: '', mode: 'ask', effort: 'auto', history: [], memories: [], demo: false }, { baseUrl: 'http://localhost/v1', model: 'test', key: 'test', effort: 'auto' }, new AbortController().signal, event => events.push(event));
      assert.equal(events.find(event => event.type === 'usage')?.usage?.cacheRate, .3);
    }
  } finally { globalThis.fetch = original; }
});

test('unsupported include_usage retries once without stream options', async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async (_, init) => {
      const body = JSON.parse(String(init?.body));
      if (++calls === 1) { assert.equal(body.stream_options.include_usage, true); return new Response('unsupported stream_options', { status: 400 }); }
      assert.equal(body.stream_options, undefined);
      return Response.json({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 20, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 10 } });
    };
    const events: Event[] = [];
    await execute({ id: 'fallback', prompt: 'test', workspace: '', mode: 'ask', effort: 'auto', history: [], memories: [], demo: false }, { baseUrl: 'http://localhost/v1', model: 'test', key: 'test', effort: 'auto' }, new AbortController().signal, event => events.push(event));
    assert.equal(calls, 2); assert.equal(events.find(event => event.type === 'usage')?.usage?.cacheRate, .5);
  } finally { globalThis.fetch = original; }
});

test('references use bounded real files and reject sensitive paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'muv-refs-'));
  try {
    await writeFile(path.join(root, 'first.txt'), 'FIRST LINE\nbody');
    await writeFile(path.join(root, '.env'), 'secret');
    assert.deepEqual(await workspaceIndex(root), [{ kind: 'file', path: 'first.txt' }]);
    assert.match(await referenceContent(root, [{ kind: 'file', path: 'first.txt' }, { kind: 'terminal', path: 'shell' }], new Map([['shell', 'real output']])), /FIRST LINE\nbody[\s\S]*real output/);
    await assert.rejects(referenceContent(root, [{ kind: 'file', path: '.env' }], new Map()), /Unsafe/);
    await assert.rejects(referenceContent(root, [{ kind: 'folder', path: '../outside' }], new Map()), /Unsafe/);
    await assert.rejects(referenceContent(root, [{ kind: 'terminal', path: 'invented' }], new Map()), /不存在/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('delegation returns independent read-only results and marks events', async () => {
  const original = globalThis.fetch, events: Event[] = [];
  let requests = 0;
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(String(init?.body)); requests++;
    if (requests === 1) return Response.json({ choices: [{ message: { tool_calls: [{ id: 'delegate', function: { name: 'delegate_task', arguments: '{"task":"Investigate"}' } }] } }] });
    if (requests === 2) {
      assert.deepEqual(body.tools.map((t: any) => t.function.name), ['read_file', 'list_files']);
      assert.equal(body.messages.filter((m: any) => m.role === 'user').at(-1).content, 'Investigate');
      return Response.json({ choices: [{ message: { content: 'Actual child result' } }] });
    }
    assert.match(body.messages.at(-1).content, /Actual child result/);
    return Response.json({ choices: [{ message: { content: 'Parent result' } }] });
  };
  try {
    await execute({ id: 'delegate', prompt: 'Parent task', workspace: '', mode: 'agent', effort: 'auto', history: [], memories: [], demo: false }, { baseUrl: 'http://localhost/v1', model: 'shared', effort: 'auto', key: 'test' }, new AbortController().signal, event => events.push(event));
    assert.ok(events.some(event => event.agentId && event.text === 'Actual child result'));
    assert.equal(requests, 3);
    assert.ok(events.some(event => event.type === 'context' && event.estimate?.total));
    assert.equal(estimateContext([{ role: 'user', content: 'test' }], []).total > 0, true);
  } finally { globalThis.fetch = original; }
});

test('subagent cancellation propagates and malicious writes are denied', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController(); let rounds = 0;
  globalThis.fetch = async (_, init) => {
    rounds++;
    if (rounds === 1) return Response.json({ choices: [{ message: { tool_calls: [{ id: 'bad', function: { name: 'write_file', arguments: '{"path":"forbidden.txt","content":"bad"}' } }] } }] });
    assert.match(JSON.parse(String(init?.body)).messages.at(-1).content, /仅允许只读/);
    controller.abort(new Error('parent cancelled')); init?.signal?.throwIfAborted();
    throw new Error('unreachable');
  };
  try { await assert.rejects(execute({ id: 'child', prompt: 'inspect', workspace: '', mode: 'agent', subagent: true, effort: 'auto', history: [], memories: [], demo: false }, { baseUrl: 'http://localhost/v1', model: 'test', effort: 'auto', key: 'test' }, controller.signal, () => {}), /parent cancelled/); }
  finally { globalThis.fetch = original; }
});

test('agent executes write_file and returns actual tool result to the model', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'muv-tools-'));
  const original = globalThis.fetch;
  const events: Event[] = [];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.tools[0].function.name, 'write_file');
    if (calls++ === 0) return Response.json({ choices: [{ message: { role: 'assistant', content: null, reasoning_content: '准备创建介绍文件。', tool_calls: [{ id: 'write-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'intro.html', content: '<h1>项目介绍</h1>' }) } }] } }] });
    assert.equal(body.messages.at(-1).role, 'tool');
    if (calls === 2) {
      assert.match(body.messages.at(-1).content, /已写入 intro.html/);
      const tool_calls = [
        ['edit_file', { path: 'intro.html', old_text: '项目介绍', new_text: '项目概览' }],
        ['edit_file', { path: 'intro.html', old_text: '项目概览', new_text: '工程概览' }],
        ['read_file', { path: 'intro.html' }],
        ['run_command', { command: 'not_allowed' }],
      ].map(([name, input], index) => ({ id: `next-${index}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }));
      return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls } }] });
    }
    const outputs = body.messages.slice(-4).map((message: { content: string }) => message.content);
    assert.match(outputs[0], /已编辑/);
    assert.match(outputs[1], /已编辑/);
    assert.match(outputs[2], /^未改动/);
    assert.match(outputs[3], /不支持/);
    assert.ok(outputs.every((output: string) => !output.includes('<h1>')));
    return Response.json({ choices: [{ message: { role: 'assistant', content: '已完成。' } }] });
  };
  try {
    await execute({ id: 'test', prompt: '创建 HTML 介绍', workspace: root, mode: 'agent', effort: 'high', history: [], memories: [], demo: false }, { baseUrl: 'http://127.0.0.1:8080/v1', model: 'test', effort: 'high', key: 'test' }, new AbortController().signal, event => events.push(event));
    assert.equal(await readFile(path.join(root, 'intro.html'), 'utf8'), '<h1>工程概览</h1>');
    assert.ok(events.some(event => event.type === 'block-update' && event.blockType === 'tool' && event.text?.includes('已写入 intro.html')));
    assert.ok(events.some(event => event.type === 'block-start' && event.blockType === 'reasoning'));
    assert.equal(events.filter(event => event.type === 'turn-start').length, calls);
    const writeEvent = events.find(event => event.type === 'block-update' && event.change?.path === 'intro.html');
    assert.ok(writeEvent?.change);
    assert.equal(writeEvent.change.before, null);
    assert.equal(writeEvent.change.after, '<h1>项目介绍</h1>');
    assert.ok(events.findIndex(event => event.type === 'turn-start') < events.findIndex(event => event.type === 'block-start'));
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
});

test('SSE publishes fragments before completion and assembles tool calls before execution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'muv-sse-'));
  const original = globalThis.fetch;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const push = (delta: object, finish_reason?: string) => body.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`));
  let rounds = 0;
  globalThis.fetch = async (_, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.stream, true);
    if (rounds++) {
      assert.match(request.messages.at(-1).content, /已写入/);
      return Response.json({ choices: [{ message: { content: '完成' } }] });
    }
    return new Response(new ReadableStream({ start(controller) {
      body = controller;
      push({ reasoning_content: '开始' });
      push({ tool_calls: [{ index: 0, id: 'file-', function: { name: 'write_', arguments: '{"path":' } }] });
      push({ content: '先回复' });
      push({ reasoning_content: '继续' });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const events: Event[] = [];
    await execute({ id: 'stream', prompt: '创建文件', workspace: root, mode: 'agent', effort: 'auto', history: [], memories: [], demo: false }, { baseUrl: 'http://127.0.0.1:8080/v1', model: 'test', effort: 'auto', key: 'test' }, AbortSignal.timeout(3000), event => {
      events.push(event);
      if (event.type === 'block-delta' && event.text === '继续') {
        assert.ok(events.some(e => e.type === 'block-delta' && e.text === '先回复'));
        assert.ok(!events.some(e => e.blockType === 'tool'));
        push({ tool_calls: [{ index: 0, id: 'one', function: { name: 'file', arguments: '"out.txt","content":"完成"}' } }] }, 'tool_calls');
        body.enqueue(encoder.encode('data: [DONE]\r\n\r\n'));
        body.close();
      }
    });
    assert.equal(await readFile(path.join(root, 'out.txt'), 'utf8'), '完成');
    assert.equal(events.filter(e => e.type === 'block-start' && e.blockType === 'reasoning').length, 2);
    assert.equal(rounds, 2);
  } finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
});

test('file transactions undo only the latest matching change and detect external conflicts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'muv-undo-'));
  const transactions = new FileTransactions();
  try {
    await transactions.apply(root, [{ path: 'notes.txt', content: 'first' }], new Map([['notes.txt', null]]), 'first');
    assert.deepEqual(transactions.getUndoableIds(), ['first']);
    await transactions.apply(root, [{ path: 'notes.txt', content: 'second' }], new Map([['notes.txt', Buffer.from('first')]]), 'second');
    await assert.rejects(transactions.undo('first'), /latest file transaction/);
    assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'second');
    await transactions.undo('second');
    assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'first');
    await writeFile(path.join(root, 'notes.txt'), 'external');
    await assert.rejects(transactions.undo('first'), /Undo conflict/);
    assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'external');
  } finally { await rm(root, { recursive: true, force: true }); }
});


for (const approved of [true, false]) test(`super_llm ${approved ? 'saves and waits for build after review' : 'stops after two rejected reviews'}`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'muv-super-'));
  const original = globalThis.fetch;
  const events: Event[] = [];
  let reviews = 0;
  let builds = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.tools) {
      assert.equal(reviews, 2);
      assert.equal(body.stream, true);
      builds++;
      if (builds === 1) return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'create', type: 'function', function: { name: 'write_file', arguments: '{"path":"result.txt","content":"done"}' } }] } }] });
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'Done' } }] });
    }
    assert.equal(body.response_format.type, 'json_object');
    const review = body.messages.at(-1).content.startsWith('Review the latest');
    const ready = review && ++reviews === 2 && approved;
    assert.equal(body.stream, true);
    const instruction = body.messages.at(-1).content;
    const content = JSON.stringify(review ? { ready, gaps: ready ? [] : ['Missing check'] } : instruction.includes('"requirements"') ? { requirements: ['检查入口'], defaults: [], questions: [] } : instruction.includes('"scope"') ? { scope: ['入口'], constraints: [], deliverables: ['结果'], acceptance: ['可验证'] } : { steps: ['检查入口'], files: [], verification: ['检查结果'] });
    return new Response(content.split('').map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const run = execute({ id: 'super', prompt: '创建结果文件', workspace: root, mode: 'super_llm', effort: 'auto', history: [], memories: [], demo: false }, { baseUrl: 'http://127.0.0.1:8080/v1', model: 'test', effort: 'auto', key: 'test' }, new AbortController().signal, event => events.push(event));
    if (approved) { await run; assert.equal((await readdir(path.join(root, 'muv-code', '.plan'))).length, 1); await assert.rejects(readFile(path.join(root, 'result.txt')), /ENOENT/); }
    else { await run; assert.equal(reviews, 2); const names = await readdir(path.join(root, 'muv-code', '.plan')); assert.equal(names.length, 1); assert.match(await readFile(path.join(root, 'muv-code', '.plan', names[0]), 'utf8'), /两轮自审未通过.*阻塞风险/); }
    assert.equal(builds, 0);
    assert.equal(events.some(event => event.text === 'build'), false);
  } finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
});

test('plan saves the final Markdown under the workspace with a UTC filename', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'muv-plan-'));
  const original = globalThis.fetch;
  let stage = 0;
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).tools, undefined);
    const content = ++stage === 3 ? '## 范围\n\n检查入口。' : '前置分析';
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
  };
  try {
    const registry: RegisteredPlan[] = [];
    await execute({ id: 'plan', prompt: '梳理入口', workspace: root, mode: 'plan', effort: 'auto', history: [], memories: [], demo: false }, { baseUrl: 'http://127.0.0.1:8080/v1', model: 'test', effort: 'auto', key: 'test' }, new AbortController().signal, () => {}, undefined, undefined, async plan => { registry.push(plan); });
    assert.equal(registry.length, 1);
    const folder = path.join(root, 'muv-code', '.plan');
    const names = await readdir(folder);
    assert.equal(names.length, 1);
    assert.match(names[0], /^\d{4}-\d{2}-\d{2}T.*Z-[a-f0-9]{8}\.md$/);
    const document = await readFile(path.join(folder, names[0]), 'utf8');
    assert.match(document, /# Muv Code 实施计划/);
    assert.match(document, /\[构建\]\(muv-build:[a-f0-9-]+\)/);
    assert.match(document, /## 范围/);
    const plans = await listPlans(root); assert.equal(plans.length, 1);
    const saved = await readPlan(root, plans[0].path); assert.equal(saved.prompt, '梳理入口');
    await assert.rejects(registeredPlan(root, saved.path, [], saved.id), /Unregistered/);
    await writeFile(path.join(folder, 'forged.md'), document);
    await assert.rejects(registeredPlan(root, 'muv-code/.plan/forged.md', registry, saved.id), /Unregistered/);
    await assert.rejects(registeredPlan(root, saved.path, registry, 'forged'), /Unregistered/);
    await writeFile(path.join(folder, names[0]), document.replace('检查入口。', '用户编辑后的步骤。'));
    assert.match((await registeredPlan(root, saved.path, registry, saved.id)).content, /用户编辑后的步骤/);
    const latest = (await registeredPlan(root, saved.path, registry, saved.id)).content;
    await assert.rejects(updatePlan(root, saved.path, saved.id, document, document, registry), /保存冲突/);
    await assert.rejects(updatePlan(root, saved.path, 'forged', latest, latest, registry), /Unregistered/);
    await assert.rejects(updatePlan(root, saved.path, saved.id, '# invalid', latest, registry), /metadata/);
    await updatePlan(root, saved.path, saved.id, latest + '\n保存后的最新版', latest, registry);
    assert.match((await registeredPlan(root, saved.path, registry, saved.id)).content, /保存后的最新版/);
    await rm(path.join(folder, 'forged.md'));
    await writeFile(path.join(folder, 'ordinary.md'), '# ordinary\n[构建](muv-build:fake)');
    assert.equal((await listPlans(root)).length, 1);
    await assert.rejects(readPlan(root, 'muv-code/.plan/ordinary.md'), /Unvalidated/);
    await assert.rejects(readPlan(root, '../outside.md'), /Invalid plan path/);
    assert.doesNotMatch(document, /前置分析/);
  } finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
});
