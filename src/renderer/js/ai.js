// AI 帮写：在编辑器、简介等位置润色、代写、修改、审查；接口与提示词在“AI 帮写设置”里配置
import { $, $$, esc, icon, toast, modal, ask, menu, copyText } from './util.js';
import { textDiff } from './diff.js';

let X = null;
const A = { st: null, jobs: new Map(), early: new Map() };
const api = (r, b) => X.api(r, b);
const apiOk = async (r, b) => { const v = await api(r, b); if (v?.ok === false) throw new Error(v.error); return v; };

export async function initAI(ctx) {
  X = ctx;
  try { A.st = await api('ai.state'); } catch {}
}
// 流式结果：先到的事件暂存，等界面登记了任务再交给它
export function onAIEvent(d) {
  if (!d?.id) return;
  const fn = A.jobs.get(d.id);
  if (fn) return fn(d);
  const q = A.early.get(d.id) || []; q.push(d); A.early.set(d.id, q);
  while (A.early.size > 20) A.early.delete(A.early.keys().next().value);
}
function listen(id, fn) {
  A.jobs.set(id, fn);
  const q = A.early.get(id); A.early.delete(id);
  for (const d of q || []) fn(d);
}
export const aiState = () => A.st;
const profileOf = id => A.st?.profiles.find(p => p.id === (id || A.st.active)) || null;

