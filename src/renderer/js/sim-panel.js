// 模拟酒馆的控制面板（窗口右侧）：作品安装、页面与消息、实时变量编辑、日志
import { $, $$, esc, icon, toast, modal, ask, copyText } from './util.js';

const host = window.rwkit;
const api = async (r, b) => { const v = await host.api(r, b); if (v?.ok === false) throw new Error(v.error || '操作失败'); return v; };
const P = {
  st: null, project: null, status: null, logs: [], unknown: [], auto: false,
  scope: 'mvu', vars: null, varsErr: '', varsSig: '', open: new Set(['']), filter: '', notify: true, editing: false,
  busy: '', logOpen: true, logLevel: 'error', installed: null, versions: {}, ai: null, mode: 'builtin', localUrl: '', builtin: true,
};
const SCOPES = [['mvu', 'MVU'], ['message', '楼层'], ['chat', '聊天'], ['character', '角色'], ['global', '全局']];
const SCOPE_HINT = {
  mvu: '最新楼层的 MVU 变量（stat_data）。修改后先广播“变量更新结束”事件，再写回楼层，和游戏里变量更新的效果相同。',
  message: '最新楼层的全部变量（酒馆助手 message 变量，含 MVU 的 stat_data 等）。',
  chat: '当前聊天的变量（酒馆助手 chat 变量）。',
  character: '当前角色卡的变量（酒馆助手 character 变量，保存在角色卡里）。',
  global: '全局变量（酒馆助手 global 变量）。',
};

// ---------- 数据 ----------
async function loadState() {
  const s = await api('sim.state');
  P.project = s.project; P.logs = s.logs; P.unknown = s.unknown; P.auto = s.auto; P.versions = s.versions || {};
  P.mode = s.mode; P.localUrl = s.localUrl; P.builtin = s.builtin;
}
async function loadStatus() {
  try { P.status = (await api('sim.status')); } catch { P.status = null; }
}
async function loadVars(force) {
  if (P.editing && !force) return;
  try {
    const r = await api('sim.vars', { scope: P.scope });
    const sig = JSON.stringify(r.data ?? null) + '|' + (r.error || '');
    P.varsErr = r.error || (r.empty ? '最新楼层还没有 MVU 数据：先开始游戏（例如发送开局消息），或在“楼层”里查看' : '');
    if (sig === P.varsSig && !force) return false;
    P.varsSig = sig; P.vars = r.data ?? null;
    return true;
  } catch (e) { P.varsErr = e.message; P.vars = null; P.varsSig = ''; return true; }
}

