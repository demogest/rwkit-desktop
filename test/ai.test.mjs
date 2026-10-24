// AI 帮写：三种接口的流式调用、提示词模板、API key 加密保存、拒绝与停止
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ai from '../src/main/ai.mjs';
import * as core from '../src/main/core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rwkit-ai-'));
const events = [];
const requests = [];
let reply = null;   // (url, init) => Response
const sse = (chunks, headers = {}) => new Response(new ReadableStream({
  start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); },
}), { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const headerOf = (init, k) => (init.headers instanceof Headers ? init.headers.get(k) : Object.entries(init.headers || {}).find(([n]) => n.toLowerCase() === k)?.[1]);

ai.init({
  dataDir: tmp,
  encrypt: t => 'E' + Buffer.from(t).toString('base64'),
  decrypt: t => Buffer.from(t.slice(1), 'base64').toString(),
  fetch: async (url, init = {}) => { const u = String(url instanceof Request ? url.url : url); requests.push({ url: u, init, body: init.body ? JSON.parse(init.body) : null }); return reply(u, init); },
  emit: (type, d) => events.push({ type, ...d }),
  log: () => {},
});
// 等一次帮写结束，返回它的全部事件
async function finish(id) {
  for (let i = 0; i < 200; i++) {
    const end = events.find(e => e.id === id && (e.type === 'done' || e.type === 'error'));
    if (end) return { end, deltas: events.filter(e => e.id === id && e.type === 'delta').map(e => e.text) };
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('timeout');
}
const save = async (profile, key) => { const r = await ai.handle('ai.saveProfile', { profile, key }); assert.notEqual(r.ok, false, r.error); return r.saved; };

test('OpenAI 兼容接口（chat/completions）：流式输出、模板变量、去掉 [DONE]', async () => {
  const id = await save({ name: 'DS', type: 'compat', base: 'https://api.deepseek.com/', model: 'deepseek-chat', temperature: '0.7' }, 'sk-secret-1');
  reply = () => sse(['data: {"choices":[{"delta":{"content":"月"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"光"},"finish_reason":"stop"}]}\n', '\ndata: [DONE]\n\n']);
  const r = await ai.handle('ai.run', { profile: id, action: 'polish', text: '月亮', instruction: '更有诗意', field: '世界书条目正文', project: '测试作品', context: '【所在条目】\n条目名称：夜' });
  assert.equal(r.ok, true, r.error);
  const { end, deltas } = await finish(r.id);
  assert.equal(end.type, 'done');
  assert.equal(end.text, '月光');
  assert.deepEqual(deltas, ['月', '光']);
  const q = requests.at(-1);
  assert.equal(q.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(headerOf(q.init, 'authorization'), 'Bearer sk-secret-1');
  assert.equal(q.body.model, 'deepseek-chat');
  assert.equal(q.body.temperature, 0.7);
  assert.equal(q.body.stream, true);
  const user = q.body.messages[1].content;
  assert.match(user, /【位置】世界书条目正文/);
  assert.match(user, /【额外要求】更有诗意/);
  assert.match(user, /条目名称：夜/);
  assert.match(user, /月亮$/);
  assert.match(q.body.messages[0].content, /润色/);
});

test('API key 加密保存，界面拿不到明文', async () => {
  const raw = fs.readFileSync(path.join(tmp, 'ai.json'), 'utf8');
  assert.ok(!raw.includes('sk-secret-1'), 'ai.json 里不应有明文 key');
  const st = await ai.handle('ai.state');
  assert.equal(st.profiles[0].hasKey, true);
  assert.ok(!JSON.stringify(st).includes('sk-secret-1'));
});

test('提示词可以修改与恢复默认', async () => {
  let st = await ai.handle('ai.savePrompt', { action: 'polish', system: '自定义系统', user: '只要：{{text}}|{{instruction}}' });
  assert.equal(st.actions.find(a => a.id === 'polish').custom, true);
  reply = () => sse(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n']);
  const r = await ai.handle('ai.run', { action: 'polish', text: '原文' });
  await finish(r.id);
  const q = requests.at(-1);
  assert.equal(q.body.messages[0].content, '自定义系统');
  assert.equal(q.body.messages[1].content, '只要：原文|（无）');
  st = await ai.handle('ai.resetPrompt', { action: 'polish' });
  assert.equal(st.actions.find(a => a.id === 'polish').custom, false);
  assert.match(st.actions.find(a => a.id === 'polish').system, /润色/);
});

test('代写与修改需要写下要求；没有接口时提示设置', async () => {
  assert.match((await ai.handle('ai.run', { action: 'write', text: '' })).error, /要求/);
  assert.match((await ai.handle('ai.run', { action: 'polish', text: '  ' })).error, /没有要处理的文字/);
  assert.match((await ai.handle('ai.run', { action: 'polish', text: 'x'.repeat(400_001) })).error, /太长/);
  assert.match((await ai.handle('ai.run', { profile: 'nope', action: 'polish', text: 'x' })).error, /还没有设置 AI 接口/);
});

test('Anthropic：官方 SDK、服务端回退、effort，不发送温度', async () => {
  const id = await save({ name: 'Claude', type: 'anthropic', base: 'https://api.anthropic.com', model: 'claude-opus-5-5', effort: 'high', temperature: 1 }, 'sk-ant-test');
  reply = () => sse([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"审查"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"完成"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  const r = await ai.handle('ai.run', { profile: id, action: 'review', text: '<% if (x) { %>' });
  const { end } = await finish(r.id);
  assert.equal(end.type, 'done', end.error);
  assert.equal(end.text, '审查完成');
  const q = requests.at(-1);
  assert.match(q.url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.equal(headerOf(q.init, 'x-api-key'), 'sk-ant-test');
  assert.match(headerOf(q.init, 'anthropic-beta') || '', /server-side-fallback-2026-07-01/);
  assert.equal(q.body.fallbacks, 'default');
  assert.equal(q.body.model, 'claude-opus-5-5');
  assert.equal(q.body.stream, true);
  assert.equal(q.body.max_tokens, 64000);
  assert.deepEqual(q.body.output_config, { effort: 'high' });
  assert.equal('temperature' in q.body, false);
  assert.match(q.body.system, /审查/);
});

test('Anthropic：中转地址不加回退参数；拒绝时报错', async () => {
  const id = await save({ name: '中转', type: 'anthropic', base: 'https://relay.example.com', model: 'claude-opus-5-5' }, 'k');
  reply = () => sse([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_sequence":null},"usage":{"output_tokens":0}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  const r = await ai.handle('ai.run', { profile: id, action: 'polish', text: '文字' });
  const { end } = await finish(r.id);
  assert.equal(end.type, 'error');
  assert.match(end.error, /拒绝/);
  const q = requests.at(-1);
  assert.match(q.url, /^https:\/\/relay\.example\.com\/v1\/messages/);
  assert.equal('fallbacks' in q.body, false);
  assert.ok(!/server-side-fallback/.test(headerOf(q.init, 'anthropic-beta') || ''));
});

test('Anthropic：401 给出中文提示', async () => {
  const id = await save({ name: '坏 key', type: 'anthropic', base: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' }, 'bad');
  reply = () => json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
  const r = await ai.handle('ai.run', { profile: id, action: 'polish', text: '文字' });
  const { end } = await finish(r.id);
  assert.equal(end.type, 'error');
  assert.match(end.error, /401/);
});

test('Gemini：流式输出，跳过思考内容', async () => {
  const id = await save({ name: 'G', type: 'gemini', base: 'https://generativelanguage.googleapis.com', model: 'gemini-pro' }, 'g-key');
  reply = () => sse(['data: {"candidates":[{"content":{"parts":[{"text":"想","thought":true},{"text":"写"}]}}]}\r\n\r\n', 'data: {"candidates":[{"content":{"parts":[{"text":"好"}]},"finishReason":"STOP"}]}\r\n\r\n']);
  const r = await ai.handle('ai.run', { profile: id, action: 'write', text: '', instruction: '写点什么' });
  const { end } = await finish(r.id);
  assert.equal(end.text, '写好');
  const q = requests.at(-1);
  assert.equal(q.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent?alt=sse');
  assert.equal(headerOf(q.init, 'x-goog-api-key'), 'g-key');
  assert.match(q.body.systemInstruction.parts[0].text, /代写|写出/);
});

test('HTTP 错误与停止', async () => {
  const id = await save({ name: 'O', type: 'compat', base: 'https://x.test/v1', model: 'm' }, 'k');
  reply = () => json({ error: { message: 'model not found' } }, 404);
  let r = await ai.handle('ai.run', { profile: id, action: 'polish', text: 'a' });
  let { end } = await finish(r.id);
  assert.match(end.error, /404.*模型名称不对.*model not found/);
  // 一直不结束的流：停止后报“已停止”
  reply = (u, init) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"半"}}]}\n\n')); init.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))); } }), { status: 200 });
  r = await ai.handle('ai.run', { profile: id, action: 'polish', text: 'a' });
  await new Promise(res => setTimeout(res, 50));
  await ai.handle('ai.cancel', { id: r.id });
  ({ end } = await finish(r.id));
  assert.equal(end.type, 'error');
  assert.equal(end.error, '已停止');
});

test('获取模型列表', async () => {
  const st = await ai.handle('ai.state');
  const o = st.profiles.find(p => p.name === 'DS');
  reply = () => json({ data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }] });
  const r = await ai.handle('ai.models', { id: o.id });
  assert.deepEqual(r.models, ['deepseek-chat', 'deepseek-reasoner']);
  assert.equal(headerOf(requests.at(-1).init, 'authorization'), 'Bearer sk-secret-1');
});

test('整个作品整理成文字，供 AI 审查', async () => {
  core.init({ dataDir: path.join(tmp, 'core'), rwkitCandidates: () => [{ file: path.join(ROOT, 'resources', 'rwkit.mjs'), bundled: true }], emit: () => {}, log: () => {} });
  const r = await core.handle('action', { action: 'new', opts: { name: '审查测试', category: 'extension', dir: tmp } });
  assert.equal(r.ok, true, r.error);
  const t = await core.handle('aiText', { path: r.result.dir });
  assert.equal(t.ok, true, t.error);
  assert.match(t.text, /^# 作品：审查测试（扩展）/);
  assert.match(t.text, /## .+（世界书）/);
  assert.match(t.text, /### 条目 /);
});

test('OpenAI 官方：Responses API、思考深度、不保存对话', async () => {
  const id = await save({ name: 'OpenAI', type: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-x', effort: 'high', maxTokens: 9000 }, 'sk-oa');
  reply = () => sse([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"r1","status":"in_progress"}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"润"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"色"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n',
  ]);
  const r = await ai.handle('ai.run', { profile: id, action: 'polish', text: '原文' });
  const { end } = await finish(r.id);
  assert.equal(end.type, 'done', end.error);
  assert.equal(end.text, '润色');
  const q = requests.at(-1);
  assert.equal(q.url, 'https://api.openai.com/v1/responses');
  assert.equal(headerOf(q.init, 'authorization'), 'Bearer sk-oa');
  assert.match(q.body.instructions, /润色/);
  assert.equal(q.body.input[0].role, 'user');
  assert.match(q.body.input[0].content, /原文/);
  assert.equal(q.body.store, false);
  assert.equal(q.body.stream, true);
  assert.deepEqual(q.body.reasoning, { effort: 'high' });
  assert.equal(q.body.max_output_tokens, 9000);
  assert.equal('messages' in q.body, false);
  assert.equal('temperature' in q.body, false);
});

test('OpenAI 官方：拒绝、输出被截断、模型列表只留文字模型', async () => {
  const st = await ai.handle('ai.state');
  const id = st.profiles.find(p => p.name === 'OpenAI').id;
  reply = () => sse(['data: {"type":"response.refusal.delta","delta":"不能帮忙"}\n\n', 'data: {"type":"response.completed","response":{}}\n\n']);
  let r = await ai.handle('ai.run', { profile: id, action: 'polish', text: 'a' });
  let { end } = await finish(r.id);
  assert.equal(end.type, 'error');
  assert.match(end.error, /拒绝.*不能帮忙/);
  reply = () => sse(['data: {"type":"response.output_text.delta","delta":"半截"}\n\n', 'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n']);
  r = await ai.handle('ai.run', { profile: id, action: 'polish', text: 'a' });
  ({ end } = await finish(r.id));
  assert.equal(end.type, 'done');
  assert.equal(end.stop, 'max_tokens');
  reply = () => json({ data: [{ id: 'gpt-x' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'gpt-y' }, { id: 'tts-1' }] });
  const m = await ai.handle('ai.models', { id });
  assert.deepEqual(m.models, ['gpt-x', 'gpt-y']);
});

test('Gemini：被安全设置拦截时说明原因', async () => {
  const st = await ai.handle('ai.state');
  const id = st.profiles.find(p => p.type === 'gemini').id;
  reply = () => sse(['data: {"promptFeedback":{"blockReason":"PROHIBITED_CONTENT"}}\n\n']);
  const r = await ai.handle('ai.run', { profile: id, action: 'polish', text: 'a' });
  const { end } = await finish(r.id);
  assert.equal(end.type, 'error');
  assert.match(end.error, /Gemini 拦截.*PROHIBITED_CONTENT/);
});

test('思考深度按接口类型校验；兼容接口可以不填 key', async () => {
  const id = await save({ name: '本机', type: 'compat', base: 'http://127.0.0.1:11434/v1', model: 'qwen', effort: 'max' });
  const st = await ai.handle('ai.state');
  const p = st.profiles.find(x => x.id === id);
  assert.equal(p.effort, '', '兼容接口没有思考深度设置');
  assert.equal(p.hasKey, false);
  reply = () => sse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']);
  const r = await ai.handle('ai.run', { profile: id, action: 'polish', text: 'a' });
  const { end } = await finish(r.id);
  assert.equal(end.text, 'ok');
  assert.equal(headerOf(requests.at(-1).init, 'authorization'), undefined);
  assert.ok(st.efforts.openai.includes('xhigh') && st.efforts.anthropic.includes('max') && !st.efforts.compat);
});

test('完整对话：开头的 system 成为系统提示词，其余按接口要求整理', async () => {
  const msgs = [{ role: 'system', content: '设定' }, { role: 'system', content: [{ type: 'text', text: '规则' }] }, { role: 'assistant', content: '开场白' }, { role: 'user', content: '你好' }, { role: 'system', content: '提醒' }, { role: 'assistant', content: '前文' }];
  // OpenAI 兼容：原样保留中途的 system
  const st = await ai.handle('ai.state');
  const compat = st.profiles.find(p => p.name === 'DS').id;
  reply = () => sse(['data: {"choices":[{"delta":{"content":"回"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"复"},"finish_reason":"stop"}]}\n\n']);
  let text = '';
  const r = await ai.chat({ profile: compat, messages: msgs, maxTokens: 300, temperature: 0.9, onText: d => { text += d; } });
  assert.equal(text, '回复');
  assert.equal(r.stop, 'stop');
  let q = requests.at(-1).body;
  assert.deepEqual(q.messages.map(m => m.role), ['system', 'assistant', 'user', 'system', 'assistant']);
  assert.equal(q.messages[0].content, '设定\n\n规则');
  assert.equal(q.max_tokens, 300);
  assert.equal(q.temperature, 0.7, '接口设置里的温度优先');
  // Anthropic：以 user 开头和结尾、角色交替，思考需要的输出长度至少 16000
  const claude = st.profiles.find(p => p.name === 'Claude').id;
  reply = () => sse([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  await ai.chat({ profile: claude, messages: msgs, maxTokens: 300 });
  q = requests.at(-1).body;
  assert.equal(q.system, '设定\n\n规则');
  assert.deepEqual(q.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(q.messages[2].content, '你好\n\n[系统] 提醒');
  assert.equal(q.max_tokens, 16000);
  assert.equal('temperature' in q, false);
  // 没有 key 时说明原因
  const bare = await save({ name: '无 key', type: 'gemini', base: 'https://generativelanguage.googleapis.com', model: 'g' });
  await assert.rejects(ai.chat({ profile: bare, messages: msgs }), /还没有填写 API key/);
});
