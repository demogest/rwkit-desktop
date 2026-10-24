// AI 帮写：用户自己配置的接口（OpenAI 兼容 / Anthropic / Google Gemini），润色、代写、修改、审查，提示词可以修改。
// 请求都在主进程里发出，API key 用系统加密保存，不交给界面。与 Electron 无关，可单独测试。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
class UserError extends Error {}
const fail = msg => { throw new UserError(msg); };
const MAX_INPUT = 400_000;   // 一次发送的文字上限（字符）

const env = { dataDir: '', encrypt: null, decrypt: null, fetch: (...a) => globalThis.fetch(...a), log: () => {}, emit: () => {} };
const store = { active: '', profiles: [], prompts: {} };
const file = () => path.join(env.dataDir, 'ai.json');
function save() {
  try { fs.mkdirSync(env.dataDir, { recursive: true }); fs.writeFileSync(file() + '.tmp', JSON.stringify(store, null, 1)); fs.renameSync(file() + '.tmp', file()); }
  catch (e) { env.log('保存 AI 设置失败：' + e.message); }
}
export function init(options) {
  Object.assign(env, options);
  try {
    const s = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (Array.isArray(s.profiles)) store.profiles = s.profiles.filter(isObj);
    if (typeof s.active === 'string') store.active = s.active;
    if (isObj(s.prompts)) store.prompts = s.prompts;
  } catch {}
}
const seal = k => (env.encrypt ? (() => { try { return { enc: env.encrypt(k) }; } catch { return { plain: k }; } })() : { plain: k });
const unseal = k => { if (k?.enc && env.decrypt) { try { return env.decrypt(k.enc); } catch { return ''; } } return typeof k?.plain === 'string' ? k.plain : ''; };