// ---------- 渲染 ----------
const pill = (on, label, title = '') => `<span class="sp-pill ${on === true ? 'ok' : on === false ? 'off' : 'wait'}" title="${esc(title)}">${on === true ? icon('check', 'xs') : on === false ? icon('x', 'xs') : '<span class="spin xs"></span>'}${esc(label)}</span>`;
function headHtml() {
  const s = P.status, v = P.versions;
  return `<div class="sp-head">
    <div class="sp-title">${icon('tavern')}<b>模拟酒馆</b><span class="muted small ell" title="${P.mode === 'local' ? '你自己运行的 SillyTavern' : '随 rwkit 附带的官方版本'}">${P.mode === 'local' ? esc(P.localUrl) : `SillyTavern ${esc(v.sillytavern || '')} · 酒馆助手 ${esc(v.tavernHelper || '')}`}</span></div>
    <div class="sp-tools">
      <button class="btn ghost icon sm" data-a="reload" title="重新加载酒馆页面">${icon('refresh')}</button>
      <button class="btn ghost icon sm" data-a="devtools" title="打开酒馆页面的开发者工具">${icon('code')}</button>
      <button class="btn ghost icon sm" data-a="help" title="说明">${icon('help')}</button>
    </div>
  </div>
  <div class="sp-mode"><div class="seg sm">${[['builtin', '内置模拟酒馆'], ['local', '本机 SillyTavern']].map(([k, t]) => `<button type="button" data-mode="${k}" class="${P.mode === k ? 'on' : ''}" ${k === 'builtin' && !P.builtin ? 'disabled title="没有找到内置的运行文件"' : ''}>${t}</button>`).join('')}</div>${P.mode === 'local' ? `<button class="btn ghost xs" data-a="local-url">更改地址</button>` : ''}</div>
  <div class="sp-status">
    ${pill(s ? !!s.character : null, s?.character ? '角色：' + s.character : '未打开角色', s?.character ? '' : '在左侧的“角色管理”里导入并打开角色卡')}
    ${pill(s ? s.mvu : null, 'MVU', 'MVU 变量框架（由角色卡的脚本加载）')}
    ${pill(s ? !!s.workshop : null, s?.workshop ? '创意工坊 ' + s.workshop : '创意工坊', '轮回战场创意工坊（由角色卡的脚本加载）')}
    ${s ? `<span class="sp-pill plain">${s.chat} 层</span>` : ''}
  </div>`;
}
function projectHtml() {
  const p = P.project, s = P.status;
  if (!p) return `<section class="sp-sec"><h4>${icon('package', 'xs')}作品</h4><div class="muted small">在 rwkit 主窗口的作品页点“模拟预览”，这里会显示要安装的作品。</div></section>`;
  if (p.error) return `<section class="sp-sec"><h4>${icon('package', 'xs')}作品</h4><div class="sp-err">${esc(p.error)}</div></section>`;
  const inst = s?.installed?.find(x => x.id === p.id);
  const blocked = p.fatal || p.errors;
  const needCard = !s?.workshop;
  return `<section class="sp-sec">
    <h4>${icon('package', 'xs')}作品<span class="grow"></span>${inst?.applied ? `<span class="sp-pill ok">已安装 v${esc(inst.appliedVersion ?? inst.version)}</span>` : `<span class="sp-pill plain">未安装</span>`}</h4>
    <div class="sp-proj"><b class="ell">${esc(p.name)}</b><span class="muted small">v${esc(p.version)}${p.draft ? ' · 草稿' : ''}</span></div>
    ${blocked ? `<div class="sp-err">${p.fatal ? esc(p.fatal) : `有 ${p.errors} 个会让安装失败的问题，修正后才能安装（见主窗口的“检查结果”）`}</div>` : ''}
    ${P.mode === 'local' ? `<div class="sp-warn">${icon('alert', 'xs')}这是你自己的 SillyTavern：安装、修改变量、插入消息都会直接改动它的数据，与在酒馆里操作相同。</div>` : ''}
    ${needCard ? `<div class="sp-hint">${icon('info', 'xs')}先在左侧导入并打开<b>轮回战场角色卡</b>（角色管理 → 导入角色），在提示里允许它的脚本；创意工坊加载后就能安装。</div>` : ''}
    <div class="sp-row">
      <button class="btn primary sm" data-a="install" ${blocked || needCard || P.busy ? 'disabled' : ''}>${P.busy === 'install' ? '<span class="spin sm"></span>' : icon('download')}${inst?.applied ? '重新安装' : '安装到模拟酒馆'}</button>
      ${inst?.applied ? `<button class="btn ghost sm" data-a="uninstall" ${P.busy ? 'disabled' : ''}>卸载</button>` : ''}
      <label class="toggle sm" title="作品保存后自动重新安装（草稿也可以）"><input type="checkbox" data-a="auto" ${P.auto ? 'checked' : ''}><span class="sw"></span><span>保存后自动重装</span></label>
    </div>
  </section>`;
}
function pagesHtml() {
  const t = P.project?.triggers || [];
  return `<section class="sp-sec">
    <h4>${icon('send', 'xs')}页面与消息</h4>
    ${t.length ? `<div class="fhint">作品里的正则会把这些文字替换成页面，插入一条消息就能看到：</div><div class="sp-trig">${t.map((x, i) => `<button class="btn sm" data-a="trigger" data-i="${i}" title="${esc(x.text)}">${icon(x.page ? 'eye' : 'regex', 'xs')}${esc(x.name || x.text)}</button>`).join('')}</div>` : ''}
    <textarea class="input sp-msg" rows="3" data-f="msg" placeholder="输入一条消息（可以包含 HTML、触发正则的文字或 MVU 更新命令）"></textarea>
    <div class="sp-row">
      <button class="btn sm" data-a="send" data-role="assistant">${icon('plus', 'xs')}作为 AI 消息</button>
      <button class="btn sm ghost" data-a="send" data-role="user">作为用户消息</button>
      <div class="grow"></div>
      <button class="btn sm ghost" data-a="rerender" title="重新渲染聊天里的消息与页面">${icon('refresh', 'xs')}重新渲染</button>
      <button class="btn sm ghost" data-a="newchat" title="开始新的聊天（重新开局，MVU 会重新初始化变量）">新聊天</button>
    </div>
  </section>`;
}
// 变量树：叶子可以直接修改，对象与数组可以展开或用 JSON 修改
const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const keyPath = parts => JSON.stringify(parts);
function matches(k, v, f) {
  if (!f) return true;
  if (String(k).toLowerCase().includes(f)) return true;
  if (v !== null && typeof v === 'object') return Object.entries(v).some(([kk, vv]) => matches(kk, vv, f));
  return String(v).toLowerCase().includes(f);
}
function nodeHtml(k, v, parts, depth) {
  const t = typeOf(v), p = keyPath(parts), f = P.filter;
  if (f && !matches(k, v, f)) return '';
  if (t === 'object' || t === 'array') {
    const entries = Object.entries(v);
    const open = P.open.has(p) || (f && depth < 6);
    return `<div class="vt-node"><div class="vt-row vt-branch" data-tog="${esc(p)}" style="--d:${depth}">${icon(open ? 'chevDown' : 'chevRight', 'xs')}<span class="vt-k">${esc(k)}</span><span class="vt-meta">${t === 'array' ? `[${entries.length}]` : `{${entries.length}}`}</span><span class="grow"></span><button class="vt-act" data-json="${esc(p)}" title="用 JSON 修改">{ }</button></div>
      ${open ? `<div class="vt-kids">${entries.map(([kk, vv]) => nodeHtml(kk, vv, parts.concat(t === 'array' ? Number(kk) : kk), depth + 1)).join('')}</div>` : ''}</div>`;
  }
  let input;
  if (t === 'boolean') input = `<label class="toggle sm"><input type="checkbox" data-leaf="${esc(p)}" data-t="boolean" ${v ? 'checked' : ''}><span class="sw"></span></label>`;
  else if (t === 'number') input = `<input class="input vt-in num" data-leaf="${esc(p)}" data-t="number" value="${esc(v)}" spellcheck="false">`;
  else if (t === 'null') input = `<span class="muted small">null</span>`;
  else input = `<input class="input vt-in" data-leaf="${esc(p)}" data-t="string" value="${esc(v)}" spellcheck="false" title="${esc(v)}">`;
  return `<div class="vt-row" style="--d:${depth}"><span class="vt-k ell" title="${esc(parts.join('.'))}">${esc(k)}</span>${input}</div>`;
}
function aiHtml() {
  const a = P.ai;
  if (!a || P.mode === 'local') return '';
  return `<section class="sp-sec">
    <h4>${icon('sparkles', 'xs')}AI 回复</h4>
    <select class="input sm" data-f="ai">${[['', '不生成回复'], ...a.list.map(p => [p.id, p.name + ' · ' + p.model])].map(([v, t]) => `<option value="${esc(v)}" ${a.selected === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
    <div class="fhint">${a.list.length ? '在酒馆里发送消息、重新生成，或脚本调用 generate 时，用这个接口生成回复（按接口计费）。提示词由酒馆按角色卡、世界书与预设组好。' : '还没有 AI 接口：在 rwkit 主窗口的 设置 → AI 帮写 里添加后，这里就能选择。'}</div>
  </section>`;
}
function varsHtml() {
  const v = P.vars;
  let body;
  if (P.varsErr) body = `<div class="sp-hint">${icon('info', 'xs')}${esc(P.varsErr)}</div>`;
  else if (v == null) body = '<div class="loading small"><span class="spin sm"></span>读取中…</div>';
  else if (typeOf(v) !== 'object' && typeOf(v) !== 'array') body = `<div class="vt">${nodeHtml('(值)', v, [], 0)}</div>`;
  else if (!Object.keys(v).length) body = '<div class="muted small">（空）</div>';
  else body = `<div class="vt">${Object.entries(v).map(([k, x]) => nodeHtml(k, x, [Array.isArray(v) ? Number(k) : k], 0)).join('')}</div>`;
  return `<section class="sp-sec sp-vars">
    <h4>${icon('database', 'xs')}变量<span class="grow"></span><button class="btn ghost xs" data-a="json-all" ${v == null ? 'disabled' : ''} title="用 JSON 修改全部">{ } JSON</button><button class="btn ghost xs icon" data-a="vars-refresh" title="刷新">${icon('refresh', 'xs')}</button></h4>
    <div class="seg sm sp-scope">${SCOPES.map(([k, t]) => `<button type="button" data-scope="${k}" class="${P.scope === k ? 'on' : ''}">${t}</button>`).join('')}</div>
    <div class="fhint">${esc(SCOPE_HINT[P.scope])}</div>
    <div class="sp-row"><input class="input sm grow" data-f="filter" placeholder="搜索变量名或值" value="${esc(P.filter)}" spellcheck="false">${P.scope === 'mvu' ? `<label class="toggle sm" title="修改后广播 MVU 的“变量更新结束”事件，让属性计算、状态栏等脚本照常响应"><input type="checkbox" data-a="notify" ${P.notify ? 'checked' : ''}><span class="sw"></span><span>触发更新事件</span></label>` : ''}</div>
    <div data-r="tree">${body}</div>
  </section>`;
}
function logsHtml() {
  const lv = { error: 3, warn: 2, info: 1, debug: 0 };
  const min = lv[P.logLevel];
  const list = P.logs.filter(l => lv[l.level] >= min).slice(-150).reverse();
  const nErr = P.logs.filter(l => l.level === 'error').length;
  return `<section class="sp-sec sp-logs">
    <h4 data-a="log-toggle" class="click">${icon(P.logOpen ? 'chevDown' : 'chevRight', 'xs')}日志${nErr ? `<span class="sp-pill off">${nErr} 个错误</span>` : ''}<span class="grow"></span>
      <select class="input xs" data-f="loglevel">${[['error', '只看错误'], ['warn', '错误与警告'], ['info', '全部']].map(([k, t]) => `<option value="${k}" ${P.logLevel === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <button class="btn ghost xs" data-a="log-copy" title="复制">${icon('copy', 'xs')}</button><button class="btn ghost xs" data-a="log-clear">清空</button></h4>
    ${P.logOpen ? `<div class="sp-loglist">${list.length ? list.map(l => `<div class="lg ${l.level}"><span class="lg-t">${new Date(l.t).toLocaleTimeString()}</span><span class="lg-m">${esc(l.text)}</span>${l.source ? `<span class="lg-s ell" title="${esc(l.source)}">${esc(l.source.replace(/^rwsim:\/\/st/, ''))}</span>` : ''}</div>`).join('') : '<div class="muted small">没有记录</div>'}</div>` : ''}
  </section>`;
}
function render() {
  const root = $('#sim');
  const keep = root.querySelector('.sp-body')?.scrollTop || 0;
  const msg = $('[data-f="msg"]', root)?.value || '';
  root.innerHTML = headHtml() + `<div class="sp-body">${projectHtml()}${pagesHtml()}${aiHtml()}${varsHtml()}${logsHtml()}</div>`;
  root.querySelector('.sp-body').scrollTop = keep;
  const m = $('[data-f="msg"]', root); if (m) m.value = msg;
}
function renderTree() {
  const box = $('[data-r="tree"]');
  if (!box) return render();
  const tmp = document.createElement('div');
  tmp.innerHTML = varsHtml();
  box.innerHTML = tmp.querySelector('[data-r="tree"]').innerHTML;
}
function renderLogs() {
  const box = $('.sp-logs');
  if (!box) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = logsHtml();
  box.replaceWith(tmp.firstElementChild);
}

// ---------- 修改变量 ----------
const getIn = (o, parts) => parts.reduce((v, k) => (v == null ? undefined : v[k]), o);
function setIn(o, parts, val) {
  if (!parts.length) return val;
  const root = structuredClone(o);
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  cur[parts[parts.length - 1]] = val;
  return root;
}
async function writeVars(next, what) {
  try {
    await api('sim.setVars', { scope: P.scope, data: next, notify: P.notify });
    P.vars = next;
    await loadVars(true);
    renderTree();
    if (what) toast(what, 'ok', 1200);
  } catch (e) { toast('写入失败：' + e.message, 'error', 5000); await loadVars(true); renderTree(); }
}
function jsonEdit(parts) {
  const cur = parts.length ? getIn(P.vars, parts) : P.vars;
  const m = modal({
    cls: 'mid', title: esc('修改 ' + (parts.length ? parts.join('.') : '全部变量')),
    body: `<textarea class="input mono sp-json" spellcheck="false">${esc(JSON.stringify(cur, null, 2))}</textarea><div class="ferr" hidden></div>`,
    foot: '<div class="spacer"></div><button class="btn" data-m="close">取消</button><button class="btn primary" data-ok>写入</button>',
  });
  P.editing = true;
  m.el.addEventListener('click', async e => {
    if (!e.target.closest('[data-ok]')) return;
    let v;
    try { v = JSON.parse($('.sp-json', m.el).value); } catch (err) { const f = $('.ferr', m.el); f.hidden = false; f.textContent = 'JSON 格式不对：' + err.message; return; }
    m.close();
    P.editing = false;
    await writeVars(parts.length ? setIn(P.vars, parts, v) : v, '已写入');
  });
  const done = () => { P.editing = false; };
  m.el.addEventListener('click', e => { if (e.target.closest('[data-m="close"]') || e.target === m.el) done(); });
}

// ---------- 事件 ----------
document.addEventListener('click', async e => {
  const md = e.target.closest('[data-mode]');
  if (md && !md.disabled) { if (md.dataset.mode !== P.mode) switchMode(md.dataset.mode); return; }
  const sc = e.target.closest('[data-scope]');
  if (sc) { P.scope = sc.dataset.scope; P.vars = null; P.varsSig = ''; render(); await loadVars(true); renderTree(); return; }
  const tog = e.target.closest('[data-tog]');
  if (tog && !e.target.closest('[data-json]')) { const p = tog.dataset.tog; if (P.open.has(p)) P.open.delete(p); else P.open.add(p); renderTree(); return; }
  const j = e.target.closest('[data-json]');
  if (j) { jsonEdit(JSON.parse(j.dataset.json)); return; }
  const b = e.target.closest('[data-a]');
  if (!b || b.tagName === 'INPUT' || b.tagName === 'SELECT') return;
  const a = b.dataset.a;
  try {
    if (a === 'reload') { await api('sim.reload'); P.status = null; render(); }
    if (a === 'devtools') await api('sim.devtools');
    if (a === 'help') helpFlow();
    if (a === 'local-url') switchMode('local', true);
    if (a === 'install') {
      P.busy = 'install'; render();
      try {
        const r = await api('sim.install');
        toast(`已安装到模拟酒馆${r.warnings?.length ? `（${r.warnings.length} 条提示）` : ''}`, 'ok', 3000);
        if (r.warnings?.length) for (const w of r.warnings.slice(0, 3)) toast(w, 'warn', 6000);
      } finally { P.busy = ''; await loadStatus(); render(); }
    }
    if (a === 'uninstall') {
      P.busy = 'uninstall'; render();
      try { await api('sim.uninstall', { id: P.project.id }); toast('已卸载', 'ok', 1600); } finally { P.busy = ''; await loadStatus(); render(); }
    }
    if (a === 'trigger') { const t = P.project.triggers[Number(b.dataset.i)]; await api('sim.addMessage', { role: 'assistant', text: t.text }); toast('已插入消息', 'ok', 1200); }
    if (a === 'send') {
      const ta = $('[data-f="msg"]'); const text = ta.value;
      if (!text.trim()) { ta.focus(); return; }
      await api('sim.addMessage', { role: b.dataset.role, text }); ta.value = '';
    }
    if (a === 'rerender') await api('sim.rerender');
    if (a === 'newchat') { const v = await ask({ title: '开始新的聊天？', html: '<p>会在模拟酒馆里新开一个聊天（重新开局），当前聊天保留在聊天记录里。</p>', buttons: [{ label: '取消', value: null }, { label: '新聊天', value: 'ok', primary: true }] }); if (v === 'ok') await api('sim.newChat'); }
    if (a === 'json-all') jsonEdit([]);
    if (a === 'vars-refresh') { await loadVars(true); renderTree(); }
    if (a === 'log-toggle' && !e.target.closest('select, button')) { P.logOpen = !P.logOpen; renderLogs(); }
    if (a === 'log-clear') { await api('sim.clearLogs'); P.logs = []; renderLogs(); }
    if (a === 'log-copy') copyText(P.logs.map(l => `[${new Date(l.t).toLocaleTimeString()}] ${l.level} ${l.text}${l.source ? ' @ ' + l.source : ''}`).join('\n'));
  } catch (err) { toast(err.message, 'error', 6000); }
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.a === 'auto') { P.auto = t.checked; await api('sim.auto', { on: t.checked }); return; }
  if (t.dataset.a === 'notify') { P.notify = t.checked; return; }
  if (t.dataset.f === 'loglevel') { P.logLevel = t.value; renderLogs(); return; }
  if (t.dataset.f === 'ai') { await api('sim.setAi', { id: t.value }); P.ai.selected = t.value; toast(t.value ? '回复将由所选接口生成' : '不再生成回复', 'ok', 1600); return; }
  if (t.dataset.leaf) {
    const parts = JSON.parse(t.dataset.leaf);
    let v = t.value;
    if (t.dataset.t === 'boolean') v = t.checked;
    if (t.dataset.t === 'number') { v = Number(t.value); if (!Number.isFinite(v)) { toast('不是有效的数字', 'warn'); t.value = getIn(P.vars, parts); return; } }
    P.editing = false;
    await writeVars(setIn(P.vars, parts, v), parts.join('.') + ' = ' + JSON.stringify(v));
  }
});
document.addEventListener('input', e => { if (e.target.dataset.f === 'filter') { P.filter = e.target.value.trim().toLowerCase(); renderTree(); } });
document.addEventListener('focusin', e => { if (e.target.dataset.leaf) P.editing = true; });
document.addEventListener('focusout', e => { if (e.target.dataset.leaf) setTimeout(() => { if (!document.activeElement?.dataset?.leaf) P.editing = false; }, 0); });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset.leaf) e.target.blur(); if (e.key === 'Escape' && e.target.dataset.leaf) { e.target.value = getIn(P.vars, JSON.parse(e.target.dataset.leaf)); e.target.blur(); } });

