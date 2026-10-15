// 安装到 SillyTavern：本机桥接服务。SillyTavern 页面里的“rwkit 安装桥”脚本（酒馆助手全局脚本）来这里领取任务，
// 再交给页面里的轮回战场创意工坊（window.ReincarnationWorkshop）用它自己的安装器导入并安装，与在工坊里点“安装”完全相同。
// 与 Electron 无关，可单独测试。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import * as core from './core.mjs';

export const DEFAULT_PORT = 27720;
// hold：长轮询最长挂起时间；alive：超过这么久没有轮询视为断开；deliver：任务等待领取的时间；run：领取后等待结果的时间
const T = { hold: 25000, alive: 40000, deliver: 60000, run: 5 * 60000 };
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
class UserError extends Error {}
const fail = msg => { throw new UserError(msg); };

const env = { dataDir: '', log: () => {}, emit: () => {} };
const conf = { enabled: false, port: DEFAULT_PORT, token: '' };
const file = () => path.join(env.dataDir, 'tavern-bridge.json');
function save() {
  try { fs.mkdirSync(env.dataDir, { recursive: true }); fs.writeFileSync(file() + '.tmp', JSON.stringify(conf, null, 1)); fs.renameSync(file() + '.tmp', file()); }
  catch (e) { env.log('保存安装桥设置失败：' + e.message); }
}
export function init(options) {
  const { timeouts, ...rest } = options;
  Object.assign(env, rest);
  if (timeouts) Object.assign(T, timeouts);
  try {
    const s = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (typeof s.enabled === 'boolean') conf.enabled = s.enabled;
    if (Number.isInteger(s.port) && s.port > 1023 && s.port < 65536) conf.port = s.port;
    if (/^[0-9a-f]{48}$/.test(s.token || '')) conf.token = s.token;
  } catch {}
  if (!conf.token) { conf.token = crypto.randomBytes(24).toString('hex'); save(); }
  if (conf.enabled) start().catch(() => {});
}

// ---------- 连接状态 ----------
let server = null, serverError = '';
const waiters = new Set();        // 正在挂起的轮询
let lastSeen = 0, client = null, wasConnected = false;
const connected = () => waiters.size > 0 || Date.now() - lastSeen < T.alive;
export function state() {
  return { enabled: conf.enabled, port: conf.port, running: !!server, error: serverError, connected: !!server && connected(), lastSeen, client: connected() ? client : null, jobs: [...jobs.values()].filter(j => !j.finished).map(publicJob) };
}
function notify(force) {
  const now = connected();
  if (force || now !== wasConnected) { wasConnected = now; env.emit('tavern', { type: 'state', state: state() }); }
}
setInterval(() => notify(false), 5000).unref?.();

// ---------- 任务 ----------
const jobs = new Map();
const publicJob = j => ({ id: j.id, type: j.type, name: j.name, version: j.version, projectId: j.projectId, step: j.step, state: j.state, result: j.result || null });
function finish(j, result) {
  if (j.finished) return;
  j.finished = true; j.state = result.ok ? 'done' : 'failed'; j.result = result;
  clearTimeout(j.timer);
  for (const r of j.resolvers) r(publicJob(j));
  env.emit('tavern', { type: 'job', job: publicJob(j) });
  setTimeout(() => jobs.delete(j.id), 10 * 60000).unref?.();
}
function enqueue(job) {
  const j = { ...job, id: crypto.randomUUID(), state: 'queued', step: 'queued', created: Date.now(), resolvers: [], finished: false };
  j.timer = setTimeout(() => { if (j.state === 'queued') finish(j, { ok: false, code: 'not_connected', error: 'SillyTavern 没有领取任务：请确认 SillyTavern 页面开着，并已启用“rwkit 安装桥”脚本' }); }, T.deliver);
  jobs.set(j.id, j);
  // 有正在等待的轮询就立即交给它
  const w = waiters.values().next().value;
  if (w) w.deliver();
  return j;
}
function takeJob() {
  for (const j of jobs.values()) {
    if (j.state !== 'queued') continue;
    j.state = 'sent'; j.step = 'sent';
    clearTimeout(j.timer);
    j.timer = setTimeout(() => finish(j, { ok: false, code: 'timeout', error: 'SillyTavern 长时间没有返回安装结果，请在 SillyTavern 的创意工坊“本地”页查看状态' }), T.run);
    env.emit('tavern', { type: 'job', job: publicJob(j) });
    return { id: j.id, type: j.type, projectId: j.projectId, name: j.name, version: j.version, fileName: j.fileName, replace: !!j.replace };
  }
  return null;
}
export function waitJob(id, timeout = T.run + T.deliver) {
  const j = jobs.get(id);
  if (!j) return Promise.resolve({ id, state: 'failed', result: { ok: false, error: '任务不存在' } });
  if (j.finished) return Promise.resolve(publicJob(j));
  return new Promise(res => {
    j.resolvers.push(res);
    setTimeout(() => res(publicJob(j)), timeout).unref?.();
  });
}
export function cancelJob(id) {
  const j = jobs.get(id);
  if (j && j.state === 'queued') finish(j, { ok: false, code: 'cancelled', error: '已取消' });
  else if (j && !j.finished) finish(j, { ok: false, code: 'cancelled', error: '已停止等待：SillyTavern 里可能仍在进行，请在创意工坊“本地”页查看结果' });
  return { ok: true };
}

