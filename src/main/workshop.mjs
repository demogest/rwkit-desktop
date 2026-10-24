// 轮回战场创意工坊在线服务：Discord 登录、浏览、下载为离线包、发布与更新作品。与 Electron 无关，可单独测试。
// 接口与官方工坊客户端（Unspoken-MomoTea/Battlefield-of-Reincarnation，src/CreativeWorkshop）一致。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as core from './core.mjs';
import { publishIssues, contentKind, displayCategory, normTags, LIMITS as WL } from './limits.mjs';

export const SERVERS = [
  { base: 'https://workshop.6661816.xyz', label: '正式服' },
  { base: 'https://workshop-test.6661816.xyz', label: '测试服' },
];
const LIMITS = { bundle: 4_000_000, request: 5 * 1024 * 1024, cover: 3 * 1024 * 1024, changelog: 2000, name: 80, summary: 2000, tags: 12, tag: 24, deps: 12 };
const COVER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const KINDS = ['extension', 'store_catalog', 'world_character', 'opening_character', 'opening_partner', 'heretic'];
const SORTS = ['latest', 'popular', 'downloads', 'likes', 'favorites'];
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const bytes = s => Buffer.byteLength(s, 'utf8');
class UserError extends Error {}
const fail = msg => { throw new UserError(msg); };

