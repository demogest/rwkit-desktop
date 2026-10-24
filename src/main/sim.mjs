// 模拟酒馆：在单独的窗口里运行官方 SillyTavern 前端、酒馆助手与提示词模板（版本见 vendor/sim/versions.json），
// SillyTavern 的服务器由 sim-server.mjs 模拟。右侧是 rwkit 的控制面板：安装作品、修改变量、插入消息、查看日志。
// 酒馆页面在独立的会话里运行（不能访问 rwkit 的接口），面板通过主进程读写酒馆页面里的酒馆助手接口。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BaseWindow, WebContentsView, session, net, shell, nativeTheme } from 'electron';
import { createServer, triggersOf } from './sim-server.mjs';

const PARTITION = 'persist:rwkit-sim';
const ORIGIN = 'rwsim://st';
// 角色卡脚本常用的 CDN：缓存到本机，离线时也能运行
const CDN_HOSTS = new Set(['cdn.jsdelivr.net', 'testingcf.jsdelivr.net', 'fastly.jsdelivr.net', 'gcore.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'esm.sh']);

const env = { vendorDir: '', dataDir: '', preload: '', panelUrl: '', log: () => {}, packText: null, sourcePack: null, state: null, saveState: null, dev: false };
const S = { win: null, st: null, panel: null, server: null, ses: null, logs: [], panelWidth: 380, ready: false, card: null };

export function init(options) { Object.assign(env, options); }
export function available() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(env.vendorDir, 'versions.json'), 'utf8'));
    if (!fs.existsSync(path.join(env.vendorDir, 'st', 'public', 'index.html')) || !fs.existsSync(path.join(env.vendorDir, 'th', 'dist', 'index.js'))) throw new Error('文件不完整');
    return { ok: true, versions: v };
  } catch (e) { return { ok: false, error: '没有找到模拟酒馆的运行文件（' + e.message + '）' }; }
}
const versions = () => available().versions || {};

// ---------- 日志：酒馆页面的控制台输出与接口问题 ----------
function addLog(level, text, source = '') {
  const item = { t: Date.now(), level, text: String(text).slice(0, 4000), source: String(source || '').slice(0, 300) };
  S.logs.push(item);
  if (S.logs.length > 500) S.logs.splice(0, S.logs.length - 500);
  toPanel('sim-log', item);
}
const toPanel = (type, data) => { if (S.panel && !S.panel.webContents.isDestroyed()) S.panel.webContents.send('evt', type, data); };