// 在主窗口添加了 AI 接口后，回到这里时刷新列表
window.addEventListener('focus', async () => { const a = await api('sim.ai').catch(() => null); if (a && JSON.stringify(a) !== JSON.stringify(P.ai)) { P.ai = a; render(); } });
host.on((type, d) => {
  if (type === 'sim-log') { P.logs.push(d); if (P.logs.length > 500) P.logs.shift(); renderLogs(); }
  if (type === 'sim-project') { P.project = d; render(); }
  if (type === 'sim-mode') { loadState().then(() => { P.status = null; P.vars = null; P.varsSig = ''; render(); }); }
  if (type === 'sim-state' && d?.loaded) { P.status = null; render(); }
});

// 切换环境：本机模式先询问地址并检查能否连上
async function switchMode(mode, change) {
  let url;
  if (mode === 'local') {
    url = await new Promise(res => {
      const m = modal({ cls: '', title: '连接本机的 SillyTavern', body: `<p class="lead">在这个窗口里打开你自己正在运行的 SillyTavern。右侧面板的安装、变量、消息等功能照常可用，但会直接改动它的数据。</p><label class="flabel">地址</label><input class="input mono" data-u value="${esc(P.localUrl || 'http://127.0.0.1:8000/')}" spellcheck="false"><div class="fhint">先启动 SillyTavern；开启了账号或密码时，在打开的页面里登录即可。</div><div class="ferr" hidden></div>`,
        foot: '<div class="spacer"></div><button class="btn" data-m="close">取消</button><button class="btn primary" data-ok>连接</button>', onClose: v => res(v) });
      const go = async () => {
        const btn = $('[data-ok]', m.el), err = $('.ferr', m.el);
        btn.disabled = true; err.hidden = true;
        try { await api('sim.setMode', { mode: 'local', url: $('[data-u]', m.el).value }); m.close($('[data-u]', m.el).value); }
        catch (e) { err.hidden = false; err.textContent = e.message; btn.disabled = false; }
      };
      m.el.addEventListener('click', e => { if (e.target.closest('[data-ok]')) go(); });
      m.el.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    });
    if (!url) return;
  } else {
    try { await api('sim.setMode', { mode: 'builtin' }); } catch (e) { toast(e.message, 'error', 5000); return; }
  }
  toast(mode === 'local' ? '已切换到本机 SillyTavern' : '已切换到内置模拟酒馆', 'ok', 1800);
}
function helpFlow() {
  modal({ cls: 'mid', title: '模拟酒馆', body: `
    <p>这里运行的是随 rwkit 附带的<b>官方 SillyTavern 前端</b>与<b>酒馆助手</b>，服务器由 rwkit 模拟，数据与你自己的酒馆完全分开。角色卡的脚本、MVU、创意工坊、作品的脚本按钮与前端页面都和在酒馆里一样运行。</p>
    <h4>开始</h4>
    <ol><li>在左侧“角色管理”里导入轮回战场角色卡并打开它，在提示里允许它的脚本与世界书。</li>
    <li>等状态栏里的 MVU 与创意工坊就绪后，点“安装到模拟酒馆”。草稿也可以直接安装；勾选“保存后自动重装”，在 rwkit 里改完保存就会重新安装。</li>
    <li>点作品正则对应的按钮插入消息，就能看到开局页、美化页面；作品脚本的按钮出现在输入框上方。</li></ol>
    <h4>本机 SillyTavern</h4>
    <p>面板顶部可以改用你自己正在运行的 SillyTavern（例如 http://127.0.0.1:8000）。面板的功能照常可用，回复用它自己的 API 设置生成；安装、修改变量、插入消息会直接改动它的数据。</p>
    <h4>修改变量</h4>
    <p>“变量”里可以直接改 MVU 变量与酒馆助手的各种变量，回车后立即写入。MVU 变量修改后会先广播“变量更新结束”事件，监听它的脚本（属性计算、状态栏等）会照常响应；页面没有刷新时点“重新渲染”。</p>
    <h4>生成回复</h4>
    <p>在“AI 回复”里选择一个 AI 帮写的接口后，酒馆里的发送、重新生成以及脚本的 generate 都会用它生成（按接口计费）；酒馆自己的“API 连接”设置不起作用。不选时可以手动插入 AI 消息（包括 MVU 的更新命令）推进剧情。</p>
    <p class="muted small">SillyTavern（AGPL-3.0）与酒馆助手（PolyForm Noncommercial 1.0.0）均未经修改，许可证与源代码地址见安装目录的 sim/NOTICE.txt。</p>` });
}