// ---------- 运行环境 ----------
const env = {
  dataDir: '',
  appVersion: '0.0.0',
  openExternal: async () => {},
  // 登录凭据加密（Electron safeStorage）；不可用时明文保存在用户数据文件夹
  encrypt: null,
  decrypt: null,
  fetch: (...a) => globalThis.fetch(...a),
  // 缩略图（Electron nativeImage）；没有时返回原图
  thumb: null,
  // 缩略图磁盘缓存（发现页封面原图常有几 MB，缓存缩好的 JPEG，下次启动不再重新下载）
  cacheDir: '',
  log: () => {},
  emit: () => {},
};
const store = { base: SERVERS[0].base, downloadDir: '', checkUpdates: true, auth: {}, links: {} };
const file = () => path.join(env.dataDir, 'workshop.json');
export function init(options) {
  Object.assign(env, options);
  try {
    const s = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (typeof s.base === 'string' && /^https?:\/\//.test(s.base)) store.base = s.base.replace(/\/+$/, '');
    if (typeof s.downloadDir === 'string') store.downloadDir = s.downloadDir;
    if (typeof s.checkUpdates === 'boolean') store.checkUpdates = s.checkUpdates;
    if (isObj(s.auth)) store.auth = s.auth;
    if (isObj(s.links)) store.links = s.links;
  } catch {}
}
function save() {
  try {
    fs.mkdirSync(env.dataDir, { recursive: true });
    fs.writeFileSync(file() + '.tmp', JSON.stringify(store, null, 1));
    fs.renameSync(file() + '.tmp', file());
  } catch (e) { env.log('保存工坊设置失败：' + e.message); }
}

// ---------- 登录状态 ----------
const avatars = new Map();
function sealToken(token) {
  if (env.encrypt) { try { return { enc: env.encrypt(token) }; } catch {} }
  return { plain: token };
}
function openToken(a) {
  if (a?.enc && env.decrypt) { try { return env.decrypt(a.enc); } catch { return null; } }
  return typeof a?.plain === 'string' ? a.plain : null;
}
function session() {
  const a = store.auth[store.base];
  if (!a) return null;
  if (!(Number(a.expiresAt) > Date.now() / 1000)) { clearSession(); return null; }
  const token = openToken(a);
  if (!token) { clearSession(); return null; }
  return { token, expiresAt: a.expiresAt, user: a.user };
}
function clearSession(base = store.base) {
  if (!store.auth[base]) return;
  delete store.auth[base];
  save();
  if (base === store.base) env.emit('workshop', { type: 'auth', user: null });
}
const publicUser = u => u && { id: u.id, name: u.display_name || u.username, username: u.username, discordId: u.discord_id, admin: !!Number(u.is_admin), moderator: !!Number(u.is_moderator), avatar: avatars.get(u.discord_id + ':' + u.avatar) || null };
// 头像在后台读取（Discord 图片服务器可能很慢或连不上），读到后通知界面刷新
function loadAvatar(u) {
  if (!u?.avatar || !u.discord_id) return;
  const k = u.discord_id + ':' + u.avatar;
  if (avatars.has(k)) return;
  avatars.set(k, null);
  env.fetch(`https://cdn.discordapp.com/avatars/${encodeURIComponent(u.discord_id)}/${encodeURIComponent(u.avatar)}.png?size=64`, { signal: AbortSignal.timeout(10000) })
    .then(async r => { if (!r.ok) return; avatars.set(k, 'data:image/png;base64,' + Buffer.from(await r.arrayBuffer()).toString('base64')); const cur = session(); if (cur?.user?.discord_id === u.discord_id) env.emit('workshop', { type: 'auth', user: publicUser(cur.user) }); })
    .catch(() => {});
}

// ---------- 请求 ----------
export class WorkshopError extends Error {
  constructor(message, status = 0, code = 'request_failed') { super(message); this.status = status; this.code = code; }
}
async function readError(r) {
  try { const b = await r.json(); return new WorkshopError(b.error || b.message || `请求失败（${r.status}）`, r.status, b.code); }
  catch { return new WorkshopError(`请求失败（${r.status}）`, r.status); }
}
async function raw(p, { method = 'GET', body, headers = {}, auth = false, token, timeout = 30000 } = {}) {
  const h = { 'User-Agent': `rwkit-desktop/${env.appVersion}`, ...headers };
  if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') { body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  if (auth || token) {
    const s = token ? { token } : session();
    if (!s) throw new WorkshopError('还没有登录，或登录已过期，请先用 Discord 登录', 401, 'session_expired');
    h.Authorization = 'Bearer ' + s.token;
  }
  let r;
  try { r = await env.fetch(store.base + p, { method, body, headers: h, signal: AbortSignal.timeout(timeout) }); }
  catch (e) { throw new WorkshopError(e.name === 'TimeoutError' ? '连接创意工坊超时，请稍后再试' : '无法连接创意工坊：' + (e.cause?.code || e.message), 0, 'network'); }
  if (!r.ok) {
    const err = await readError(r);
    if ((auth || token) && (r.status === 401 || err.code === 'user_banned')) clearSession();
    throw err;
  }
  return r;
}
async function request(p, opts) {
  const r = await raw(p, opts);
  if (r.status === 204) return undefined;
  // 代理、网关或登录页可能返回 HTML：给出能看懂的提示，而不是 JSON 解析错误
  try { return await r.json(); } catch { throw new WorkshopError('创意工坊返回了无法识别的内容，请检查网络或服务器地址', r.status, 'bad_response'); }
}
const enc = encodeURIComponent;