// 把本地项目做成工坊可以导入的离线包文本（重算清单，草稿与有错误的项目不行）
export function packText(p) {
  const R = core.rwkitModule();
  if (!R) fail('rwkit.mjs 不可用');
  const s = core.sourcePack(p);
  if (s.draft) fail('这个离线包有未保存的修改，请先保存为新版本，再安装到 SillyTavern');
  if (s.info?.fatal) fail('本地项目读取出错，修正后才能安装：' + s.info.fatal);
  if (s.info?.errors?.length) fail(`本地项目有 ${s.info.errors.length} 个会让工坊安装失败的问题，修正后才能安装（见“检查结果”）`);
  const pack = s.pack;
  pack.format = R.OFFLINE_FORMAT || 'reincarnation-workshop-project';
  pack.version = R.OFFLINE_VERSION || 1;
  pack.exported_at = Date.now();
  R.rebuildManifest(pack, []);
  R.verifyManifest(pack);
  const text = JSON.stringify(pack);
  if (Buffer.byteLength(text) > R.MAX_OFFLINE_BYTES) fail('离线包超过 6 MB，工坊无法导入');
  return { text, project: pack.project };
}
const safeFile = v => String(v || 'rwpack').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim().slice(0, 80) || 'rwpack';

// ---------- 本机 HTTP 服务 ----------
function cors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'X-Rwkit-Token, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  // 公网上的 SillyTavern 页面访问本机时，浏览器需要这个许可（Private Network Access）
  if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
}
const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
async function readBody(req, max = 2 * 1024 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw new Error('请求过大'); chunks.push(c); }
  const t = Buffer.concat(chunks).toString('utf8');
  try { return t ? JSON.parse(t) : {}; } catch { return {}; }
}
const tokenOk = req => {
  const t = String(req.headers['x-rwkit-token'] || '');
  return t.length === conf.token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(conf.token));
};
function cleanClient(b) {
  const list = Array.isArray(b.installed) ? b.installed.slice(0, 500).filter(isObj).map(x => ({
    id: String(x.id || ''), name: String(x.name || ''), version: Number(x.version) || 0, applied: !!x.applied,
    appliedVersion: x.appliedVersion == null ? null : Number(x.appliedVersion), targetCharacterName: x.targetCharacterName ? String(x.targetCharacterName) : null, source: String(x.source || ''),
  })).filter(x => x.id) : null;
  return { bridge: Number(b.bridge) || 0, workshop: b.workshop ? String(b.workshop) : null, character: b.character ? String(b.character) : null, installed: list, origin: b.origin ? String(b.origin) : '' };
}
async function handleRequest(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const u = new URL(req.url, 'http://127.0.0.1');
  // 所有接口都要配对码：不带配对码时什么都不回答，网页无法借此探测本机是否开着 rwkit
  if (!tokenOk(req)) return send(res, 401, { error: '配对码不正确，请在 rwkit 里重新复制安装桥脚本', code: 'bad_token' });
  if (u.pathname === '/rwkit/ping') return send(res, 200, { app: 'rwkit-desktop', bridge: 1 });
  let m;
  if (u.pathname === '/rwkit/poll' && req.method === 'POST') {
    const b = await readBody(req);
    const before = JSON.stringify(client);
    client = cleanClient(b); lastSeen = Date.now();
    if (JSON.stringify(client) !== before) notify(true); else notify(false);
    const job = takeJob();
    if (job) return send(res, 200, { job });
    // 没有任务：挂起，直到来了任务或超时
    const w = {
      deliver() { const jb = takeJob(); if (jb) { cleanup(); send(res, 200, { job: jb }); } },
    };
    const timer = setTimeout(() => { cleanup(); send(res, 200, { job: null }); }, T.hold);
    const cleanup = () => { clearTimeout(timer); waiters.delete(w); lastSeen = Date.now(); };
    waiters.add(w);
    res.on('close', () => { cleanup(); notify(false); });
    return;
  }
  if ((m = /^\/rwkit\/job\/([\w-]+)\/(pack|progress|result)$/.exec(u.pathname))) {
    const j = jobs.get(m[1]);
    if (!j || j.finished) return send(res, 404, { error: '任务不存在或已结束', code: 'no_job' });
    if (m[2] === 'pack') return send(res, 200, j.text, 'application/json; charset=utf-8');
    const b = await readBody(req);
    if (m[2] === 'progress') {
      // 只往前走：网络先后不一时，旧的进度不覆盖新的
      const next = String(b.step || ''), order = ['queued', 'sent', 'download', 'uninstall', 'import', 'preflight', 'apply'];
      if (order.indexOf(next) > order.indexOf(j.step)) { j.step = next; env.emit('tavern', { type: 'job', job: publicJob(j) }); }
      return send(res, 200, { ok: true });
    }
    finish(j, { ok: !!b.ok, error: b.ok ? '' : String(b.error || '安装失败'), code: String(b.code || ''), warnings: Array.isArray(b.warnings) ? b.warnings.map(w => String(w).slice(0, 500)).slice(0, 50) : [],
      // 页面报回的安装记录只保留需要的字段
      record: isObj(b.record) ? { appliedVersion: Number(b.record.appliedVersion) || null, targetCharacterName: b.record.targetCharacterName ? String(b.record.targetCharacterName).slice(0, 200) : null, restoreWarnings: Number(b.record.restoreWarnings) || 0 } : null });
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not found' });
}
export function start() {
  if (server) return Promise.resolve(state());
  return new Promise(res => {
    const s = http.createServer((req, rs) => { handleRequest(req, rs).catch(e => { env.log('安装桥请求失败：' + e.message); send(rs, 500, { error: e.message }); }); });
    s.on('error', e => {
      serverError = e.code === 'EADDRINUSE' ? `端口 ${conf.port} 已被占用，请换一个端口` : '安装桥启动失败：' + e.message;
      server = null; env.log(serverError); notify(true); res(state());
    });
    s.listen(conf.port, '127.0.0.1', () => { server = s; serverError = ''; notify(true); res(state()); });
  });
}
export function stop() {
  for (const w of waiters) w.deliver?.();
  waiters.clear();
  return new Promise(res => { if (!server) return res(); server.close(() => res()); server.closeAllConnections?.(); server = null; }).then(() => { client = null; lastSeen = 0; notify(true); return state(); });
}

// ---------- 酒馆助手脚本 ----------
export function bridgeScript() {
  const content = BRIDGE_SOURCE.replace('__PORT__', String(conf.port)).replace('__TOKEN__', conf.token);
  return {
    content,
    json: { type: 'script', enabled: true, name: 'rwkit 安装桥', id: 'rwkit-bridge-' + conf.token.slice(0, 12), content, info: '让本机的 rwkit 离线包工具把离线包交给轮回战场创意工坊安装。只连接这台电脑上的 rwkit（127.0.0.1:' + conf.port + '），不联网。', button: { enabled: false, buttons: [] }, data: {}, export_with: { data: true, button: true } },
  };
}
// 页面里运行的脚本：只依赖浏览器 fetch 与创意工坊公开的 window.ReincarnationWorkshop
const BRIDGE_SOURCE = `// rwkit 安装桥：让本机的 rwkit 离线包工具把离线包交给轮回战场创意工坊安装（与在工坊里点“安装”相同）。
// 只连接这台电脑上的 rwkit；配对码由 rwkit 生成，重新生成后需要重新复制本脚本。
(() => {
  const ENDPOINT = 'http://127.0.0.1:__PORT__';
  const TOKEN = '__TOKEN__';
  const BRIDGE = 1;
  const host = (() => { let w = window; try { while (w.parent && w.parent !== w && w.parent.document) w = w.parent; } catch (e) {} return w; })();
  let stopped = false, ctl = null, badToken = false;
  const wakers = new Set();
  const sleep = ms => new Promise(r => { const wake = () => { clearTimeout(t); wakers.delete(wake); r(); }; const t = setTimeout(wake, ms); wakers.add(wake); });
  const toast = (kind, msg) => { try { (host.toastr || window.toastr)?.[kind]?.(msg, 'rwkit 安装桥'); } catch (e) {} };
  const call = (p, opt = {}) => fetch(ENDPOINT + p, { method: opt.method || 'GET', body: opt.body, signal: opt.signal, headers: { 'X-Rwkit-Token': TOKEN, ...(opt.body ? { 'Content-Type': 'application/json' } : {}) } });
  const workshop = () => { try { return host.ReincarnationWorkshop || null; } catch (e) { return null; } };
  async function waitWorkshop(ms) { const end = Date.now() + ms; while (Date.now() < end) { const w = workshop(); if (w && typeof w.importProject === 'function') return w; await sleep(500); } return null; }
  function character() {
    for (const f of [window.getCurrentCharacterName, host.TavernHelper && host.TavernHelper.getCurrentCharacterName]) { try { if (typeof f === 'function') { const v = f(); if (v) return String(v); } } catch (e) {} }
    try { const c = host.SillyTavern.getContext(); return (c.characters[c.characterId] || {}).name || null; } catch (e) { return null; }
  }
  let listCache = null, listAt = 0;
  async function installed(force) {
    const w = workshop();
    if (!w || typeof w.listInstalled !== 'function') return null;
    if (!force && listCache && Date.now() - listAt < 60000) return listCache;
    try { listCache = (await w.listInstalled()).map(p => ({ id: p.id, name: p.name, version: p.version, applied: !!p.applied, appliedVersion: p.appliedVersion, targetCharacterName: p.targetCharacterName, source: p.source })); listAt = Date.now(); } catch (e) {}
    return listCache;
  }
  async function status(force) { const w = workshop(); return { bridge: BRIDGE, workshop: w ? String(w.version || '') : null, character: character(), installed: await installed(force), origin: String(host.location && host.location.origin || '') }; }
  async function runJob(job) {
    const post = (what, body) => call('/rwkit/job/' + job.id + '/' + what, { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
    const step = s => post('progress', { step: s });
    try {
      const w = await waitWorkshop(15000);
      if (!w) throw new Error('SillyTavern 里没有加载轮回战场创意工坊：请打开带“创意工坊”脚本的轮回战场角色卡');
      if (job.type === 'uninstall') {
        await step('uninstall');
        await w.uninstallProject(job.projectId);
        try { await w.refresh(); } catch (e) {}
        await post('result', { ok: true });
        toast('success', '已从酒馆卸载“' + job.name + '”');
        return;
      }
      await step('download');
      const r = await call('/rwkit/job/' + job.id + '/pack');
      if (!r.ok) throw new Error('从 rwkit 读取离线包失败（' + r.status + '）');
      const text = await r.text();
      const prev = (await w.listInstalled()).find(p => p.id === job.projectId);
      if (prev && prev.applied) {
        if (!job.replace) { const e = new Error('“' + prev.name + '”已经安装了 v' + prev.appliedVersion); e.code = 'installed'; throw e; }
        await step('uninstall');
        await w.uninstallProject(job.projectId);
      }
      await step('import');
      await w.importProject(new File([text], job.fileName, { type: 'application/json' }));
      await step('preflight');
      const pf = typeof w.preflightProject === 'function' ? await w.preflightProject(job.projectId) : null;
      if (pf && pf.blocking && pf.blocking.length) { const e = new Error('安装检查未通过：' + pf.blocking.map(b => b.message || b.type).join('；')); e.code = 'blocked'; throw e; }
      await step('apply');
      const rec = await w.applyProject(job.projectId);
      try { await w.refresh(); } catch (e) {}
      await post('result', { ok: true, warnings: ((pf && pf.warnings) || []).map(x => x.message || x.type), record: { appliedVersion: rec && rec.appliedVersion, targetCharacterName: rec && rec.targetCharacterName, restoreWarnings: (rec && rec.restoreWarnings || []).length } });
      toast('success', '已安装“' + job.name + '” v' + job.version);
    } catch (e) {
      await post('result', { ok: false, error: String(e && e.message || e), code: e && e.code || '' });
      toast('error', '“' + job.name + '”' + (job.type === 'uninstall' ? '卸载' : '安装') + '失败：' + (e && e.message || e));
    } finally { listAt = 0; }
  }
  async function loop() {
    let failures = 0;
    while (!stopped) {
      try {
        ctl = new AbortController();
        const r = await call('/rwkit/poll', { method: 'POST', body: JSON.stringify(await status(failures > 0)), signal: ctl.signal });
        if (r.status === 401) { if (!badToken) toast('error', '配对码不正确：请在 rwkit 里重新复制安装桥脚本'); badToken = true; await sleep(30000); continue; }
        badToken = false; failures = 0;
        const d = await r.json();
        if (d && d.job) await runJob(d.job);
      } catch (e) { if (stopped) break; failures++; await sleep(Math.min(30000, 2000 * failures)); }
    }
  }
  window.addEventListener('pagehide', () => { stopped = true; try { ctl && ctl.abort(); } catch (e) {} for (const w of [...wakers]) w(); }, { once: true });
  loop();
})();
`;

// ---------- 路由 ----------
export async function handle(route, b = {}) {
  try {
    switch (route) {
      case 'st.state': return state();
      case 'st.enable': conf.enabled = !!b.enabled; save(); return conf.enabled ? await start() : await stop();
      case 'st.port': {
        const p = Number(b.port);
        if (!Number.isInteger(p) || p < 1024 || p > 65535) fail('端口应为 1024～65535 之间的整数');
        conf.port = p; save();
        if (server) { await stop(); await start(); }
        return state();
      }
      case 'st.regen': conf.token = crypto.randomBytes(24).toString('hex'); save(); return state();
      case 'st.script': return bridgeScript();
      case 'st.install': {
        if (!server) { conf.enabled = true; save(); await start(); if (!server) fail(serverError || '安装桥没有启动'); }
        const { text, project } = packText(path.resolve(String(b.path || '')));
        const j = enqueue({ type: 'install', text, projectId: String(project.id), name: project.name, version: Number(project.version), fileName: `${safeFile(project.name)}-v${project.version}.rwpack`, replace: !!b.replace });
        return { ok: true, job: publicJob(j) };
      }
      case 'st.uninstall': {
        if (!server) fail('安装桥没有启动');
        const j = enqueue({ type: 'uninstall', projectId: String(b.projectId || ''), name: String(b.name || b.projectId || ''), version: null });
        return { ok: true, job: publicJob(j) };
      }
      case 'st.wait': return { ok: true, job: await waitJob(String(b.id || '')) };
      case 'st.cancel': return cancelJob(String(b.id || ''));
    }
    fail('不认识的请求：' + route);
  } catch (e) {
    if (!(e instanceof UserError) && !core.isUserError(e)) env.log(e.stack || String(e));
    return { ok: false, error: String(e.message || e) };
  }
}