// ---------- 启动与轮询 ----------
async function tick() {
  await loadStatus();
  try {
    const r = await api('sim.project');
    const before = JSON.stringify([P.project?.version, P.project?.draft, P.project?.errors, P.project?.triggers?.length]);
    P.project = r.project;
    if (P.auto && r.changed && !P.busy && P.status?.workshop) { P.busy = 'install'; try { await api('sim.install'); toast('作品已更新，已重新安装', 'ok', 2000); } catch (e) { toast('自动重装失败：' + e.message, 'error', 6000); } P.busy = ''; await loadStatus(); }
    if (before !== JSON.stringify([P.project?.version, P.project?.draft, P.project?.errors, P.project?.triggers?.length])) { render(); return; }
  } catch {}
  const changed = await loadVars();
  // 只刷新会变的部分，不打断正在进行的输入
  const head = $('.sp-head'), st = $('.sp-status');
  if (head && st) { const t = document.createElement('div'); t.innerHTML = headHtml(); st.replaceWith(t.querySelector('.sp-status')); }
  const proj = $('.sp-sec');
  if (proj && !P.busy) { const t = document.createElement('div'); t.innerHTML = projectHtml(); proj.replaceWith(t.firstElementChild); }
  if (changed) renderTree();
}
(async function start() {
  render();
  await loadState().catch(() => {});
  P.ai = await api('sim.ai').catch(() => null);
  render();
  const loop = async () => { try { await tick(); } catch {} setTimeout(loop, 1500); };
  loop();
})();