// ---------- Discord 登录（与官方客户端相同：系统浏览器授权，客户端轮询交换结果） ----------
let login = null;
function beginLogin() {
  cancelLogin();
  const loginId = crypto.randomBytes(32).toString('hex');
  const url = new URL('/api/auth/discord/start', store.base);
  url.searchParams.set('login_id', loginId);
  const ctl = new AbortController();
  login = { id: loginId, url: url.toString(), base: store.base, ctl, started: Date.now(), done: null };
  login.done = waitForExchange(login).finally(() => { if (login?.id === loginId) login = null; });
  login.done.catch(() => {});
  return { url: login.url };
}
async function waitForExchange(l) {
  const sleep = ms => new Promise(res => { const t = setTimeout(res, ms); l.ctl.signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
  while (Date.now() - l.started < 5 * 60 * 1000) {
    if (l.ctl.signal.aborted) throw new WorkshopError('Discord 登录已取消', 499, 'login_cancelled');
    try {
      const ex = await request('/api/auth/exchange', { method: 'POST', body: { login_id: l.id }, timeout: 15000 });
      if (l.ctl.signal.aborted) throw new WorkshopError('Discord 登录已取消', 499, 'login_cancelled');
      const me = await request('/api/auth/me', { token: ex.token });
      store.auth[l.base] = { ...sealToken(ex.token), expiresAt: Number(ex.expires_at), user: me.user };
      save();
      loadAvatar(me.user);
      const user = publicUser(me.user);
      env.emit('workshop', { type: 'auth', user });
      return user;
    } catch (e) {
      if (e.code === 'login_cancelled') throw e;
      // 404/409/429：用户还没完成授权；网络或服务器暂时出错时继续等
      if (!(e instanceof WorkshopError) || !([0, 404, 409, 429].includes(e.status) || e.status >= 500)) throw e;
    }
    await sleep(1000);
  }
  throw new WorkshopError('Discord 登录等待超时，请重新登录', 408, 'login_timeout');
}
function cancelLogin() { if (login) { login.ctl.abort(); login = null; } }

// ---------- 作品 ----------
function listParams(b) {
  const q = new URLSearchParams({ limit: String(Math.min(48, Math.max(1, Number(b.limit) || 24))), offset: String(Math.max(0, Number(b.offset) || 0)), sort: SORTS.includes(b.sort) ? b.sort : 'latest' });
  if (String(b.query || '').trim()) q.set('query', String(b.query).trim().slice(0, 100));
  if (['character', 'extension'].includes(b.category)) q.set('category', b.category);
  if (KINDS.includes(b.kind)) q.set('kind', b.kind);
  if (String(b.tag || '').trim()) q.set('tag', String(b.tag).trim());
  return q;
}
// 服务器返回的数字字段统一转成数字（界面会把它们直接拼进页面）
const NUM_KEYS = ['version', 'latest_version', 'published_version', 'downloads_count', 'likes_count', 'favorites_count', 'created_at', 'updated_at', 'archived_at', 'entry_count', 'index', 'min_version', 'added', 'modified', 'removed', 'from', 'to', 'reviewed_at', 'total_bytes', 'artifact_count', 'byte_size'];
function numify(v) {
  if (Array.isArray(v)) return v.map(numify);
  if (!isObj(v)) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = NUM_KEYS.includes(k) && x != null && typeof x !== 'object' ? (Number(x) || 0) : numify(x);
  return out;
}
// 公开详情里的内容预览带着全部正文，界面只需要名称与开关
function slimDetail(d) {
  const cp = d.content_preview || {};
  const pick = (list, keys) => (Array.isArray(list) ? list : []).map(x => Object.fromEntries(keys.filter(k => x[k] !== undefined).map(k => [k, x[k]])));
  return {
    project: d.project, changelog: d.changelog || '', manifest: d.manifest, version_history: d.version_history || [],
    change_preview: d.change_preview ? { from: d.change_preview.from_version, to: d.change_preview.to_version, summary: d.change_preview.summary || null } : null,
    preview: {
      counts: cp.counts || {},
      artifacts: pick(cp.artifacts, ['index', 'kind', 'name', 'format', 'scope', 'entry_count']),
      worldbook: pick(cp.worldbook_entries, ['name', 'enabled', 'primary_keys', 'strategy_type', 'artifact_name']),
      regex: pick(cp.regex_entries, ['name', 'enabled', 'artifact_name']),
      scripts: pick(cp.scripts, ['name', 'folder', 'scope', 'enabled', 'artifact_name']),
      data: pick(cp.data_entries, ['kind', 'name', 'label', 'artifact_name']),
      overrides: (cp.resource_overrides || []).length,
    },
  };
}
const safeFile = v => String(v || '轮回战场创意工坊').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim().slice(0, 80) || '轮回战场创意工坊';
function downloadDir(dir) {
  const d = dir || store.downloadDir || path.join(env.defaultDownloads || env.dataDir, '创意工坊下载');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
async function coverData(id, own) {
  try {
    const r = await raw(`/api/projects/${enc(id)}/${own ? 'edit-cover' : 'cover'}`, { auth: own, timeout: 20000 });
    const type = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\//.test(type)) return null;
    return 'data:' + type + ';base64,' + Buffer.from(await r.arrayBuffer()).toString('base64');
  } catch { return null; }
}
// 把工坊的作品写成离线包：校验口径与工坊“导出离线包”一致，再按需嵌入封面
function writeRwpack({ project, manifest, bundle, cover, dir, overwrite }) {
  const R = core.rwkitModule();
  if (!R) fail('rwkit.mjs 不可用，无法生成离线包');
  const pack = {
    format: R.OFFLINE_FORMAT || 'reincarnation-workshop-project', version: R.OFFLINE_VERSION || 1, exported_at: Date.now(),
    project: {
      id: project.id, name: project.name, category: project.category, version: Number(project.version),
      dependencies: Array.isArray(project.dependencies) ? clone(project.dependencies) : [],
      summary: project.summary || '', tags: Array.isArray(project.tags) ? project.tags : [],
    },
    manifest, bundle,
  };
  if (!manifest) R.rebuildManifest(pack, []);
  R.verifyManifest(pack);
  // 封面会让离线包变大：超过 6 MB 时不嵌入
  if (cover && bytes(JSON.stringify({ ...pack, project: { ...pack.project, has_cover: true, cover_url: cover } })) <= R.MAX_OFFLINE_BYTES) Object.assign(pack.project, { has_cover: true, cover_url: cover });
  const target = path.join(downloadDir(dir), `${safeFile(project.name)}-v${pack.project.version}.rwpack`);
  if (!overwrite && fs.existsSync(target)) {
    let same = false;
    try { const old = JSON.parse(fs.readFileSync(target, 'utf8')); same = JSON.stringify(old.bundle) === JSON.stringify(pack.bundle) && Number(old.project?.version) === Number(pack.project.version); } catch {}
    if (same) return { target, same: true, size: fs.statSync(target).size, covered: !!pack.project.cover_url };
    return { confirm: { kind: 'overwrite', file: path.basename(target), target } };
  }
  const w = R.writePack(pack, target, { backup: core.getState().settings.backup !== false });
  return { target, same: w.same, bak: w.bak, size: w.size, covered: !!pack.project.cover_url };
}
async function download({ id, dir, overwrite }) {
  const [d, bundle] = await Promise.all([request(`/api/projects/${enc(id)}`, { timeout: 60000 }), request(`/api/projects/${enc(id)}/download`, { timeout: 60000 })]);
  const cover = d.project.has_cover ? await coverData(id, false) : null;
  return writeRwpack({ project: { ...d.project, version: d.manifest?.project?.version ?? d.project.version }, manifest: d.manifest, bundle, cover, dir, overwrite });
}
// 自己的作品：取最新上传的版本（可能还没发布）
async function downloadOwn({ id, dir, overwrite }) {
  const e = await request(`/api/projects/${enc(id)}/edit`, { auth: true, timeout: 60000 });
  if (!(e.latest?.version > 0) || !e.latest.bundle?.artifacts?.length) fail('这个作品还没有上传过版本');
  const cover = e.project.has_cover ? await coverData(id, true) : null;
  return writeRwpack({ project: { ...e.project, version: e.latest.version }, manifest: null, bundle: e.latest.bundle, cover, dir, overwrite });
}

// 上传前从本地项目取出要发布的内容
function localSource(p) {
  const s = core.sourcePack(p);
  if (s.draft) fail('这个离线包有未保存的修改，请先保存为新版本，再上传');
  if (s.info?.fatal) fail('本地项目读取出错，修正后才能上传：' + s.info.fatal);
  if (s.info?.errors?.length) fail(`本地项目有 ${s.info.errors.length} 个会让工坊安装失败的问题，修正后才能上传（见“检查结果”）`);
  const bundle = { schema_version: 1, artifacts: s.pack.bundle.artifacts };
  if (Array.isArray(s.pack.bundle.resource_overrides) && s.pack.bundle.resource_overrides.length) bundle.resource_overrides = s.pack.bundle.resource_overrides;
  const size = bytes(JSON.stringify(bundle));
  const cover = core.coverOf(p);
  const ck = contentKind(s.pack);
  // 只算工坊会拒绝的问题，不重复计入一般提示
  const issues = publishIssues(s.pack, { cover: cover ? { type: cover.type, size: cover.buf.length } : null });
  return { project: s.pack.project, bundle, size, warns: Math.max(0, (s.info?.warns?.length || 0) - issues.length), cover, kind: ck.kind, display: displayCategory(s.pack.project.category, ck.kind), issues };
}
// 资料超出工坊上限时说明原因，不悄悄截断
function checkMeta(m) {
  const out = [];
  if (!m.name) out.push('作品名称不能为空');
  if (m.name.length > WL.name) out.push(`作品名称 ${m.name.length} 个字，超过工坊上限 ${WL.name} 个字`);
  if (m.summary.length > WL.summary) out.push(`简介 ${m.summary.length} 个字，超过工坊上限 ${WL.summary} 个字`);
  if (m.tags.length > WL.tags) out.push(`标签有 ${m.tags.length} 个，超过工坊上限 ${WL.tags} 个`);
  const long = m.tags.filter(t => t.length > WL.tag);
  if (long.length) out.push(`标签「${long.join('」「')}」超过工坊上限 ${WL.tag} 个字`);
  if (m.dependencies.length > WL.deps) out.push(`依赖有 ${m.dependencies.length} 个，超过工坊上限 ${WL.deps} 个`);
  if (out.length) fail(out.join('；'));
  return m;
}
const failIssues = (src, what) => { if (src.issues.length) fail(`${what}前需要先改好：${src.issues.join('；')}`); };
function metaOf(project) {
  return {
    name: String(project.name || '').trim(), summary: String(project.summary || '').trim(),
    // 开局商店与扩展在服务器上都是 extension，由内容里的开局商店目录区分
    category: project.category === 'character' ? 'character' : 'extension',
    tags: normTags(project.tags),
    dependencies: (Array.isArray(project.dependencies) ? project.dependencies : []).filter(d => String(d?.project_id || '').trim()).map(d => ({ project_id: String(d.project_id).trim(), min_version: Math.max(1, Number.parseInt(d.min_version, 10) || 1) })),
  };
}
// 本地项目与工坊作品的资料差异（名称、简介、分类、标签、依赖）
function metaDiff(local, remote) {
  const out = [];
  const label = { name: '名称', summary: '简介', category: '分类', tags: '标签', dependencies: '依赖' };
  const norm = (k, v) => JSON.stringify(k === 'dependencies' ? [...(v || [])].map(d => ({ project_id: d.project_id, min_version: Number(d.min_version) })).sort((a, b) => a.project_id.localeCompare(b.project_id)) : k === 'tags' ? v || [] : String(v ?? '').trim());
  for (const k of Object.keys(label)) if (norm(k, local[k]) !== norm(k, remote[k])) out.push(k);
  return out.map(k => ({ key: k, label: label[k] }));
}
async function uploadCoverFrom(id, c) {
  if (!c) return null;
  if (!COVER_TYPES.has(c.type)) fail('工坊封面只支持 PNG、JPEG、WebP，当前封面是 ' + c.type);
  if (c.buf.length > LIMITS.cover) fail('工坊封面不能超过 3 MB（当前 ' + (c.buf.length / 1048576).toFixed(2) + ' MB）');
  return request(`/api/projects/${enc(id)}/cover`, { method: 'PUT', body: c.buf, headers: { 'Content-Type': c.type }, auth: true, timeout: 60000 });
}
function imageFile(f) {
  const ext = path.extname(f).toLowerCase();
  const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext];
  if (!type) fail('工坊封面只支持 PNG、JPEG、WebP');
  return { type, buf: fs.readFileSync(f) };
}

// 本地项目 id → 工坊作品 id（工坊下载的离线包两者相同，不需要记录）
function linkOf(localId) { return store.links[store.base]?.[localId] || null; }
function setLink(localId, remoteId) {
  const m = store.links[store.base] || (store.links[store.base] = {});
  if (remoteId && remoteId !== localId) m[localId] = remoteId; else delete m[localId];
  save();
}

// ---------- 路由 ----------
export function state() {
  const s = session();
  return {
    base: store.base, servers: SERVERS, downloadDir: store.downloadDir, defaultDownloadDir: path.join(env.defaultDownloads || env.dataDir, '创意工坊下载'),
    checkUpdates: store.checkUpdates, user: s ? publicUser(s.user) : null, expiresAt: s?.expiresAt || null, links: { ...(store.links[store.base] || {}) }, loginPending: !!login, limits: LIMITS,
  };
}
export async function handle(route, b = {}) {
  try {
    switch (route) {
      case 'ws.state': { const s = session(); if (s) loadAvatar(s.user); return state(); }
      case 'ws.settings': {
        if (typeof b.base === 'string') {
          const v = b.base.trim().replace(/\/+$/, '');
          if (!/^https:\/\/[\w.-]+(:\d+)?$/.test(v) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(v)) fail('服务器地址应为 https://域名');
          if (v !== store.base) { cancelLogin(); store.base = v; }
        }
        if (typeof b.downloadDir === 'string') store.downloadDir = b.downloadDir.trim();
        if (typeof b.checkUpdates === 'boolean') store.checkUpdates = b.checkUpdates;
        save();
        return state();
      }
      case 'ws.login': { const r = beginLogin(); await env.openExternal(r.url); return { ok: true, url: r.url }; }
      case 'ws.loginWait': { if (!login) return { ok: false, error: '没有进行中的登录' }; const user = await login.done; return { ok: true, user }; }
      case 'ws.loginCancel': cancelLogin(); return { ok: true };
      case 'ws.me': {
        const s = session(); if (!s) return { ok: true, user: null };
        const me = await request('/api/auth/me', { auth: true });
        store.auth[store.base].user = me.user; save(); loadAvatar(me.user);
        return { ok: true, user: publicUser(me.user) };
      }
      case 'ws.logout': {
        if (session()) { try { await request('/api/auth/logout', { method: 'POST', auth: true, timeout: 10000 }); } catch {} }
        clearSession(); return state();
      }
      case 'ws.list': return numify(await request('/api/projects?' + listParams(b)));
      case 'ws.detail': return numify(slimDetail(await request(`/api/projects/${enc(b.id)}`, { timeout: 60000 })));
      case 'ws.versions': {
        const ids = [...new Set((b.ids || []).filter(x => typeof x === 'string' && x && x.length <= 128))].slice(0, 100);
        if (!ids.length) return { items: [], unavailable: [] };
        return numify(await request('/api/projects/versions/batch', { method: 'POST', body: { ids } }));
      }
      case 'ws.download': return { ok: true, ...(await download(b)) };
      case 'ws.downloadOwn': return { ok: true, ...(await downloadOwn(b)) };
      case 'ws.engagement': return numify(await request(`/api/projects/${enc(b.id)}/engagement`, { auth: true }));
      case 'ws.engage': return numify(await request(`/api/projects/${enc(b.id)}/engagement`, { method: 'POST', body: { kind: b.kind, enabled: !!b.enabled }, auth: true }));
      case 'ws.mine': return numify(await request('/api/my/projects', { auth: true }));
      case 'ws.editor': {
        const e = await request(`/api/projects/${enc(b.id)}/edit`, { auth: true, timeout: 60000 });
        return { project: e.project, latest: { version: e.latest?.version || 0, changelog: e.latest?.changelog || '', review_status: e.latest?.review_status || 'draft', artifacts: (e.latest?.bundle?.artifacts || []).map(a => ({ kind: a.kind, name: a.name })) } };
      }
      case 'ws.local': {
        // 准备上传：本地项目的资料、大小与（若已关联）工坊上的差异
        const src = localSource(path.resolve(b.path));
        const meta = metaOf(src.project);
        const out = { meta, kind: src.kind, display: src.display, issues: src.issues, limits: WL, size: src.size, limit: LIMITS.bundle, artifacts: src.bundle.artifacts.length, warns: src.warns, cover: src.cover ? { type: src.cover.type, size: src.cover.buf.length, ok: COVER_TYPES.has(src.cover.type) && src.cover.buf.length <= LIMITS.cover } : null, localId: src.project.id };
        if (b.id) { const e = await request(`/api/projects/${enc(b.id)}/edit`, { auth: true, timeout: 60000 }); out.remote = numify(e.project); out.diff = metaDiff(meta, e.project); }
        return out;
      }
      case 'ws.create': {
        const src = localSource(path.resolve(b.path));
        // 界面上选的分类：扩展 / 角色 / 开局商店（开局商店要有开局商店目录）
        const want = isObj(b.meta) && ['extension', 'character', 'store_catalog'].includes(b.meta.category) ? b.meta.category : src.display;
        if (want === 'store_catalog' && src.kind !== 'store_catalog') fail('选择“开局商店”时，项目里需要有开局商店目录（kind 为 store_catalog 的数据）：可以在项目概览的“分类”里添加');
        if (want === 'extension' && src.kind === 'store_catalog') fail('项目里有开局商店目录，工坊会把它归为“开局商店”：请选择“开局商店”，或先删除那份数据');
        const meta = checkMeta({ ...metaOf(src.project), ...(isObj(b.meta) ? metaOf({ ...src.project, ...b.meta, category: want === 'character' ? 'character' : 'extension' }) : {}) });
        failIssues(src, '发布');
        // 与官方客户端一致：正式作品都必须带封面
        if (!src.cover) fail('工坊要求作品有封面：请先在项目概览里设置封面（PNG、JPEG 或 WebP，不超过 3 MB）');
        if (src.size > LIMITS.bundle) fail(`内容超过工坊 4 MB 的上传限制（当前 ${(src.size / 1048576).toFixed(2)} MB）`);
        const r = await request('/api/projects', { method: 'POST', body: meta, auth: true });
        setLink(src.project.id, r.project.id);
        return { ok: true, project: r.project };
      }
      case 'ws.upload': {
        const src = localSource(path.resolve(b.path));
        failIssues(src, '上传');
        if (src.size > LIMITS.bundle) fail(`内容超过工坊 4 MB 的上传限制（当前 ${(src.size / 1048576).toFixed(2)} MB）`);
        const changelog = String(b.changelog || '').trim();
        if (changelog.length > LIMITS.changelog) fail('更新说明不能超过 2000 字');
        const body = JSON.stringify({ changelog, bundle: src.bundle });
        if (bytes(body) > LIMITS.request) fail('上传内容超过 5 MB 的请求上限');
        if (b.syncMeta) await request(`/api/projects/${enc(b.id)}`, { method: 'PATCH', body: checkMeta(metaOf(src.project)), auth: true });
        if (b.cover && src.cover) await uploadCoverFrom(b.id, src.cover);
        const r = await request(`/api/projects/${enc(b.id)}/versions`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, auth: true, timeout: 120000 });
        setLink(src.project.id, b.id);
        let submitted = false;
        if (b.submit && !r.auto_published) { await request(`/api/projects/${enc(b.id)}/submit`, { method: 'POST', auth: true }); submitted = true; }
        return { ok: true, version: Number(r.version) || 0, autoPublished: !!r.auto_published, submitted };
      }
      case 'ws.update': {
        const fl = isObj(b.fields) ? b.fields : {};
        if ('name' in fl || 'summary' in fl || 'tags' in fl) checkMeta({ name: String(fl.name ?? 'x').trim(), summary: String(fl.summary ?? '').trim(), tags: normTags(fl.tags), dependencies: [] });
        return await request(`/api/projects/${enc(b.id)}`, { method: 'PATCH', body: { ...fl, ...(fl.tags ? { tags: normTags(fl.tags) } : {}) }, auth: true });
      }
      case 'ws.cover': return await uploadCoverFrom(b.id, b.file ? imageFile(path.resolve(b.file)) : core.coverOf(path.resolve(b.path)));
      case 'ws.submit': return await request(`/api/projects/${enc(b.id)}/submit`, { method: 'POST', auth: true });
      case 'ws.visibility': return await request(`/api/projects/${enc(b.id)}/visibility`, { method: 'POST', body: { hidden: !!b.hidden }, auth: true });
      case 'ws.delete': { const r = await request(`/api/projects/${enc(b.id)}`, { method: 'DELETE', auth: true }); for (const m of Object.values(store.links)) for (const [k, v] of Object.entries(m)) if (v === b.id) delete m[k]; save(); return r; }
      case 'ws.link': setLink(String(b.localId || ''), b.remoteId ? String(b.remoteId) : null); return state();
    }
    fail('不认识的请求：' + route);
  } catch (e) {
    if (!(e instanceof UserError) && !(e instanceof WorkshopError) && !core.isUserError(e)) env.log(e.stack || String(e));
    return { ok: false, error: String(e.message || e), code: e.code, status: e.status };
  }
}

// 封面图（发现页与“我的作品”的缩略图），在主进程取回后交给 app:// 协议
const covers = new Map();
const COVER_DISK_MAX = 400;
function diskCover(key) {
  if (!env.cacheDir) return null;
  const file = path.join(env.cacheDir, crypto.createHash('sha1').update(key).digest('hex'));
  return {
    read() { try { const b = fs.readFileSync(file); const n = b.indexOf(10); return { type: b.subarray(0, n).toString('latin1'), buf: b.subarray(n + 1) }; } catch { return null; } },
    write(c) {
      try {
        fs.mkdirSync(env.cacheDir, { recursive: true });
        fs.writeFileSync(file, Buffer.concat([Buffer.from(c.type + '\n', 'latin1'), c.buf]));
        // 超过上限时删掉最久没用的一批
        const names = fs.readdirSync(env.cacheDir);
        if (names.length > COVER_DISK_MAX) {
          names.map(n => ({ n, t: fs.statSync(path.join(env.cacheDir, n)).mtimeMs })).sort((a, b) => a.t - b.t)
            .slice(0, names.length - COVER_DISK_MAX + 50).forEach(x => fs.rmSync(path.join(env.cacheDir, x.n), { force: true }));
        }
      } catch {}
    },
  };
}
export async function cover(id, own, v, width = 0) {
  const k = (own ? 'own:' : '') + store.base + '|' + id + '|' + v + '|' + width;
  if (covers.has(k)) { const c = covers.get(k); covers.delete(k); covers.set(k, c); return c; }
  const disk = width ? diskCover(k) : null;
  let c = disk?.read();
  if (!c) {
    const r = await raw(`/api/projects/${enc(id)}/${own ? 'edit-cover' : 'cover'}`, { auth: !!own, timeout: 20000 });
    c = { type: (r.headers.get('content-type') || 'application/octet-stream').split(';')[0], buf: Buffer.from(await r.arrayBuffer()) };
    if (width && env.thumb) { try { c = env.thumb(c, width) || c; } catch {} }
    if (/^image\//.test(c.type)) disk?.write(c);
  }
  covers.set(k, c);
  let total = 0; for (const x of covers.values()) total += x.buf.length;
  while (covers.size > 1 && (covers.size > 200 || total > 64 * 1048576)) { const [first, x] = covers.entries().next().value; covers.delete(first); total -= x.buf.length; }
  return c;
}
export const linksFor = () => ({ ...(store.links[store.base] || {}) });