// ---------- 接口类型与预设 ----------
// openai：OpenAI 官方的 Responses API；compat：各家兼容 OpenAI 的 chat/completions 接口
export const PROVIDERS = {
  openai: { label: 'OpenAI', base: 'https://api.openai.com/v1' },
  compat: { label: 'OpenAI 兼容接口', base: '' },
  anthropic: { label: 'Anthropic Claude', base: 'https://api.anthropic.com', model: 'claude-opus-5-5' },
  gemini: { label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com' },
};
export const PRESETS = [
  { name: 'OpenAI', type: 'openai', base: 'https://api.openai.com/v1', model: '' },
  { name: 'Google Gemini', type: 'gemini', base: 'https://generativelanguage.googleapis.com', model: '' },
  { name: 'Anthropic Claude', type: 'anthropic', base: 'https://api.anthropic.com', model: 'claude-opus-5-5' },
  { name: 'DeepSeek', type: 'compat', base: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { name: 'OpenRouter', type: 'compat', base: 'https://openrouter.ai/api/v1', model: '' },
  { name: '硅基流动', type: 'compat', base: 'https://api.siliconflow.cn/v1', model: '' },
  { name: 'Ollama（本机）', type: 'compat', base: 'http://127.0.0.1:11434/v1', model: '' },
  { name: '其他 OpenAI 兼容接口', type: 'compat', base: '', model: '' },
];
// 各接口可选的思考深度（留空表示不发送，由接口决定）
export const EFFORTS = { openai: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], anthropic: ['low', 'medium', 'high', 'xhigh', 'max'] };

// ---------- 提示词（可以在设置里修改，恢复默认即用下面的） ----------
const COMMON = `你是“轮回战场”（SillyTavern 角色卡）创意工坊作品的写作助手，熟悉世界书、正则、酒馆助手脚本、MVU 变量与 EJS 模板。
始终使用简体中文。必须原样保留文本里的各种标记与结构：EJS 标签（<% %>、<%= %>）、酒馆宏（{{user}}、{{char}}、{{getvar::…}} 等）、XML/HTML 标签、YAML/JSON 结构与键名、变量路径（如 stat_data.角色.HP）、Markdown 与换行格式。`;
export const ACTIONS = [
  {
    id: 'polish', label: '润色', desc: '保持原意，改善措辞、节奏与可读性',
    system: COMMON + '\n任务：润色给定的文本。保持原意、设定与信息不变，不增删情节与设定；改善措辞、节奏、画面感与可读性，统一文风。只输出润色后的完整文本，不要任何解释、标题或代码块包裹。',
    user: '【位置】{{field}}\n【作品】{{project}}\n{{context}}\n【额外要求】{{instruction}}\n\n【原文】\n{{text}}',
  },
  {
    id: 'write', label: '代写', desc: '按要求写出新的内容',
    system: COMMON + '\n任务：按照作者的要求，为指定位置写出内容。符合轮回战场的世界观与文风，条理清楚，可以直接使用。只输出要写入的内容本身，不要解释、不要代码块包裹。',
    user: '【位置】{{field}}\n【作品】{{project}}\n{{context}}\n【要求】{{instruction}}\n\n【现有内容（可参考，可能为空）】\n{{text}}',
  },
  {
    id: 'modify', label: '修改', desc: '按你的要求修改，其他部分不变',
    system: COMMON + '\n任务：按照作者的要求修改原文。只改要求涉及的地方，其他部分逐字保持不变。只输出修改后的完整文本，不要解释、不要代码块包裹。',
    user: '【位置】{{field}}\n【作品】{{project}}\n{{context}}\n【修改要求】{{instruction}}\n\n【原文】\n{{text}}',
  },
  {
    id: 'review', label: '审查', desc: '指出问题并给出修改建议（不改原文）',
    system: COMMON + `\n任务：审查给定内容，找出问题并给出具体的修改建议。重点关注：设定矛盾与逻辑漏洞；错别字与病句；标记是否配对、格式是否正确（EJS、宏、标签、YAML/JSON）；世界书的触发问题（关键词过宽或过窄、不该常驻的常驻）；正则能否匹配、替换结果是否正确；脚本的错误、兼容性与风险；与轮回战场 MVU 变量的一致性。
按严重程度从高到低列出，每条写清楚位置（引用原文片段）、问题和建议。没有问题时直接说明。用 Markdown 输出。`,
    user: '【位置】{{field}}\n【作品】{{project}}\n{{context}}\n【关注点】{{instruction}}\n\n【内容】\n{{text}}',
  },
];
export const VARS = [['text', '要处理的文字（选中的部分或全文）'], ['instruction', '你在帮写窗口里填写的要求'], ['field', '所在位置，例如“世界书条目正文”'], ['project', '作品名称与简介'], ['context', '所在条目的名称、关键词等补充信息']];
function promptsOf(id) {
  const base = ACTIONS.find(a => a.id === id);
  if (!base) fail('不认识的操作：' + id);
  const o = store.prompts[id] || {};
  return { system: typeof o.system === 'string' ? o.system : base.system, user: typeof o.user === 'string' ? o.user : base.user };
}
const fill = (tpl, v) => tpl.replace(/\{\{(text|instruction|field|project|context)\}\}/g, (_, k) => String(v[k] ?? '').trim() || (k === 'instruction' ? '（无）' : ''));

// ---------- 配置 ----------
const pub = p => ({ id: p.id, name: p.name, type: p.type, base: p.base, model: p.model, maxTokens: p.maxTokens || null, temperature: p.temperature ?? null, effort: p.effort || '', hasKey: !!unseal(p.key) });
export function state() {
  return {
    active: store.active, profiles: store.profiles.map(pub), providers: PROVIDERS, presets: PRESETS, efforts: EFFORTS, vars: VARS,
    actions: ACTIONS.map(a => ({ id: a.id, label: a.label, desc: a.desc, ...promptsOf(a.id), custom: !!store.prompts[a.id], defaults: { system: a.system, user: a.user } })),
  };
}
const profileOf = id => store.profiles.find(p => p.id === (id || store.active)) || null;
function checkProfile(p) {
  if (!PROVIDERS[p.type]) fail('接口类型无效');
  if (!/^https?:\/\/\S+$/.test(p.base || '')) fail('接口地址应以 http:// 或 https:// 开头');
  if (!String(p.model || '').trim()) fail('请填写模型名称（可以点“获取模型列表”）');
}

// ---------- 调用 ----------
const trimSlash = s => String(s || '').replace(/\/+$/, '');
async function readSSE(res, onData, signal) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    if (signal?.aborted) break;
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { onData(JSON.parse(data)); } catch {}
    }
  }
}
async function httpError(r, who) {
  let msg = '';
  try { const j = await r.json(); msg = j.error?.message || j.message || j.error || ''; } catch {}
  const hint = r.status === 401 || r.status === 403 ? '（API key 无效或没有权限）' : r.status === 404 ? '（接口地址或模型名称不对）' : r.status === 429 ? '（请求太频繁或额度不足）' : '';
  return new UserError(`${who} 返回 ${r.status}${hint}${msg ? '：' + String(msg).slice(0, 300) : ''}`);
}
// 一次请求：system 为系统提示词，messages 为对话（user / assistant，中途的 system 也可以有）
// maxTokens、temperature 是调用方的建议值，接口设置里填了的以设置为准
const tempOf = (p, q) => (p.temperature != null && p.temperature !== '' ? Number(p.temperature) : q.temperature != null ? Number(q.temperature) : undefined);
// 需要 user / assistant 交替的接口：中途的 system 并入 user，连续同角色合并，必须以 user 开头和结尾
function alternate(messages, assistant = 'assistant') {
  const out = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? assistant : 'user';
    const text = m.role === 'system' ? '[系统] ' + m.content : m.content;
    if (!text) continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n\n' + text;
    else out.push({ role, content: text });
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: '（开始）' });
  if (out[out.length - 1].role !== 'user') out.push({ role: 'user', content: '（继续）' });
  return out;
}
// OpenAI 官方：Responses API（推理模型用 max_output_tokens 与 reasoning.effort）；不在 OpenAI 保存对话（store: false）
async function runOpenAI(p, key, q, onText, signal) {
  const body = { model: p.model, input: q.messages.map(m => ({ role: m.role === 'system' ? 'developer' : m.role, content: m.content })), stream: true, store: false };
  if (q.system) body.instructions = q.system;
  const max = Number(p.maxTokens) || Number(q.maxTokens);
  if (max) body.max_output_tokens = max;
  if (p.effort) body.reasoning = { effort: p.effort };
  if (p.temperature != null && p.temperature !== '') body.temperature = Number(p.temperature);
  const r = await env.fetch(trimSlash(p.base) + '/responses', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body) });
  if (!r.ok) throw await httpError(r, 'OpenAI');
  let stop = '', err = '', refusal = '', got = false;
  await readSSE(r, d => {
    if (d.type === 'response.output_text.delta' && d.delta) { got = true; onText(d.delta); }
    else if (d.type === 'response.refusal.delta' && d.delta) refusal += d.delta;
    else if (d.type === 'response.completed') stop = 'stop';
    else if (d.type === 'response.incomplete') { const why = d.response?.incomplete_details?.reason || 'incomplete'; stop = why === 'max_output_tokens' ? 'max_tokens' : why; }
    else if (d.type === 'response.failed') err = d.response?.error?.message || '请求失败';
    else if (d.type === 'error') err = d.message || d.error?.message || '请求失败';
  }, signal);
  if (err) fail('OpenAI 返回错误：' + String(err).slice(0, 300));
  if (refusal && !got) fail('模型拒绝了这个请求：' + refusal.slice(0, 300));
  if (stop === 'content_filter' && !got) fail('OpenAI 的内容过滤拦截了这个请求');
  return { stop };
}
// OpenAI 兼容（DeepSeek、OpenRouter、硅基流动、Ollama……）
async function runCompat(p, key, q, onText, signal) {
  const body = { model: p.model, messages: [...(q.system ? [{ role: 'system', content: q.system }] : []), ...q.messages], stream: true };
  const max = Number(p.maxTokens) || Number(q.maxTokens);
  if (max) body.max_tokens = max;
  const t = tempOf(p, q);
  if (t !== undefined) body.temperature = t;
  const r = await env.fetch(trimSlash(p.base) + '/chat/completions', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body) });
  if (!r.ok) throw await httpError(r, '接口');
  let stop = '';
  await readSSE(r, d => { const c = d.choices?.[0]; if (c?.delta?.content) onText(c.delta.content); if (c?.finish_reason) stop = c.finish_reason; }, signal);
  return { stop };
}
// Anthropic：官方 SDK，流式读取文字增量
const FALLBACK_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];
function anthropicClient(p, key) {
  const base = trimSlash(p.base);
  return new Anthropic({ apiKey: key, ...(base && base !== 'https://api.anthropic.com' ? { baseURL: base } : {}), maxRetries: 1, fetch: (...a) => env.fetch(...a) });
}
async function runAnthropic(p, key, q, onText, signal) {
  const client = anthropicClient(p, key);
  const official = !trimSlash(p.base) || trimSlash(p.base) === 'https://api.anthropic.com';
  // 当前模型不接受 temperature；思考由模型自行决定，深度用 effort 控制（5 系列）
  // 思考也占输出长度：调用方给的上限太小时至少留 16000
  const max = Number(p.maxTokens) || (q.maxTokens ? Math.max(Number(q.maxTokens), /^claude-3/.test(p.model) ? 0 : 16000) : /^claude-3/.test(p.model) ? 8192 : 64000);
  const params = { model: p.model, max_tokens: max, messages: alternate(q.messages) };
  if (q.system) params.system = q.system;
  if (/^claude-(opus|sonnet|haiku|fable|mythos)-[5-9]/.test(p.model)) params.output_config = { effort: p.effort || 'medium' };
  // 支持的模型在官方接口上开启服务端回退：被安全策略拒绝时由服务器自动换模型重试
  const stream = official && FALLBACK_MODELS.includes(p.model)
    ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
    : client.messages.stream(params, { signal });
  try {
    for await (const ev of stream) if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') onText(ev.delta.text);
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') fail('模型拒绝了这个请求' + (msg.stop_details?.explanation ? '：' + msg.stop_details.explanation : ''));
    return { stop: msg.stop_reason };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) fail('Anthropic 返回 401（API key 无效）');
    if (e instanceof Anthropic.PermissionDeniedError) fail('Anthropic 返回 403（没有权限使用这个模型）');
    if (e instanceof Anthropic.NotFoundError) fail('Anthropic 返回 404（模型名称不对）');
    if (e instanceof Anthropic.RateLimitError) fail('Anthropic 返回 429（请求太频繁或额度不足）');
    if (e instanceof Anthropic.BadRequestError) fail('Anthropic 返回 400：' + e.message);
    if (e instanceof Anthropic.APIConnectionError) fail('无法连接 Anthropic：' + e.message);
    throw e;
  }
}
// Google Gemini
async function runGemini(p, key, q, onText, signal) {
  const gen = {};
  const max = Number(p.maxTokens) || Number(q.maxTokens);
  if (max) gen.maxOutputTokens = max;
  const t = tempOf(p, q);
  if (t !== undefined) gen.temperature = t;
  const url = `${trimSlash(p.base)}/v1beta/models/${encodeURIComponent(p.model)}:streamGenerateContent?alt=sse`;
  const r = await env.fetch(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ ...(q.system ? { systemInstruction: { parts: [{ text: q.system }] } } : {}), contents: alternate(q.messages, 'model').map(m => ({ role: m.role, parts: [{ text: m.content }] })), ...(Object.keys(gen).length ? { generationConfig: gen } : {}) }) });
  if (!r.ok) throw await httpError(r, 'Gemini');
  let stop = '', blocked = '', got = false;
  await readSSE(r, d => {
    if (d.promptFeedback?.blockReason) blocked = d.promptFeedback.blockReason;
    const c = d.candidates?.[0];
    for (const part of c?.content?.parts || []) if (part.text && !part.thought) { got = true; onText(part.text); }
    if (c?.finishReason) stop = c.finishReason;
  }, signal);
  // 被安全设置拦截时没有任何文字，说明原因
  if (!got && (blocked || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY'].includes(stop))) fail(`Gemini 拦截了这个请求（${blocked || stop}）`);
  return { stop };
}
const RUNNERS = { openai: runOpenAI, compat: runCompat, anthropic: runAnthropic, gemini: runGemini };
// OpenAI 的模型列表里还有向量、语音、图像等模型，只留下能写文字的
const NOT_TEXT = /embedding|tts|whisper|dall-e|gpt-image|moderation|transcribe|audio|realtime|search|davinci|babbage|sora/i;

async function listModels(p, key) {
  if (p.type === 'anthropic') { const ids = []; for await (const m of anthropicClient(p, key).models.list()) ids.push(m.id); return ids; }
  if (p.type === 'gemini') {
    const r = await env.fetch(`${trimSlash(p.base)}/v1beta/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    if (!r.ok) throw await httpError(r, 'Gemini');
    const j = await r.json();
    return (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => String(m.name).replace(/^models\//, ''));
  }
  const r = await env.fetch(trimSlash(p.base) + '/models', { headers: key ? { Authorization: 'Bearer ' + key } : {} });
  if (!r.ok) throw await httpError(r, p.type === 'openai' ? 'OpenAI' : '接口');
  const j = await r.json();
  const ids = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean).sort();
  return p.type === 'openai' ? ids.filter(id => !NOT_TEXT.test(id)) : ids;
}

// 一段完整的对话（例如模拟酒馆里 SillyTavern 组好的提示词）：流式返回文字，出错时抛出能看懂的说明
const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (typeof x === 'string' ? x : x?.type === 'text' || x?.text ? x.text || '' : '')).join('') : String(c ?? ''));
export async function chat({ profile, messages, maxTokens, temperature, signal, onText = () => {} }) {
  const p = profileOf(profile);
  if (!p) fail('没有找到这个 AI 接口，请在 rwkit 的“AI 帮写设置”里检查');
  checkProfile(p);
  const key = unseal(p.key);
  if (!key && p.type !== 'compat') fail(`接口“${p.name}”还没有填写 API key`);
  const list = (Array.isArray(messages) ? messages : []).map(m => ({ role: ['system', 'assistant', 'user'].includes(m?.role) ? m.role : 'user', content: textOf(m?.content) })).filter(m => m.content);
  // 开头连续的 system 合成系统提示词，其余按顺序发送
  let i = 0;
  const sys = [];
  while (i < list.length && list[i].role === 'system') sys.push(list[i++].content);
  const q = { system: sys.join('\n\n'), messages: list.slice(i), maxTokens, temperature };
  if (!q.messages.length) q.messages.push({ role: 'user', content: '（开始）' });
  try { return await RUNNERS[p.type](p, key, q, onText, signal); }
  catch (e) {
    if (e instanceof UserError || signal?.aborted) throw e;
    if (e.name === 'TypeError') fail('无法连接接口：' + (e.cause?.code || e.message));
    env.log('AI 请求失败：' + (e.stack || e));
    throw e;
  }
}
export const profiles = () => ({ active: store.active, list: store.profiles.map(p => ({ id: p.id, name: p.name, model: p.model, type: p.type })) });

// 一次帮写：流式把文字发给界面（事件 ai），结束时给出完整结果
const jobs = new Map();
function start(b) {
  const p = profileOf(b.profile);
  if (!p) fail('还没有设置 AI 接口：请先在“AI 帮写设置”里添加');
  checkProfile(p);
  const key = unseal(p.key);
  if (!key && p.type !== 'compat') fail('这个接口还没有填写 API key');
  const t = promptsOf(b.action);
  const vars = { text: b.text, instruction: b.instruction, field: b.field, project: b.project, context: b.context };
  const sys = t.system, user = fill(t.user, vars);
  if (sys.length + user.length > MAX_INPUT) fail(`内容太长（${(sys.length + user.length).toLocaleString()} 字），请只选中一部分再试`);
  if (b.action !== 'write' && !String(b.text || '').trim()) fail('没有要处理的文字');
  if ((b.action === 'write' || b.action === 'modify') && !String(b.instruction || '').trim()) fail('请写下要求');
  const id = crypto.randomUUID(), ctl = new AbortController();
  let text = '';
  const job = { ctl, done: null };
  jobs.set(id, job);
  job.done = RUNNERS[p.type](p, key, { system: sys, messages: [{ role: 'user', content: user }] }, d => { text += d; env.emit('ai', { id, type: 'delta', text: d }); }, ctl.signal)
    .then(r => { env.emit('ai', { id, type: 'done', text, stop: r.stop || '' }); return { ok: true, text, stop: r.stop }; })
    .catch(e => {
      const msg = ctl.signal.aborted ? '已停止' : e instanceof UserError ? e.message : e.name === 'TypeError' ? '无法连接接口：' + (e.cause?.code || e.message) : String(e.message || e);
      if (!(e instanceof UserError) && !ctl.signal.aborted) env.log('AI 请求失败：' + (e.stack || e));
      env.emit('ai', { id, type: 'error', error: msg, text });
      return { ok: false, error: msg, text };
    })
    .finally(() => setTimeout(() => jobs.delete(id), 60000).unref?.());
  return { ok: true, id };
}

export async function handle(route, b = {}) {
  try {
    switch (route) {
      case 'ai.state': return state();
      case 'ai.saveProfile': {
        const src = isObj(b.profile) ? b.profile : {};
        const old = src.id ? store.profiles.find(p => p.id === src.id) : null;
        const p = {
          id: old?.id || crypto.randomUUID(), name: String(src.name || PROVIDERS[src.type]?.label || '接口').trim().slice(0, 40),
          type: src.type, base: trimSlash(src.base), model: String(src.model || '').trim(),
          maxTokens: Number(src.maxTokens) > 0 ? Math.min(200000, Number(src.maxTokens)) : null,
          temperature: src.temperature === '' || src.temperature == null ? null : Math.max(0, Math.min(2, Number(src.temperature))),
          effort: (EFFORTS[src.type] || []).includes(src.effort) ? src.effort : '',
          key: typeof b.key === 'string' && b.key ? seal(b.key.trim()) : b.clearKey ? null : old?.key || null,
        };
        checkProfile(p);
        if (old) Object.assign(old, p); else store.profiles.push(p);
        if (!store.active || !profileOf()) store.active = p.id;
        save(); return { ...state(), saved: p.id };
      }
      case 'ai.deleteProfile': store.profiles = store.profiles.filter(p => p.id !== b.id); if (store.active === b.id) store.active = store.profiles[0]?.id || ''; save(); return state();
      case 'ai.setActive': if (profileOf(b.id)) { store.active = b.id; save(); } return state();
      case 'ai.models': {
        const old = b.id ? store.profiles.find(p => p.id === b.id) : null;
        const p = { ...(old || {}), ...(isObj(b.profile) ? b.profile : {}) };
        const key = typeof b.key === 'string' && b.key ? b.key.trim() : unseal(old?.key);
        if (!PROVIDERS[p.type]) fail('接口类型无效');
        return { ok: true, models: await listModels(p, key) };
      }
      case 'ai.test': {
        const r = start({ profile: b.id, action: 'modify', text: '好', instruction: '原样输出“好”这一个字', field: '连接测试' });
        const res = await jobs.get(r.id).done;
        return res.ok ? { ok: true, text: res.text.slice(0, 200) } : { ok: false, error: res.error };
      }
      case 'ai.savePrompt': {
        if (!ACTIONS.some(a => a.id === b.action)) fail('不认识的操作');
        store.prompts[b.action] = { system: String(b.system ?? ''), user: String(b.user ?? '') };
        save(); return state();
      }
      case 'ai.resetPrompt': delete store.prompts[b.action]; save(); return state();
      case 'ai.run': return start(b);
      case 'ai.cancel': jobs.get(b.id)?.ctl.abort(); return { ok: true };
    }
    fail('不认识的请求：' + route);
  } catch (e) {
    if (!(e instanceof UserError)) env.log(e.stack || String(e));
    return { ok: false, error: String(e.message || e) };
  }
}