const ACT_ICON = { polish: 'sparkles', write: 'pencil', modify: 'wrench', review: 'search' };
const PH = {
  polish: '可选：额外要求，例如“更有画面感”“语气更冷峻”“压缩到 300 字以内”',
  write: '写什么？例如“写一个守在地下城入口的 NPC：外貌、性格、说话方式”',
  modify: '怎么改？例如“把所有的‘积分’改成‘点数’”“给这段脚本加上错误处理”',
  review: '可选：重点看什么，例如“EJS 标签是否配对”“关键词是不是太宽”',
};
const STOP_LONG = new Set(['max_tokens', 'length', 'MAX_TOKENS']);
// 模型偶尔会把结果包在代码块里：原文没有代码块时去掉
const unfence = (t, orig) => { const m = /^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(t); return m && !/^\s*```/.test(orig || '') ? m[1] : t; };

let markedMod = null;
async function md(text) {
  try {
    markedMod = markedMod || (await import('../vendor/marked.js')).marked;
    // 不渲染模型输出里的原始 HTML
    return markedMod.parse(text || '', { gfm: true, breaks: true, walkTokens: t => { if (t.type === 'html') t.text = esc(t.text); } });
  } catch { return `<pre>${esc(text)}</pre>`; }
}

// ---------- 编辑目标 ----------
// CodeMirror 编辑器
export function cmTarget(cm) {
  const v = cm.view;
  return {
    get: () => v.state.doc.toString(),
    sel: () => { const r = v.state.selection.main; return r.empty || (r.from === 0 && r.to === v.state.doc.length) ? null : { from: r.from, to: r.to }; },
    cursor: () => v.state.selection.main.head,
    replace: (from, to, text) => { v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true }); setTimeout(() => v.focus(), 60); },
  };
}
// 普通输入框（简介、更新说明等）：改完触发 input 事件，表单与字数统计照常更新
export function inputTarget(el) {
  return {
    get: () => el.value,
    sel: () => (el.selectionStart !== el.selectionEnd && !(el.selectionStart === 0 && el.selectionEnd === el.value.length) ? { from: el.selectionStart, to: el.selectionEnd } : null),
    cursor: () => el.selectionEnd ?? el.value.length,
    replace: (from, to, text) => { el.setRangeText(text, from, to, 'end'); el.dispatchEvent(new Event('input', { bubbles: true })); setTimeout(() => el.focus(), 60); },
    max: el.maxLength > 0 ? el.maxLength : 0,
  };
}
// 输入框里的“AI”小按钮
export const aiIn = field => `<button type="button" class="ai-in" data-ai-in data-ai-field="${esc(field)}" title="AI 帮写：润色、代写、修改、审查">${icon('sparkles')}AI</button>`;
document.addEventListener('click', e => {
  const b = e.target.closest('[data-ai-in]');
  if (!b || !X) return;
  e.preventDefault(); e.stopPropagation();
  const el = b.parentElement.querySelector('textarea, input');
  if (el) aiAssist({ field: b.dataset.aiField, target: inputTarget(el), context: b.dataset.aiContext || '' });
}, true);

const projectLine = () => { const p = X.curProject?.(); return p ? p.name + (p.summary ? '：' + String(p.summary).slice(0, 300) : '') : ''; };
const statusHtml = S => {
  if (S.state === 'running') return `<span class="spin sm"></span>正在生成…${S.out ? `（${S.out.length.toLocaleString()} 字）` : ''}`;
  if (S.state === 'error') return `<span class="bad">${icon('xCircle')}${esc(S.err)}</span>`;
  if (S.state === 'done') return `<span class="good">${icon('checkCircle')}完成 · ${S.out.length.toLocaleString()} 字</span>${STOP_LONG.has(S.stop) ? '<span class="warnt">　达到输出长度上限，结果可能不完整</span>' : ''}${S.over ? `<span class="warnt">　超过这里的 ${S.over} 字上限</span>` : ''}`;
  return '';
};

// ---------- 帮写窗口 ----------
// target 为 null 时只读（例如审查整个作品）
export function aiAssist({ field, target = null, text = '', context = '', project, action }) {
  if (!A.st) { toast('AI 帮写还没有准备好，请稍后再试', 'warn'); return; }
  const readonly = !target;
  const orig = readonly ? text : target.get();
  const sel = readonly ? null : target.sel(), cur = readonly ? 0 : target.cursor();
  const S = {
    action: action || (readonly ? 'review' : orig.trim() ? 'polish' : 'write'), scope: sel ? 'sel' : 'all', instr: '', out: '', input: '', state: 'idle', err: '', stop: '', job: null,
    profile: A.st.active, diff: false, over: 0,
  };
  const prj = project ?? projectLine();
  const acts = A.st.actions.filter(a => !readonly || a.id === 'review');
  const m = modal({
    cls: 'wide ai-modal', title: `${icon('sparkles')}<span>AI 帮写</span><span class="ai-where ell">${esc(field)}</span>`,
    body: '<div class="ai-body" data-ai="body"></div>', foot: '<div class="ai-foot" data-ai="foot"></div>',
    onClose: () => { if (S.state === 'running') api('ai.cancel', { id: S.job }); A.jobs.delete(S.job); },
  });
  const body = $('[data-ai="body"]', m.el), foot = $('[data-ai="foot"]', m.el);
  const selText = () => (sel ? orig.slice(sel.from, sel.to) : '');
  const isText = () => S.action !== 'review';

  const paint = () => {
    const ps = A.st.profiles;
    if (!ps.length) {
      body.innerHTML = `<div class="banner info">${icon('info')}<div class="bb"><div class="bt">还没有设置 AI 接口</div><div class="bs">支持 OpenAI 兼容接口（DeepSeek、OpenRouter、硅基流动、Ollama 等）、Anthropic Claude 与 Google Gemini。API key 用系统加密保存在本机，只发给你填写的接口地址。</div><div class="ba"><button class="btn primary sm" data-ai="settings">${icon('plus')}添加接口…</button></div></div></div>`;
      foot.innerHTML = '<div class="spacer"></div><button class="btn" data-m="close">关闭</button>';
      return;
    }
    const a = A.st.actions.find(x => x.id === S.action);
    const showScope = !readonly && sel && S.action !== 'write';
    body.innerHTML = `
      <div class="ai-top">
        ${readonly ? `<span class="pill acc">${icon('search')}审查</span>` : `<div class="seg" data-ai-act>${acts.map(x => `<button type="button" data-v="${x.id}" class="${x.id === S.action ? 'on' : ''}" title="${esc(x.desc)}">${icon(ACT_ICON[x.id] || 'sparkles', 'xs')}${esc(x.label)}</button>`).join('')}</div>`}
        <span class="muted small ell">${esc(a?.desc || '')}</span>
        <div class="grow"></div>
        <select class="input sm ai-prof" data-ai="profile" title="使用的接口">${ps.map(p => `<option value="${esc(p.id)}" ${p.id === S.profile ? 'selected' : ''}>${esc(p.name)} · ${esc(p.model)}</option>`).join('')}</select>
        <button class="btn ghost icon sm" data-ai="settings" title="接口与提示词设置">${icon('settings')}</button>
      </div>
      ${showScope ? `<div class="ai-scope"><span class="muted small">处理：</span><div class="seg sm" data-ai-scope>${[['sel', `选中的部分（${selText().length.toLocaleString()} 字）`], ['all', `全文（${orig.length.toLocaleString()} 字）`]].map(([v, t]) => `<button type="button" data-v="${v}" class="${S.scope === v ? 'on' : ''}">${t}</button>`).join('')}</div></div>` : ''}
      ${!readonly && !showScope && S.action !== 'write' ? `<div class="muted small">处理全文（${orig.length.toLocaleString()} 字）。只想处理一部分时，先在编辑器里选中再点 AI。</div>` : ''}
      ${readonly ? `<div class="muted small">将发送 ${orig.length.toLocaleString()} 字的内容给“${esc(profileOf(S.profile)?.name || '')}”。</div>` : ''}
      <div class="ai-instr"><textarea class="input" rows="2" data-ai="instr" placeholder="${esc(PH[S.action] || '')}" autofocus>${esc(S.instr)}</textarea>
        <div class="ai-run"><button class="btn primary" data-ai="run" ${S.state === 'running' ? 'hidden' : ''}>${icon(ACT_ICON[S.action] || 'sparkles')}${S.state === 'done' || S.state === 'error' ? '重新生成' : '开始'}<kbd>Ctrl+Enter</kbd></button><button class="btn" data-ai="stop" ${S.state === 'running' ? '' : 'hidden'}>${icon('x')}停止</button></div></div>
      <div class="ai-status small" data-ai="status">${statusHtml(S)}</div>
      <div class="ai-out-wrap" ${S.state === 'idle' ? 'hidden' : ''}>
        ${isText() ? `<div class="ai-out-h"><span class="muted small">结果可以直接修改后再使用</span><span class="grow"></span>${S.action !== 'write' ? `<label class="toggle sm"><input type="checkbox" data-ai="diff" ${S.diff ? 'checked' : ''}><span class="sw"></span><span>显示改动</span></label>` : ''}</div>
        <textarea class="input mono ai-out" data-ai="out" spellcheck="false" ${S.diff ? 'hidden' : ''}>${esc(S.out)}</textarea>
        <div class="dbody ai-diff" data-ai="diffview" ${S.diff ? '' : 'hidden'}></div>` : '<div class="md-body ai-md" data-ai="md"></div>'}
      </div>`;
    if (S.diff) $('[data-ai="diffview"]', body).innerHTML = textDiff(S.input, S.out);
    if (!isText() && S.out) md(S.out).then(h => { const el = $('[data-ai="md"]', body); if (el) el.innerHTML = h; });
    paintFoot();
  };
  const paintFoot = () => {
    if (!A.st.profiles.length) return;
    const ready = S.state === 'done' || (S.state === 'error' && S.out);
    let h = '<div class="spacer"></div>';
    if (ready && S.out) {
      h += `<button class="btn" data-ai="copy">${icon('copy')}复制</button>`;
      if (!readonly && isText()) {
        if (S.action === 'write') {
          h += orig.trim() ? `<button class="btn" data-ai="apply" data-mode="append">${icon('plus')}追加到末尾</button><button class="btn" data-ai="apply" data-mode="all">替换全文</button>` : '';
          h += `<button class="btn primary" data-ai="apply" data-mode="${orig.trim() ? 'insert' : 'all'}">${icon('check')}${orig.trim() ? '插入到光标处' : '使用'}</button>`;
        } else if (S.scope === 'sel' && sel) h += `<button class="btn primary" data-ai="apply" data-mode="sel">${icon('check')}替换选中的部分</button>`;
        else h += `<button class="btn primary" data-ai="apply" data-mode="all">${icon('check')}替换全文</button>`;
      }
      if (!readonly && !isText()) h += `<button class="btn primary" data-ai="fixby">${icon('wrench')}按审查意见修改</button>`;
    } else h += '<button class="btn" data-m="close">关闭</button>';
    foot.innerHTML = h;
  };
  // 流式输出：每帧最多刷新一次
  let raf = 0;
  const flush = () => {
    raf = 0;
    const st = $('[data-ai="status"]', body); if (st) st.innerHTML = statusHtml(S);
    if (isText()) {
      const o = $('[data-ai="out"]', body);
      if (o) { const atEnd = o.scrollTop + o.clientHeight >= o.scrollHeight - 30; o.value = S.out; if (atEnd) o.scrollTop = o.scrollHeight; }
      const dv = $('[data-ai="diffview"]', body); if (dv && S.diff) dv.innerHTML = textDiff(S.input, S.out);
    } else md(S.out).then(h => { const el = $('[data-ai="md"]', body); if (el) { const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 30; el.innerHTML = h; if (atEnd) el.scrollTop = el.scrollHeight; } });
  };
  const soon = () => { if (!raf) raf = requestAnimationFrame(flush); };

  const run = async () => {
    if (S.state === 'running') return;
    const full = readonly ? orig : target.get();
    S.input = S.action !== 'write' && S.scope === 'sel' && sel ? full.slice(sel.from, sel.to) : full;
    S.out = ''; S.err = ''; S.stop = ''; S.over = 0; S.state = 'running';
    const r = await api('ai.run', { profile: S.profile, action: S.action, text: S.input, instruction: S.instr, field, project: prj, context });
    if (m.closed) { if (r?.id) api('ai.cancel', { id: r.id }); return; }
    if (!r || r.ok === false) { S.state = 'error'; S.err = r?.error || '请求失败'; paint(); return; }
    if (S.job) A.jobs.delete(S.job);
    S.job = r.id;
    paint();
    listen(r.id, d => {
      if (d.id !== S.job) return;
      if (d.type === 'delta') { S.out += d.text; soon(); return; }
      if (d.type === 'done') { S.state = 'done'; S.stop = d.stop || ''; if (isText()) S.out = unfence(d.text, S.input); }
      if (d.type === 'error') { S.state = 'error'; S.err = d.error; S.out = d.text || S.out; }
      if (!readonly && target.max && isText()) {
        const next = applied(S.action === 'write' ? (orig.trim() ? 'insert' : 'all') : S.scope === 'sel' && sel ? 'sel' : 'all');
        S.over = next.length > target.max ? target.max : 0;
      }
      A.jobs.delete(d.id);
      cancelAnimationFrame(raf); raf = 0;
      paint();
    });
  };
  // 写入后的完整文字（用来检查字数上限）
  const applied = mode => {
    const out = S.out;
    if (mode === 'sel') return orig.slice(0, sel.from) + out + orig.slice(sel.to);
    if (mode === 'insert') return orig.slice(0, cur) + out + orig.slice(cur);
    if (mode === 'append') return orig + (orig && !orig.endsWith('\n') ? '\n' : '') + out;
    return out;
  };
  const apply = async mode => {
    const out = S.out;
    if (target.get() !== orig) {
      const v = await ask({ title: '原文已经变了', html: '<p>打开帮写窗口之后，原文有改动。仍然按打开时的位置写入？</p>', buttons: [{ label: '取消', value: null }, { label: '复制结果', value: 'copy' }, { label: '仍然写入', value: 'ok', primary: true }] });
      if (v === 'copy') { copyText(out); return; }
      if (v !== 'ok') return;
    }
    if (mode === 'sel') target.replace(sel.from, sel.to, out);
    else if (mode === 'insert') target.replace(cur, cur, out);
    else if (mode === 'append') { const n = target.get().length; target.replace(n, n, (orig && !orig.endsWith('\n') ? '\n' : '') + out); }
    else target.replace(0, target.get().length, out);
    m.close();
    toast('已写入，记得保存', 'ok', 2200);
  };

  m.el.addEventListener('input', e => {
    if (e.target.dataset.ai === 'instr') S.instr = e.target.value;
    if (e.target.dataset.ai === 'out') S.out = e.target.value;
  });
  m.el.addEventListener('change', e => {
    if (e.target.dataset.ai === 'profile') { S.profile = e.target.value; api('ai.setActive', { id: S.profile }).then(st => { if (st?.profiles) A.st = st; }); }
    if (e.target.dataset.ai === 'diff') { S.diff = e.target.checked; paint(); }
  });
  m.el.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && A.st.profiles.length) { e.preventDefault(); run(); } });
  m.el.addEventListener('click', async e => {
    const seg = e.target.closest('[data-ai-act] button');
    if (seg && S.state !== 'running') { S.action = seg.dataset.v; if (S.state !== 'running') { S.state = 'idle'; S.out = ''; S.err = ''; } paint(); $('[data-ai="instr"]', body)?.focus(); return; }
    const sc = e.target.closest('[data-ai-scope] button');
    if (sc) { S.scope = sc.dataset.v; paint(); return; }
    const b = e.target.closest('[data-ai]');
    if (!b) return;
    const k = b.dataset.ai;
    if (k === 'run') run();
    if (k === 'stop') { api('ai.cancel', { id: S.job }); }
    if (k === 'settings') { await aiSettingsFlow(); if (!m.closed) { if (!profileOf(S.profile)) S.profile = A.st.active; paint(); } }
    if (k === 'copy') copyText(S.out);
    if (k === 'apply') apply(b.dataset.mode);
    if (k === 'fixby') {
      S.instr = '按照下面的审查意见修改原文，只改有问题的地方：\n\n' + S.out;
      S.action = 'modify'; S.state = 'idle'; S.out = '';
      paint(); run();
    }
  });
  paint();
  return m;
}

// 审查整个作品（或其中一个 artifact）
export async function aiReviewFlow(path, a) {
  let r;
  try { r = await apiOk('aiText', { path, a }); } catch (e) { toast(e.message, 'error'); return; }
  aiAssist({ field: a != null ? '作品中的一个 artifact' : '整个作品', text: r.text, project: r.project, action: 'review' });
}

// ---------- 模型下拉框：自己画（系统的 datalist 列表很长时不能滚动） ----------
let modelPop = null;
function closeModels() { if (modelPop) { modelPop.el.remove(); modelPop.off(); modelPop = null; } }
function openModels(input, models, onPick) {
  closeModels();
  if (!models.length) return;
  const el = document.createElement('div');
  el.className = 'menu ai-models';
  document.body.appendChild(el);
  let act = -1, typed = false, shown = [];
  const place = () => {
    const r = input.getBoundingClientRect(), below = innerHeight - r.bottom - 12, above = r.top - 12;
    const up = below < Math.min(320, el.scrollHeight) && above > below;
    el.style.maxHeight = Math.max(120, Math.min(320, up ? above : below)) + 'px';
    el.style.width = Math.max(r.width, 260) + 'px';
    el.style.left = Math.min(r.left, innerWidth - Math.max(r.width, 260) - 8) + 'px';
    el.style.top = (up ? r.top - 4 - el.offsetHeight : r.bottom + 4) + 'px';
  };
  const draw = () => {
    const f = typed ? input.value.trim().toLowerCase() : '';
    const all = f ? models.filter(m => m.toLowerCase().includes(f)) : models;
    shown = all.slice(0, 800);
    el.innerHTML = shown.length
      ? shown.map((m, i) => `<button type="button" class="menu-i ai-model${m === input.value ? ' checked' : ''}${i === act ? ' act' : ''}" data-i="${i}"><span class="mt">${esc(m)}</span></button>`).join('') + (all.length > shown.length ? `<div class="menu-h">还有 ${all.length - shown.length} 个，输入文字筛选</div>` : '')
      : '<div class="menu-h">没有匹配的模型</div>';
    place();
    (el.querySelector('.act') || (typed ? null : el.querySelector('.checked')))?.scrollIntoView({ block: 'nearest' });
  };
  const pick = i => { const m = shown[i]; if (m == null) return; closeModels(); onPick(m); };
  const onInput = () => { typed = true; act = -1; draw(); };
  const onKey = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); act = Math.max(0, Math.min(shown.length - 1, act + (e.key === 'ArrowDown' ? 1 : -1))); draw(); }
    else if (e.key === 'Enter' && act >= 0) { e.preventDefault(); e.stopPropagation(); pick(act); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeModels(); }
  };
  const onBlur = () => setTimeout(() => { if (modelPop?.el === el && document.activeElement !== input) closeModels(); }, 0);
  const onScroll = e => { if (!el.contains(e.target)) place(); };
  el.addEventListener('mousedown', e => e.preventDefault());
  el.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) pick(Number(b.dataset.i)); });
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey, true);
  input.addEventListener('blur', onBlur);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', closeModels);
  modelPop = { el, input, off: () => { input.removeEventListener('input', onInput); input.removeEventListener('keydown', onKey, true); input.removeEventListener('blur', onBlur); document.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', closeModels); } };
  draw();
}

// ---------- 设置：接口与提示词 ----------
const isClaude5 = model => /^claude-(opus|sonnet|haiku|fable|mythos)-[5-9]/.test(model || '');
const FALLBACK = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];
const BASE_HINT = {
  openai: 'OpenAI 官方接口为 https://api.openai.com/v1（使用 Responses API，对话不保存在 OpenAI）',
  compat: '兼容 OpenAI chat/completions 的接口，填到 /v1 为止，例如 https://api.deepseek.com、https://openrouter.ai/api/v1 或 http://127.0.0.1:11434/v1',
  anthropic: '官方接口为 https://api.anthropic.com，也可以填兼容的中转地址',
  gemini: '官方接口为 https://generativelanguage.googleapis.com',
};
const EFFORT_NOTE = { none: '不思考', minimal: '最少', low: '更快、更省', high: '更仔细', max: '最仔细、最慢' };
export function aiSettingsFlow(tab = 'api') {
  return new Promise(res => {
    const st = () => A.st;
    // work：正在编辑的接口（id 为空表示新添加、还没保存）；key 只在这个窗口里暂存
    const V = { tab, work: null, key: '', clearKey: false, models: [], prompt: st().actions[0].id, busy: '', err: '' };
    const pick = id => { const p = st().profiles.find(x => x.id === id); V.work = p ? { ...p } : null; V.key = ''; V.clearKey = false; V.models = []; V.err = ''; };
    pick(st().active || st().profiles[0]?.id);
    const m = modal({ cls: 'wide ai-set', title: `${icon('sparkles')}<span>AI 帮写设置</span>`, body: '<div data-as="body"></div>', foot: '<div class="spacer"></div><button class="btn primary" data-m="close">完成</button>', onClose: () => { closeModels(); res(); } });
    const showModels = () => {
      const input = $('[data-pf="model"]', body);
      if (!input || !V.models.length) return;
      openModels(input, V.models, id => { V.work.model = id; paint(); V.picked = true; $('[data-pf="model"]', body)?.focus(); });
    };
    m.el.addEventListener('focusin', e => { if (e.target.dataset.pf !== 'model') return; if (V.picked) { V.picked = false; return; } if (modelPop?.input !== e.target) showModels(); });
    m.el.addEventListener('mousedown', e => { if (e.target.dataset.pf === 'model' && !modelPop) setTimeout(showModels, 0); });
    const body = $('[data-as="body"]', m.el);

    const apiTab = () => {
      const p = V.work;
      const list = st().profiles.map(x => `<button class="ai-pl${p && x.id === p.id ? ' on' : ''}" data-as="pick" data-id="${esc(x.id)}"><span class="ai-dot${x.id === st().active ? ' on' : ''}" title="${x.id === st().active ? '默认使用这个接口' : ''}"></span><span class="ell"><b>${esc(x.name)}</b><small class="ell">${esc(x.model)}</small></span></button>`).join('')
        + (p && !p.id ? `<button class="ai-pl on"><span class="ai-dot"></span><span class="ell"><b>${esc(p.name)}</b><small>新接口（未保存）</small></span></button>` : '');
      let form = '<div class="empty small muted">点左边的“添加接口”，从常用接口里选一个开始。</div>';
      if (p) {
        const official = !p.base || p.base.replace(/\/+$/, '') === 'https://api.anthropic.com';
        const fb = p.type === 'anthropic' && official && FALLBACK.includes(p.model);
        form = `<div class="fgrid">
          <label class="flabel">名称</label><div class="fval"><input class="input" data-pf="name" value="${esc(p.name)}" maxlength="40"></div>
          <label class="flabel">类型</label><div class="fval"><select class="input" data-pf="type">${Object.entries(st().providers).map(([k, v]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>
          <label class="flabel">接口地址</label><div class="fval"><input class="input mono" data-pf="base" value="${esc(p.base)}" spellcheck="false"><div class="fhint">${BASE_HINT[p.type] || ''}</div></div>
          <label class="flabel">API key</label><div class="fval"><input class="input mono" type="password" data-pf="key" autocomplete="off" spellcheck="false" placeholder="${p.hasKey ? '已保存（留空表示不修改）' : p.type === 'compat' ? '粘贴 API key（本机的 Ollama 等可以不填）' : '粘贴 API key'}">${p.hasKey ? `<label class="chk small"><input type="checkbox" data-pf="clearKey" ${V.clearKey ? 'checked' : ''}>清除已保存的 key</label>` : ''}<div class="fhint">用系统加密保存在本机，只发送到上面的接口地址。</div></div>
          <label class="flabel">模型</label><div class="fval"><div class="row-input"><input class="input mono" data-pf="model" value="${esc(p.model)}" spellcheck="false" autocomplete="off" placeholder="${p.type === 'anthropic' ? 'claude-opus-5-5' : '模型名称，可以点右边获取'}"><button class="btn" data-as="models" ${V.busy ? 'disabled' : ''}>${V.busy === 'models' ? '<span class="spin sm"></span>' : icon('list')}获取模型列表</button></div>
            ${V.models.length ? `<div class="fhint">已获取 ${V.models.length} 个模型：点输入框打开列表，输入文字筛选。</div>` : ''}</div>
          <label class="flabel">最大输出</label><div class="fval"><input class="input num" data-pf="maxTokens" value="${esc(p.maxTokens ?? '')}" placeholder="${p.type === 'anthropic' ? '64000' : '默认'}"> <span class="muted small">tokens，留空用默认值</span></div>
          ${st().efforts?.[p.type] ? `<label class="flabel">思考深度</label><div class="fval"><select class="input" data-pf="effort"><option value="">默认（由模型决定）</option>${st().efforts[p.type].map(v => `<option value="${v}" ${p.effort === v ? 'selected' : ''}>${v}${EFFORT_NOTE[v] ? '：' + EFFORT_NOTE[v] : ''}</option>`).join('')}</select><div class="fhint">${p.type === 'anthropic' ? (isClaude5(p.model) ? '对应 output_config.effort。' : '只对 Claude 5 系列模型生效。') + 'Claude 不使用温度设置。' : '对应 reasoning.effort，只对推理模型生效；不支持推理的模型请保持默认。'}</div></div>` : ''}
          ${p.type !== 'anthropic' ? `<label class="flabel">温度</label><div class="fval"><input class="input num" data-pf="temperature" value="${esc(p.temperature ?? '')}" placeholder="默认"> <span class="muted small">0–2，留空用接口默认值${p.type === 'openai' ? '；推理模型不支持温度，请留空' : ''}</span></div>` : ''}
        </div>
        ${p.type === 'anthropic' ? `<div class="banner info sm">${icon('info')}<div class="bb"><div class="bs">通过 Anthropic 官方 SDK 调用。${fb ? '这个模型在官方接口上会<b>开启服务端回退</b>：请求被安全策略拒绝时，由 Anthropic 自动改用推荐的备用模型重试，费用按实际使用的模型计算。' : 'Claude Fable 5.1、Opus 5.5、Opus 5、Sonnet 5.5 在官方接口上会开启服务端回退：请求被安全策略拒绝时，自动改用推荐的备用模型重试。'}</div></div></div>` : ''}
        <div class="ferr" ${V.err ? '' : 'hidden'}>${esc(V.err)}</div>
        <div class="row ai-pf-acts">
          <button class="btn primary" data-as="save" ${V.busy ? 'disabled' : ''}>${icon('save')}保存</button>
          <button class="btn" data-as="test" ${V.busy || !p.id ? 'disabled' : ''} title="${p.id ? '发送一个很短的请求' : '先保存'}">${V.busy === 'test' ? '<span class="spin sm"></span>' : icon('zap')}测试连接</button>
          ${p.id && p.id !== st().active ? `<button class="btn ghost" data-as="default">${icon('check')}设为默认</button>` : ''}
          <div class="grow"></div>
          ${p.id ? `<button class="btn ghost danger" data-as="delete">${icon('trash')}删除</button>` : `<button class="btn ghost" data-as="cancel">取消</button>`}
        </div>`;
      }
      return `<div class="ai-api"><div class="ai-plist">${list}<button class="btn sm ghost block" data-as="add">${icon('plus')}添加接口…</button></div><div class="ai-pform">${form}</div></div>`;
    };
    const promptTab = () => {
      const a = st().actions.find(x => x.id === V.prompt);
      return `<div class="ai-prompts">
        <div class="row"><div class="seg" data-as-prompt>${st().actions.map(x => `<button type="button" data-v="${x.id}" class="${x.id === V.prompt ? 'on' : ''}">${esc(x.label)}${x.custom ? ' ·' : ''}</button>`).join('')}</div><span class="muted small">${esc(a.desc)}</span><div class="grow"></div>${a.custom ? '<span class="pill warn">已修改</span>' : '<span class="pill plain">默认</span>'}</div>
        <label class="flabel">系统提示词</label><textarea class="input mono" rows="9" data-pt="system" spellcheck="false">${esc(a.system)}</textarea>
        <label class="flabel">用户消息模板</label><textarea class="input mono" rows="7" data-pt="user" spellcheck="false">${esc(a.user)}</textarea>
        <div class="fhint ai-vars">可用的变量：${st().vars.map(([k, t]) => `<code>{{${k}}}</code> ${esc(t)}`).join('；')}。没有内容的变量替换为空。</div>
        <div class="row"><button class="btn primary" data-as="psave">${icon('save')}保存提示词</button><button class="btn ghost" data-as="preset" ${a.custom ? '' : 'disabled'}>${icon('undo')}恢复默认</button></div>
      </div>`;
    };
    const paint = () => {
      closeModels();
      body.innerHTML = `<div class="ai-tabs"><button class="tab${V.tab === 'api' ? ' on' : ''}" data-as="tab" data-v="api">${icon('globe', 'xs')}接口</button><button class="tab${V.tab === 'prompts' ? ' on' : ''}" data-as="tab" data-v="prompts">${icon('pencil', 'xs')}提示词</button></div>${V.tab === 'api' ? apiTab() : promptTab()}`;
      const k = $('[data-pf="key"]', body); if (k) k.value = V.key;
    };

    m.el.addEventListener('input', e => {
      const k = e.target.dataset.pf;
      if (!k || !V.work) return;
      if (k === 'key') V.key = e.target.value;
      else if (k === 'clearKey') V.clearKey = e.target.checked;
      else V.work[k] = e.target.value;
    });
    m.el.addEventListener('change', e => {
      const k = e.target.dataset.pf;
      if (!V.work) return;
      if (k === 'clearKey') V.clearKey = e.target.checked;
      if (k === 'type') { const d = st().providers[e.target.value]; Object.assign(V.work, { type: e.target.value, base: d.base, model: d.model || '', effort: '' }); V.models = []; paint(); }
      if (k === 'model' || k === 'base') paint();
    });
    m.el.addEventListener('click', async e => {
      const pseg = e.target.closest('[data-as-prompt] button');
      if (pseg) { V.prompt = pseg.dataset.v; paint(); return; }
      const b = e.target.closest('[data-as]'); if (!b) return;
      const k = b.dataset.as, p = V.work;
      if (k === 'tab') { V.tab = b.dataset.v; paint(); }
      if (k === 'pick') { pick(b.dataset.id); paint(); }
      if (k === 'add') menu(b, st().presets.map(x => ({ label: x.name, hint: x.base, onClick: () => { V.work = { id: null, name: x.name, type: x.type, base: x.base, model: x.model || '', maxTokens: null, temperature: null, effort: '', hasKey: false }; V.key = ''; V.models = []; V.err = ''; paint(); $('[data-pf="key"]', body)?.focus(); } })), { width: 320 });
      if (k === 'cancel') { pick(st().active || st().profiles[0]?.id); paint(); }
      if (k === 'models') {
        V.busy = 'models'; V.err = ''; paint();
        const r = await api('ai.models', { id: p.id, profile: p, key: V.key });
        V.busy = '';
        if (r.ok === false) V.err = '获取模型列表失败：' + r.error;
        else { V.models = r.models; toast(`获取到 ${r.models.length} 个模型`, 'ok', 1600); }
        paint();
        if (r.ok !== false) { V.picked = true; $('[data-pf="model"]', body)?.focus(); V.picked = false; showModels(); }
      }
      if (k === 'save') {
        const r = await api('ai.saveProfile', { profile: { ...p, id: p.id || undefined }, key: V.key, clearKey: V.clearKey });
        if (r.ok === false) { V.err = r.error; paint(); return; }
        A.st = r; pick(r.saved); paint(); toast('已保存', 'ok', 1400);
      }
      if (k === 'test') {
        V.busy = 'test'; V.err = ''; paint();
        const r = await api('ai.test', { id: p.id });
        V.busy = '';
        if (r.ok) toast('连接成功：' + (r.text || '').slice(0, 60), 'ok', 3000); else V.err = '测试失败：' + r.error;
        paint();
      }
      if (k === 'default') { A.st = await api('ai.setActive', { id: p.id }); paint(); }
      if (k === 'delete') {
        const v = await ask({ title: `删除接口“${p.name}”？`, html: '<p>保存的 API key 也会一起删除。</p>', buttons: [{ label: '取消', value: null }, { label: '删除', value: 'ok', danger: true }] });
        if (v !== 'ok') return;
        A.st = await api('ai.deleteProfile', { id: p.id }); pick(A.st.active || A.st.profiles[0]?.id); paint();
      }
      if (k === 'psave') {
        const r = await api('ai.savePrompt', { action: V.prompt, system: $('[data-pt="system"]', body).value, user: $('[data-pt="user"]', body).value });
        if (r.ok === false) { toast(r.error, 'error'); return; }
        A.st = r; paint(); toast('提示词已保存', 'ok', 1400);
      }
      if (k === 'preset') { A.st = await api('ai.resetPrompt', { action: V.prompt }); paint(); toast('已恢复默认提示词', 'ok', 1400); }
    });
    paint();
  });
}