// ---------- 会话：模拟服务器 + CDN 缓存 ----------
function setupSession() {
  if (S.ses) return S.ses;
  const ses = session.fromPartition(PARTITION);
  S.server = createServer({
    vendorDir: env.vendorDir, dataDir: path.join(env.dataDir, 'data'), version: versions(), log: m => { env.log(m); addLog('warn', m, 'rwkit'); },
    hooks: { route: (req, p) => route(req, p), generate: (b, signal) => generate(b, signal), chatSaved: () => toPanel('sim-changed', { what: 'chat' }) },
  });
  ses.protocol.handle('rwsim', req => S.server.handle(req));
  const cacheDir = path.join(env.dataDir, 'cdn-cache');
  ses.protocol.handle('https', async req => {
    const u = new URL(req.url);
    if (req.method !== 'GET' || !CDN_HOSTS.has(u.hostname)) return net.fetch(req, { bypassCustomProtocolHandlers: true });
    const key = crypto.createHash('sha256').update(req.url).digest('hex');
    const body = path.join(cacheDir, key), meta = body + '.json';
    try {
      const r = await net.fetch(req.url, { bypassCustomProtocolHandlers: true, signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        const type = r.headers.get('content-type') || 'application/octet-stream';
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(body, buf); fs.writeFileSync(meta, JSON.stringify({ url: req.url, type, at: Date.now() }));
        return new Response(buf, { status: 200, headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
      }
      if (!fs.existsSync(body)) return r;
    } catch (e) {
      if (!fs.existsSync(body)) { addLog('error', '无法下载 ' + req.url + '：' + e.message, 'rwkit'); return new Response('', { status: 504 }); }
    }
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    return new Response(fs.readFileSync(body), { status: 200, headers: { 'content-type': m.type, 'access-control-allow-origin': '*', 'x-rwkit-cache': '1' } });
  });
  // 页面不需要的权限一律拒绝
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'clipboard-sanitized-write' || perm === 'fullscreen'));
  S.ses = ses;
  return ses;
}
// ---------- 生成回复：用面板里选择的 AI 接口回答酒馆的请求（OpenAI 的流式格式） ----------
const FINISH = { end_turn: 'stop', stop: 'stop', STOP: 'stop', max_tokens: 'length', length: 'length', MAX_TOKENS: 'length' };
const errorResponse = (msg, status = 400) => new Response(JSON.stringify({ error: { message: msg } }), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
async function generate(b, signal) {
  const profile = env.state?.().aiProfile || '';
  if (!profile) return errorResponse('模拟酒馆还没有选择回复用的 AI 接口：在右侧面板的“AI 回复”里选择一个（接口在 rwkit 的“AI 帮写设置”里添加）');
  const common = { profile, messages: b.messages, maxTokens: b.max_tokens, temperature: b.temperature, signal };
  addLog('info', `生成回复：${(b.messages || []).length} 条消息`, 'rwkit');
  if (!b.stream) {
    let text = '';
    try {
      const r = await env.ai.chat({ ...common, onText: d => { text += d; } });
      return new Response(JSON.stringify({ id: 'rwkit-' + Date.now(), object: 'chat.completion', model: 'rwkit', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: FINISH[r.stop] || 'stop' }] }), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    } catch (e) { addLog('error', '生成回复失败：' + e.message, 'rwkit'); return errorResponse(signal.aborted ? '已停止' : e.message); }
  }
  // 流式：等到第一段文字再开始回应，开始前出错时酒馆会显示错误提示
  const enc = new TextEncoder(), queue = [];
  let ctl = null, first, ended = false;
  const firstOut = new Promise(res => { first = res; });
  const push = o => { const chunk = enc.encode('data: ' + (typeof o === 'string' ? o : JSON.stringify(o)) + '\n\n'); if (ctl) ctl.enqueue(chunk); else queue.push(chunk); };
  const close = () => { ended = true; if (ctl) { try { ctl.close(); } catch {} } };
  env.ai.chat({ ...common, onText: d => { push({ choices: [{ index: 0, delta: { content: d } }] }); first(null); } })
    .then(r => { push({ choices: [{ index: 0, delta: {}, finish_reason: FINISH[r.stop] || 'stop' }] }); push('[DONE]'); first(null); close(); })
    .catch(e => {
      if (!signal.aborted) addLog('error', '生成回复失败：' + e.message, 'rwkit');
      first(e);
      push({ error: { message: signal.aborted ? '已停止' : e.message } });
      close();
    });
  // firstOut 只认第一次：有错误说明还没有任何文字，直接以错误回应
  const err = await firstOut;
  if (err) return errorResponse(signal.aborted ? '已停止' : err.message);
  return new Response(new ReadableStream({ start(c) { ctl = c; for (const q of queue) c.enqueue(q); queue.length = 0; if (ended) c.close(); } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } });
}

// rwkit 自己的路径：当前作品的离线包（交给工坊安装）
const packs = new Map();
async function route(req, p) {
  // 开发自测：读取本机文件（例如要导入的角色卡）
  if (env.dev && p === '/__rwkit/devfile') { try { return new Response(fs.readFileSync(new URL(req.url).searchParams.get('p'))); } catch { return new Response(null, { status: 404 }); } }
  const m = /^\/__rwkit\/pack\/([\w-]+)$/.exec(p);
  if (m) { const t = packs.get(m[1]); return t ? new Response(t, { headers: { 'content-type': 'application/json; charset=utf-8' } }) : new Response(null, { status: 404 }); }
  return null;
}

// ---------- 窗口 ----------
function layout() {
  if (!S.win) return;
  const [w, h] = S.win.getContentSize();
  const pw = S.panel?.visible === false ? 0 : Math.min(S.panelWidth, Math.max(280, w - 480));
  S.st.setBounds({ x: 0, y: 0, width: w - pw, height: h });
  S.panel?.setBounds({ x: w - pw, y: 0, width: pw, height: h });
}
function guard(wc, own) {
  wc.on('will-navigate', (e, url) => { if (!url.startsWith(own)) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
  wc.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}
// 两种环境：内置（随 rwkit 附带的 SillyTavern，服务器由 rwkit 模拟）与本机（你自己运行的 SillyTavern，用它的地址打开）
const LOCAL_PARTITION = 'persist:rwkit-st-local';
const mode = () => (env.state?.().mode === 'local' && env.state?.().localUrl ? 'local' : 'builtin');
const pageUrl = () => (mode() === 'local' ? env.state().localUrl : ORIGIN + '/');
const pageOrigin = () => new URL(pageUrl()).origin;
function localSession() {
  const ses = session.fromPartition(LOCAL_PARTITION);
  if (!S.localSes) { ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'clipboard-sanitized-write' || perm === 'fullscreen')); S.localSes = ses; }
  return ses;
}
// 酒馆页面：独立会话、沙箱、没有预加载脚本
function stView() {
  const local = mode() === 'local';
  if (local) localSession(); else setupSession();
  const v = new WebContentsView({ webPreferences: { partition: local ? LOCAL_PARTITION : PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false } });
  guard(v.webContents, pageOrigin() + '/');
  v.webContents.on('console-message', (...args) => {
    const d = args[0], level = d?.level ?? args[1], msg = d?.message ?? args[2], src = d?.sourceId ?? args[4];
    const lv = level === 'error' || level === 3 ? 'error' : level === 'warning' || level === 2 ? 'warn' : level === 'info' || level === 1 ? 'info' : 'debug';
    if (lv === 'debug' && !/rwkit|TH|酒馆助手|mvu|MVU/i.test(String(msg))) return;
    addLog(lv, msg, src);
  });
  v.webContents.on('render-process-gone', (_e, d) => addLog('error', '酒馆页面已崩溃：' + d.reason, 'rwkit'));
  v.webContents.on('did-finish-load', () => toPanel('sim-state', { loaded: true }));
  v.webContents.on('did-fail-load', (_e, code, desc, url, main) => { if (main && code !== -3) addLog('error', `打不开 ${url}：${desc}${local ? '（请确认 SillyTavern 已经启动）' : ''}`, 'rwkit'); });
  return v;
}
export function open({ offscreen = false } = {}) {
  if (mode() === 'builtin') { const a = available(); if (!a.ok) return a; }
  if (S.win && !S.win.isDestroyed()) { S.win.show(); S.win.focus(); return { ok: true }; }
  const b = env.state?.() || {};
  // 自测时放在屏幕外（隐藏的窗口无法截图）
  const away = offscreen && env.dev;
  S.win = new BaseWindow({ width: b.w || 1440, height: b.h || 900, minWidth: 900, minHeight: 600, title: 'rwkit 模拟酒馆', backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f3f4f7', ...(away ? { x: -6000, y: 0, show: false } : {}) });
  if (away) S.win.showInactive();
  S.st = stView();
  // 控制面板：rwkit 自己的页面
  S.panel = new WebContentsView({ webPreferences: { preload: env.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
  guard(S.panel.webContents, 'app://ui/');
  S.win.contentView.addChildView(S.st);
  S.win.contentView.addChildView(S.panel);
  layout();
  S.win.on('resize', layout);
  S.win.on('close', () => { const [w, h] = S.win.getSize(); env.saveState?.({ w, h }); });
  S.win.on('closed', () => { S.win = S.st = S.panel = null; S.ready = false; });
  S.panel.webContents.loadURL(env.panelUrl);
  S.st.webContents.loadURL(pageUrl());
  return { ok: true };
}
// 切换环境：换掉酒馆页面（两种环境的会话不同），面板保留
async function setMode(m, url) {
  if (m === 'local') {
    let u;
    try { u = new URL(String(url || '').trim()); } catch { throw new Error('地址格式不对，例如 http://127.0.0.1:8000'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('地址应以 http:// 或 https:// 开头');
    try { await net.fetch(u.href, { signal: AbortSignal.timeout(6000) }); } catch (e) { throw new Error(`连不上 ${u.origin}：请先启动你的 SillyTavern（${e.cause?.code || e.message}）`); }
    env.saveState?.({ mode: 'local', localUrl: u.origin + '/' });
  } else {
    const a = available(); if (!a.ok) throw new Error(a.error);
    env.saveState?.({ mode: 'builtin' });
  }
  S.installedSig = null;
  if (S.win && !S.win.isDestroyed()) {
    const old = S.st;
    S.st = stView();
    S.win.contentView.addChildView(S.st, 0);
    S.win.contentView.removeChildView(old);
    old.webContents.close();
    layout();
    S.st.webContents.loadURL(pageUrl());
  }
  toPanel('sim-mode', { mode: mode(), url: pageUrl() });
  return { mode: mode(), url: pageUrl() };
}
export const isPanel = wc => !!S.panel && wc === S.panel.webContents;
export const window = () => S.win;

// 在酒馆页面里执行代码（只用于 rwkit 自己写的固定代码，参数以 JSON 传入）
async function inPage(fn, ...args) {
  if (!S.st || S.st.webContents.isDestroyed()) throw new Error('模拟酒馆没有打开');
  const code = `(async () => { const __f = ${fn}; return await __f(...${JSON.stringify(args)}); })()`;
  return S.st.webContents.executeJavaScript(code, true);
}

// ---------- 在酒馆页面里执行的操作（用酒馆助手、MVU 与创意工坊自己的接口） ----------
const PAGE = {
  status: `async () => {
    const c = (() => { try { return SillyTavern.getContext(); } catch (e) { return null; } })();
    const w = window.ReincarnationWorkshop;
    let installed = null;
    if (w && typeof w.listInstalled === 'function') { try { installed = (await w.listInstalled()).map(p => ({ id: p.id, name: p.name, version: p.version, applied: !!p.applied, appliedVersion: p.appliedVersion })); } catch (e) {} }
    const ch = c && c.characterId !== undefined ? c.characters[c.characterId] : null;
    let th = null; try { th = window.TavernHelper ? String(TavernHelper.getTavernHelperVersion?.() || '') : null; } catch (e) { th = ''; }
    return { ready: !!c, character: ch ? ch.name : null, chat: c ? c.chat.length : 0, chatId: c && c.chatId || null, th, mvu: !!(window.Mvu && typeof Mvu.getMvuData === 'function'), workshop: w ? String(w.version || '') : null, installed };
  }`,
  // 与“安装到 SillyTavern”相同的流程：卸载旧版本 → 导入 → 安装检查 → 应用
  install: `async (src, id, fileName) => {
    const w = window.ReincarnationWorkshop;
    if (!w || typeof w.importProject !== 'function') throw new Error('没有加载轮回战场创意工坊：请先导入并打开轮回战场角色卡，允许它的脚本');
    const text = src.text != null ? src.text : await (await fetch(src.url)).text();
    const prev = (await w.listInstalled()).find(p => p.id === id);
    if (prev && prev.applied) await w.uninstallProject(id);
    await w.importProject(new File([text], fileName, { type: 'application/json' }));
    const pf = typeof w.preflightProject === 'function' ? await w.preflightProject(id) : null;
    if (pf && pf.blocking && pf.blocking.length) throw new Error('安装检查未通过：' + pf.blocking.map(b => b.message || b.type).join('；'));
    const rec = await w.applyProject(id);
    try { await w.refresh(); } catch (e) {}
    return { warnings: ((pf && pf.warnings) || []).map(x => x.message || x.type), appliedVersion: rec && rec.appliedVersion, target: rec && rec.targetCharacterName };
  }`,
  uninstall: `async id => { const w = window.ReincarnationWorkshop; if (!w) throw new Error('没有加载轮回战场创意工坊'); await w.uninstallProject(id); try { await w.refresh(); } catch (e) {} return true; }`,
  // 变量：mvu 为最新楼层的 MVU 数据（stat_data），其余为酒馆助手的变量表
  vars: `async scope => {
    if (scope === 'mvu') {
      if (!window.Mvu || typeof Mvu.getMvuData !== 'function') return { error: 'MVU 还没有加载（需要带 MVU 脚本的角色卡）' };
      if (!SillyTavern.getContext().chat.length) return { error: '聊天里还没有消息' };
      const d = Mvu.getMvuData({ type: 'message', message_id: 'latest' });
      return { data: d && d.stat_data !== undefined ? d.stat_data : null, empty: !d || d.stat_data === undefined };
    }
    if (!window.TavernHelper) return { error: '酒馆助手还没有加载' };
    if (scope === 'message' && !SillyTavern.getContext().chat.length) return { error: '聊天里还没有消息' };
    return { data: TavernHelper.getVariables(scope === 'message' ? { type: 'message', message_id: 'latest' } : { type: scope }) };
  }`,
  setVars: `async (scope, data, notify) => {
    if (scope === 'mvu') {
      const old = Mvu.getMvuData({ type: 'message', message_id: 'latest' }) || {};
      const next = JSON.parse(JSON.stringify(old)); next.stat_data = data;
      // 先广播“变量更新结束”，让监听它的脚本（属性计算、状态栏等）照常处理，再写回最新楼层
      if (notify) await SillyTavern.getContext().eventSource.emit(Mvu.events.VARIABLE_UPDATE_ENDED, next, old);
      await Mvu.replaceMvuData(next, { type: 'message', message_id: 'latest' });
      return true;
    }
    TavernHelper.replaceVariables(data, scope === 'message' ? { type: 'message', message_id: 'latest' } : { type: scope });
    return true;
  }`,
  // 与酒馆收到或发送一条消息时相同：加入聊天 → 广播收到/发送事件（MVU 在这时处理变量） → 显示 → 广播显示完成 → 保存
  addMessage: `async (role, text) => {
    const c = SillyTavern.getContext(), user = role === 'user', T = c.eventTypes;
    const date = new Date().toLocaleString();
    c.chat.push(user ? { name: c.name1, is_user: true, is_system: false, send_date: date, mes: text, extra: {} }
      : { name: c.name2, is_user: false, is_system: false, send_date: date, mes: text, extra: {}, swipes: [text], swipe_id: 0, swipe_info: [{ send_date: date, extra: {} }] });
    const id = c.chat.length - 1;
    await c.eventSource.emit(user ? T.MESSAGE_SENT : T.MESSAGE_RECEIVED, id, 'normal');
    c.addOneMessage(c.chat[id]);
    await c.eventSource.emit(user ? T.USER_MESSAGE_RENDERED : T.CHARACTER_MESSAGE_RENDERED, id, 'normal');
    await c.saveChat();
    return id;
  }`,
  newChat: `async () => { await SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'); return true; }`,
  rerender: `async () => { await SillyTavern.getContext().reloadCurrentChat(); return true; }`,
};

// ---------- 当前作品：由主窗口打开模拟酒馆时指定 ----------
// 面板每隔一会儿就询问一次：内容签名没变时直接用上次的结果
function project() {
  if (!S.project) return null;
  try {
    const sig = sigOf(S.project.path);
    if (S.projCache?.sig === sig && S.projCache.path === S.project.path) return S.projCache.value;
    const s = env.sourcePack(S.project.path);
    const value = { path: S.project.path, name: s.pack.project?.name || '', id: s.pack.project?.id || '', version: s.pack.project?.version, draft: s.draft, errors: s.info?.errors?.length || 0, fatal: s.info?.fatal || '', triggers: triggersOf(s.pack) };
    S.projCache = { sig, path: S.project.path, value };
    return value;
  } catch (e) { return { path: S.project.path, error: String(e.message || e) }; }
}
async function install() {
  const p = project();
  if (!p || p.error) throw new Error(p?.error || '没有指定作品：请在 rwkit 主窗口的作品页点“模拟预览”');
  const { text, project: pj } = env.packText(p.path, { allowDraft: true });
  const id = crypto.randomUUID();
  packs.set(id, text);
  setTimeout(() => packs.delete(id), 120000).unref?.();
  const fileName = (pj.name || 'rwpack').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_') + '-v' + pj.version + '.rwpack';
  // 内置环境从 rwkit 的地址读取；本机的酒馆访问不到这个地址，直接把内容交给页面
  const r = await inPage(PAGE.install, mode() === 'local' ? { text } : { url: ORIGIN + '/__rwkit/pack/' + id }, pj.id, fileName);
  S.installedSig = sigOf(p.path);
  return r;
}
const sigOf = p => { try { return String(env.sourceSig(p)); } catch { return ''; } };

// ---------- 面板的请求 ----------
export async function handle(route, b = {}) {
  try {
    switch (route) {
      case 'sim.available': return available();
      case 'sim.open': {
        if (b.project) { S.project = { path: path.resolve(String(b.project)) }; toPanel('sim-project', project()); }
        return open(b);
      }
      case 'sim.state': return { ok: true, versions: versions(), project: project(), logs: S.logs.slice(-300), unknown: [...(S.server?.unknown || [])], auto: !!S.auto, mode: mode(), localUrl: env.state?.().localUrl || 'http://127.0.0.1:8000/', builtin: available().ok };
      case 'sim.setMode': return { ok: true, ...(await setMode(b.mode === 'local' ? 'local' : 'builtin', b.url)) };
      case 'sim.project': return { ok: true, project: project(), changed: !!S.installedSig && S.project && sigOf(S.project.path) !== S.installedSig };
      case 'sim.status': return { ok: true, ...(await inPage(PAGE.status)) };
      case 'sim.install': return { ok: true, ...(await install()) };
      case 'sim.uninstall': return { ok: true, value: await inPage(PAGE.uninstall, String(b.id)) };
      case 'sim.auto': S.auto = !!b.on; return { ok: true };
      // 回复用的 AI 接口（来自 AI 帮写设置）；空表示不生成
      case 'sim.ai': return { ok: true, ...env.ai.profiles(), selected: env.state?.().aiProfile || '' };
      case 'sim.setAi': env.saveState?.({ aiProfile: String(b.id || '') }); return { ok: true };
      case 'sim.vars': return { ok: true, ...(await inPage(PAGE.vars, String(b.scope || 'mvu'))) };
      case 'sim.setVars': return { ok: true, value: await inPage(PAGE.setVars, String(b.scope || 'mvu'), b.data ?? {}, b.notify !== false) };
      case 'sim.addMessage': return { ok: true, id: await inPage(PAGE.addMessage, b.role === 'user' ? 'user' : 'assistant', String(b.text ?? '')) };
      case 'sim.newChat': await inPage(PAGE.newChat); return { ok: true };
      case 'sim.rerender': await inPage(PAGE.rerender); return { ok: true };
      // 清空模拟酒馆：关闭窗口，删除数据文件夹与页面存储（CDN 缓存保留）
      case 'sim.reset': {
        if (S.win && !S.win.isDestroyed()) S.win.close();
        await setupSession().clearStorageData();
        fs.rmSync(path.join(env.dataDir, 'data'), { recursive: true, force: true });
        S.logs = []; S.installedSig = null;
        return { ok: true };
      }
      case 'sim.reload': S.st?.webContents.reload(); return { ok: true };
      case 'sim.devtools': S.st?.webContents.openDevTools({ mode: 'detach' }); return { ok: true };
      case 'sim.clearLogs': S.logs = []; return { ok: true };
      // 开发自测：在酒馆页面里执行任意代码
      case 'sim.eval': if (!env.dev) break; return { ok: true, value: await inPage(b.fn, ...(b.args || [])) };
      case 'sim.evalPanel': if (!env.dev) break; return { ok: true, value: await S.panel.webContents.executeJavaScript('(async () => (' + b.fn + ')())()', true) };
      // 开发自测：截取酒馆页面
      case 'sim.capture': { if (!env.dev) break; const img = await (b.target === 'panel' ? S.panel : S.st).webContents.capturePage(); fs.writeFileSync(String(b.file), img.toPNG()); return { ok: true, size: img.getSize() }; }
    }
    return { ok: false, error: '不认识的请求：' + route };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
export const debug = { inPage, S };
