// rwkit 桌面版核心：读取、检查、修复、解包、打包、对比、直接编辑。与 Electron 无关，可单独测试。
// 所有检查与写包都直接调用 rwkit.mjs 里的函数（不改动它），结果与命令行完全一致。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync, spawn } from 'node:child_process';

const IS_WIN = process.platform === 'win32';
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const collate = (a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true });
const readTextFile = f => { const t = fs.readFileSync(f, 'utf8'); return t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t; };
const samePath = (a, b) => (IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
const normKey = p => (IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
const isPackName = n => /\.rwpack$/i.test(n);
const isProjectDir = p => { try { return fs.statSync(path.join(p, 'project.json')).isFile(); } catch { return false; } };
export function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v) ?? 'null';
}
class UserError extends Error {}
const fail = msg => { throw new UserError(msg); };

// ---------- 运行环境 ----------
const env = {
  dataDir: path.join(os.homedir(), '.rwkit-desktop'),
  rwkitCandidates: () => [],
  trash: async p => fs.rmSync(p, { recursive: true, force: true }),
  emit: () => {},
  log: msg => console.log(msg),
};
export function init(options) {
  Object.assign(env, options);
  fs.mkdirSync(env.dataDir, { recursive: true });
  loadState();
}

// ---------- 载入 rwkit：去掉命令行入口、导出需要的内部函数 ----------
const RW_REQUIRED = ['fixFile', 'unpackFile', 'packDir', 'makeExample', 'loadPack', 'verifyManifest', 'installCheck', 'lint',
  'buildFromDir', 'validateBundle', 'rebuildManifest', 'PackError', 'safeName', 'MAX_OFFLINE_BYTES'];
const RW_OPTIONAL = ['writePack', 'writeSource', 'freeDir', 'parseLoose', 'validateProject', 'entryText', 'Writer', 'artifactContent',
  'escapeLiterals', 'KIND_LABEL', 'MAX_ARTIFACTS', 'OFFLINE_FORMAT', 'OFFLINE_VERSION'];
let R = null;
const rw = { file: null, mtime: 0, error: null, bundled: false };
export async function ensureRwkit() {
  const list = env.rwkitCandidates();
  const pick = list.find(c => { try { return fs.statSync(c.file).isFile(); } catch { return false; } });
  if (!pick) { R = null; rw.error = '找不到 rwkit.mjs'; return false; }
  const st = fs.statSync(pick.file);
  if (R && rw.file === pick.file && st.mtimeMs === rw.mtime) return true;
  try {
    let src = readTextFile(pick.file).replace(/^#!.*/, '');
    const entry = /^process\.exitCode\s*=\s*main\(process\.argv\.slice\(2\)\);?[ \t]*$/m;
    if (!entry.test(src)) throw new Error('找不到命令行入口 process.exitCode = main(…)');
    const has = n => new RegExp('^(?:async\\s+)?(?:function|class|const|let)\\s+' + n.replace('$', '\\$') + '\\b', 'm').test(src);
    const missing = RW_REQUIRED.filter(n => !has(n));
    if (missing.length) throw new Error('缺少 ' + missing.join('、'));
    const names = [...RW_REQUIRED, ...RW_OPTIONAL.filter(has)];
    src = src.replace(entry, '') + '\nexport { ' + names.join(', ') + ' };\n';
    R = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
    Object.assign(rw, { file: pick.file, mtime: st.mtimeMs, error: null, bundled: !!pick.bundled, label: pick.label });
    infoCache.clear(); objCache.clear();
    return true;
  } catch (e) { R = null; Object.assign(rw, { file: pick.file, error: 'rwkit.mjs 与本程序不兼容：' + e.message }); return false; }
}
export const rwkitInfo = () => ({ ok: !!R && !rw.error, error: rw.error, file: rw.file, bundled: rw.bundled, label: rw.label, canEdit: !!(R && R.entryText && R.Writer && R.writePack) });
const isPackError = e => !!R && e instanceof R.PackError;
export const errText = e => String(e?.message || e);
const needEdit = () => { if (!R?.entryText || !R?.Writer || !R?.writePack || !R?.parseLoose) fail('当前使用的 rwkit.mjs 版本不支持直接编辑'); };

// ---------- 保存的状态 ----------
const state = { anchors: [], hidden: [], settings: { backup: true, theme: 'auto', sidebar: true, rwkitPath: '' } };
const stateFile = () => path.join(env.dataDir, 'state.json');
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (Array.isArray(s.anchors)) state.anchors = s.anchors.filter(a => a && typeof a.path === 'string').map(a => ({ path: path.resolve(a.path), at: Number(a.at) || 0 }));
    if (Array.isArray(s.hidden)) state.hidden = s.hidden.filter(x => typeof x === 'string');
    if (isObj(s.settings)) Object.assign(state.settings, s.settings);
    if (isObj(s.window)) state.window = s.window;
    if (typeof s.lastDir === 'string') state.lastDir = s.lastDir;
  } catch {}
}
let saveTimer = null;
export function saveState(now = false) {
  clearTimeout(saveTimer);
  const write = () => { try { fs.writeFileSync(stateFile() + '.tmp', JSON.stringify(state, null, 1)); fs.renameSync(stateFile() + '.tmp', stateFile()); } catch (e) { env.log('保存状态失败：' + e.message); } };
  if (now) write(); else saveTimer = setTimeout(write, 200);
}
export const getState = () => state;
function addAnchor(p) {
  p = path.resolve(p);
  state.anchors = state.anchors.filter(a => !samePath(a.path, p));
  state.anchors.unshift({ path: p, at: Date.now() });
  state.anchors.length = Math.min(state.anchors.length, 200);
  state.lastDir = path.dirname(p);
  saveState();
}
function touch(p) { const a = state.anchors.find(x => samePath(x.path, path.resolve(p))); if (a) { a.at = Date.now(); saveState(); } }

// ---------- 缓存 ----------
const infoCache = new Map();
const objCache = new Map();
function cached(key, sig, fn) {
  const c = infoCache.get(key);
  if (c && c.sig === sig) return c.value;
  const value = fn();
  infoCache.set(key, { sig, value });
  return value;
}
function remember(key, entry) {
  objCache.delete(key); objCache.set(key, entry);
  while (objCache.size > 10) objCache.delete(objCache.keys().next().value);
  return entry;
}
const fileSig = st => st.size + ':' + st.mtimeMs;
function dirSig(dir) {
  let count = 0, size = 0, mtime = 0;
  const walk = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (count > 20000) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 8 && !e.name.startsWith('.') && e.name !== 'node_modules') walk(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      try { const st = fs.statSync(p); count++; size += st.size; mtime = Math.max(mtime, st.mtimeMs); } catch {}
    }
    try { mtime = Math.max(mtime, fs.statSync(d).mtimeMs); } catch {}
  };
  walk(dir, 0);
  return { key: count + ':' + size + ':' + mtime, mtime, count };
}
function invalidate(p) { const k = normKey(p); for (const pre of ['pack:', 'dir:']) infoCache.delete(pre + k); objCache.delete(k); }

function peekFields(s) {
  const str = k => { const m = new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(s); try { return m ? JSON.parse('"' + m[1] + '"') : undefined; } catch { return undefined; } };
  const num = k => { const m = new RegExp('"' + k + '"\\s*:\\s*(\\d+)').exec(s); return m ? Number(m[1]) : undefined; };
  const id = str('id');
  return id ? { id, name: str('name'), category: str('category'), version: num('version') } : null;
}
function peekPack(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const d = drafts.get(normKey(file));
  if (d) return { id: String(d.pack.project?.id), name: d.pack.project?.name, version: d.pack.project?.version };
  return cached('peek:' + normKey(file), fileSig(st), () => {
    let t;
    try { const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(65536); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd); t = buf.subarray(0, n).toString('utf8'); } catch { return null; }
    const i = t.indexOf('"project"');
    return i < 0 ? null : peekFields(t.slice(i));
  });
}
function peekProjectJson(dir) {
  const f = path.join(dir, 'project.json');
  let st; try { st = fs.statSync(f); } catch { return null; }
  return cached('pj:' + normKey(f), fileSig(st), () => {
    try {
      const t = readTextFile(f);
      try { const p = JSON.parse(t).project; if (isObj(p) && p.id) return { id: String(p.id), name: p.name, category: p.category, version: Number(p.version) }; } catch {}
      const i = t.indexOf('"project"');
      return i < 0 ? null : peekFields(t.slice(i));
    } catch { return null; }
  });
}
function brief(p) {
  if (!isObj(p)) return null;
  return { id: String(p.id || ''), name: p.name, category: p.category, version: Number(p.version), summary: p.summary || '', tags: Array.isArray(p.tags) ? p.tags : [], dependencies: Array.isArray(p.dependencies) ? p.dependencies : [], hasCover: !!p.cover_url };
}
function levelOf(i) {
  if (i.fatal || i.errors?.length) return 'error';
  if (i.needFix) return 'fix';
  if (i.warns?.length) return 'warn';
  return 'ok';
}
// 在内存里按打包流程检查一个离线包对象（不写文件）
function checkPackObject(pack0, ctx) {
  const out = { notes: [], errors: [], warns: [], fatal: null, bytes: 0 };
  const pack = clone(pack0);
  try {
    if (R.validateProject) R.validateProject(pack.project);
    R.validateBundle(pack.bundle);
    const errors = R.installCheck(pack);
    R.rebuildManifest(pack, []);
    R.verifyManifest(pack);
    const warns = R.lint(pack);
    out.bytes = Buffer.byteLength(JSON.stringify(pack), 'utf8');
    if (out.bytes > R.MAX_OFFLINE_BYTES) errors.push('离线包超过 6 MB，工坊无法导入（当前 ' + (out.bytes / 1048576).toFixed(2) + ' MB）');
    out.errors = annotate(errors, pack0, ctx); out.warns = annotate(warns, pack0, ctx);
  } catch (e) { out.fatal = errText(e); }
  return out;
}

// ---------- 离线包与项目文件夹的摘要 ----------
function packInfo(file) {
  const st = fs.statSync(file), k = normKey(file), d = drafts.get(k);
  const sig = fileSig(st) + (d ? ':d' + d.rev : '');
  return cached('pack:' + k, sig, () => {
    const info = { kind: 'pack', path: file, file: path.basename(file), dir: path.dirname(file), size: st.size, mtime: st.mtimeMs, sig, notes: [], errors: [], warns: [] };
    let pack = null;
    try { pack = R.loadPack(file, []); } catch (e) { info.fatal = errText(e); }
    info.project = pack ? brief(pack.project) : peekPack(file);
    if (pack) {
      remember(k, { sig: fileSig(st), pack, dir: null, folders: null });
      info.digest = digestPack(pack);
      info.artifactCount = pack.bundle.artifacts.length;
      try {
        const r = R.fixFile(file, { check: true, backup: false });
        info.notes = r.notes; info.needFix = r.needWrite; info.bytes = r.bytes;
        info.errors = annotate(r.errors, pack, null); info.warns = annotate(r.warns, pack, null);
      } catch (e) { info.fatal = errText(e); }
    }
    if (d) {
      // 有未保存的修改：检查结果以草稿为准
      const c = checkPackObject(d.pack, null);
      Object.assign(info, { fatal: c.fatal, errors: c.errors, warns: c.warns, notes: [], needFix: false, bytes: c.bytes });
      info.project = brief(d.pack.project);
      info.digest = digestPack(d.pack);
      info.artifactCount = d.pack.bundle?.artifacts?.length || 0;
      info.draft = { count: d.count, undo: d.history.length };
      if (pack) info.draft.vsSaved = compareDigest(info.digest, digestPack(pack));
    }
    info.level = levelOf(info);
    return info;
  });
}
function folderInfo(dir) {
  const ds = dirSig(dir), k = normKey(dir);
  return cached('dir:' + k, ds.key, () => {
    const info = { kind: 'folder', path: dir, file: path.basename(dir), dir: path.dirname(dir), mtime: ds.mtime, fileCount: ds.count, sig: ds.key, notes: [], errors: [], warns: [] };
    let built = null;
    try { built = R.buildFromDir(dir, info.notes); } catch (e) {
      info.fatal = errText(e); info.loc = locateError(dir, info.fatal, null, null);
      info.project = peekProjectJson(dir);
      info.level = 'error';
      return info;
    }
    const { pack, folders } = built;
    info.folders = folders;
    info.project = brief(pack.project);
    info.digest = digestPack(pack);
    info.artifactCount = pack.bundle.artifacts?.length || 0;
    remember(k, { sig: ds.key, pack: clone(pack), dir, folders });
    try {
      R.validateBundle(pack.bundle);
      const errors = R.installCheck(pack);
      R.rebuildManifest(pack, []);
      R.verifyManifest(pack);
      const warns = R.lint(pack);
      info.bytes = Buffer.byteLength(JSON.stringify(pack), 'utf8');
      if (info.bytes > R.MAX_OFFLINE_BYTES) errors.push('离线包超过 6 MB，工坊无法导入（当前 ' + (info.bytes / 1048576).toFixed(2) + ' MB）');
      const ctx = { dir, folders };
      info.errors = annotate(errors, pack, ctx); info.warns = annotate(warns, pack, ctx);
    } catch (e) { info.fatal = errText(e); info.loc = locateError(dir, info.fatal, folders, pack); }
    info.level = levelOf(info);
    return info;
  });
}
// 取完整的离线包对象：有草稿时取草稿
function getSource(p) {
  const k = normKey(p), d = drafts.get(k);
  if (d) return { sig: 'draft:' + d.rev, pack: d.pack, dir: null, folders: null, draft: true };
  const st = fs.statSync(p);
  if (st.isFile()) {
    const sig = fileSig(st), c = objCache.get(k);
    if (c && c.sig === sig) return c;
    return remember(k, { sig, pack: R.loadPack(p, []), dir: null, folders: null });
  }
  const sig = dirSig(p).key, c = objCache.get(k);
  if (c && c.sig === sig) return c;
  let built;
  try { built = R.buildFromDir(p, []); } catch (e) { fail('项目文件夹有错误，修正后才能查看与编辑：' + errText(e)); }
  return remember(k, { sig, pack: built.pack, dir: p, folders: built.folders });
}

// ---------- 指纹与比较 ----------
function digestPack(pack) {
  const p = { ...(pack.project || {}) }; delete p.version;
  return {
    version: Number(pack.project?.version),
    project: sha(stable(p)),
    overrides: sha(stable(pack.bundle?.resource_overrides || [])),
    artifacts: (pack.bundle?.artifacts || []).map(a => ({ kind: a.kind, name: a.name, h: sha(stable(a)) })),
  };
}
function compareDigest(a, b) {
  const key = x => x.kind + '\u0000' + x.name;
  const ma = new Map(a.artifacts.map(x => [key(x), x.h])), mb = new Map(b.artifacts.map(x => [key(x), x.h]));
  let changed = 0, added = 0, removed = 0;
  for (const [k, h] of ma) { if (!mb.has(k)) added++; else if (mb.get(k) !== h) changed++; }
  for (const k of mb.keys()) if (!ma.has(k)) removed++;
  const order = a.artifacts.map(key).join('|') !== b.artifacts.map(key).join('|');
  const project = a.project !== b.project, overrides = a.overrides !== b.overrides;
  return { same: !changed && !added && !removed && !project && !overrides && !order, changed, added, removed, project, overrides, order };
}

// ---------- artifact 里的各项：世界书条目、正则、脚本 ----------
function parseMaybe(v) { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } }
function regexBase(c) {
  if (Array.isArray(c)) return { list: c, jp: ['content'] };
  if (isObj(c) && Array.isArray(c.regexes)) return { list: c.regexes, jp: ['content', 'regexes'] };
  if (isObj(c) && Array.isArray(c.extensions?.regex_scripts)) return { list: c.extensions.regex_scripts, jp: ['content', 'extensions', 'regex_scripts'] };
  return { list: [c], jp: null };
}
export function itemsOf(a) {
  const out = [], seen = new Map();
  const push = o => { const n = seen.get(o.mkey) || 0; seen.set(o.mkey, n + 1); if (n) o.mkey += '#' + (n + 1); out.push(o); };
  if (a.kind === 'worldbook') {
    const c = parseMaybe(a.content);
    const raw = Array.isArray(c) ? c : isObj(c) ? c.entries : null;
    const list = Array.isArray(raw) ? raw.map((e, i) => [String(i), e]) : isObj(raw) ? Object.entries(raw) : [];
    for (const [k, e] of list) {
      if (!isObj(e)) { push({ key: k, mkey: 'k:' + k, label: '条目 ' + k, text: '', meta: { value: e } }); continue; }
      const { content, ...meta } = e;
      push({
        key: k, mkey: 'uid:' + (e.uid ?? k), uid: e.uid, label: String(e.comment ?? e.name ?? ''), text: typeof content === 'string' ? content : JSON.stringify(content ?? '', null, 2), meta, textKey: 'content',
        sum: { keys: Array.isArray(e.key) ? e.key : [], keys2: Array.isArray(e.keysecondary) ? e.keysecondary : [], constant: !!e.constant, disable: !!e.disable, position: e.position, depth: e.depth, role: e.role, order: e.order },
      });
    }
  } else if (a.kind === 'regex') {
    const { list, jp } = regexBase(parseMaybe(a.content));
    list.forEach((r, i) => {
      if (!isObj(r)) return;
      const { replaceString, ...meta } = r;
      const rep = String(replaceString ?? '');
      push({
        key: 'r:' + i, mkey: 'r:' + (r.id || r.scriptName || i), label: String(r.scriptName ?? r.script_name ?? '未命名正则'), text: rep, meta, jp: jp ? jp.concat(i) : ['content'], prefer: 'replaceString', textKey: 'replaceString',
        sum: { find: String(r.findRegex ?? r.find_regex ?? ''), placement: r.placement, markdownOnly: !!r.markdownOnly, promptOnly: !!r.promptOnly, disabled: !!r.disabled, page: /^```html\b/.test(rep) || /^\s*<!DOCTYPE html/i.test(rep) },
      });
    });
  } else if (a.kind === 'script') {
    if (a.format === 'text') push({ key: 's:0', mkey: 's:' + a.name, label: a.name, text: String(a.content), meta: {}, jp: ['content'], prefer: 'content', textKey: 'content', textOnly: true, sum: { enabled: true, buttons: [] } });
    else {
      const trees = Array.isArray(a.content) ? a.content.map((t, i) => [t, ['content', i]]) : [[a.content, ['content']]];
      let n = 0;
      for (const [t, jp] of trees) {
        const one = (s, jp2, folder) => {
          if (!isObj(s)) return;
          const { content, ...meta } = s;
          push({
            key: 's:' + (n++), mkey: 's:' + (s.id || (folder ? folder + '/' : '') + s.name), label: String(s.name ?? '未命名脚本'), folder, text: String(content ?? ''), meta, jp: jp2, prefer: 'content', textKey: 'content',
            sum: { enabled: s.enabled !== false, buttons: Array.isArray(s.button?.buttons) ? s.button.buttons.map(b => b?.name).filter(Boolean) : [] },
          });
        };
        if (isObj(t) && t.type === 'folder') (Array.isArray(t.scripts) ? t.scripts : []).forEach((s, j) => one(s, jp.concat('scripts', j), String(t.name ?? '文件夹')));
        else one(t, jp, null);
      }
    }
  } else {
    const c = a.content;
    push({ key: 'c', mkey: 'c', label: a.name, text: typeof c === 'string' ? c : JSON.stringify(c, null, 2), meta: {}, jp: ['content'], whole: true, json: typeof c !== 'string', sum: { topKeys: isObj(c) ? Object.keys(c).slice(0, 40) : [] } });
  }
  return out;
}
const getAt = (root, jp) => jp.reduce((v, k) => (v == null ? undefined : v[k]), root);
function setAt(root, jp, value) { let p = root; for (let i = 0; i < jp.length - 1; i++) p = p[jp[i]]; p[jp[jp.length - 1]] = value; }

// 解包文件夹里 artifact.json 引用的文件
const MARK_KEYS = new Set(['$file', '$image', '$entries', '$artifacts', '$literal']);
const isMark = v => isObj(v) && Object.keys(v).length > 0 && Object.keys(v).every(k => MARK_KEYS.has(k) || k === 'array' || k === 'type') && Object.keys(v).some(k => MARK_KEYS.has(k));
const isFileMark = v => isObj(v) && typeof v.$file === 'string' && Object.keys(v).length === 1;
function artifactRefs(folder) {
  const json = path.join(folder, 'artifact.json');
  const out = { folder, json, refs: [], entries: null, entriesDir: null };
  let a; try { a = JSON.parse(readTextFile(json)); } catch { return out; }
  const walk = (v, jp) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, jp.concat(i)));
    if (!isObj(v)) return;
    if (isFileMark(v)) { out.refs.push({ jp, file: path.resolve(folder, v.$file) }); return; }
    if (typeof v.$entries === 'string') { out.entriesDir = path.resolve(folder, v.$entries); out.entries = entryFiles(out.entriesDir); return; }
    if ('$literal' in v) return;
    for (const k of Object.keys(v)) walk(v[k], jp.concat(k));
  };
  walk(a, []);
  return out;
}
function entryFiles(dir) {
  const map = new Map();
  let names; try { names = fs.readdirSync(dir).filter(n => /\.txt$/i.test(n) && !n.startsWith('_')); } catch { return map; }
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readTextFile(f));
      if (!m) continue;
      let meta = null;
      try { meta = JSON.parse(m[1]); } catch { const u = /"uid"\s*:\s*("?)(-?[\w.]+)\1/.exec(m[1]); if (u) meta = { uid: u[2] }; }
      if (meta) map.set('$key' in meta ? String(meta.$key) : String(meta.uid), f);
    } catch {}
  }
  return map;
}
function fileForItem(refs, a, it) {
  if (!refs) return null;
  if (a.kind === 'worldbook') return refs.entries?.get(String(it.key)) || refs.json;
  if (!it.jp) return refs.json;
  const under = refs.refs.filter(r => it.jp.every((x, i) => r.jp[i] === x));
  return (under.find(r => r.jp[r.jp.length - 1] === it.prefer) || under[0])?.file || refs.json;
}

// 把检查信息对应到 artifact 与具体条目
function annotate(list, pack, ctx) {
  const arts = pack?.bundle?.artifacts || [];
  const itemCache = new Map(), refCache = new Map();
  return (list || []).map(text => {
    const o = { text: String(text) };
    const m = /^“(.+?)”/.exec(o.text);
    const idx = m ? arts.findIndex(a => a.name === m[1]) : -1;
    if (idx < 0) return o;
    o.art = idx;
    const a = arts[idx];
    if (!itemCache.has(idx)) itemCache.set(idx, itemsOf(a));
    const items = itemCache.get(idx);
    let it = null, mm;
    if ((mm = /uid (\S+?) 重复（「.+?」与「(.+?)」）/.exec(o.text))) it = items.find(x => x.label === mm[2]) || null;
    else if ((mm = /条目「(.+?)」/.exec(o.text))) it = items.find(x => x.label === mm[1]) || items.find(x => x.key === mm[1]) || null;
    else if ((mm = /（uid (.+?)）/.exec(o.text))) it = items.find(x => x.uid != null && String(x.uid) === mm[1]) || null;
    else if ((mm = /^“.+?”（(.+?)）/.exec(o.text))) it = items.find(x => x.label === mm[1]) || null;
    if (it) { o.key = it.key; o.label = it.label; }
    if (ctx && ctx.folders?.[idx]) {
      if (!refCache.has(idx)) refCache.set(idx, artifactRefs(path.join(ctx.dir, ctx.folders[idx])));
      o.file = it ? fileForItem(refCache.get(idx), a, it) : refCache.get(idx).json;
    }
    return o;
  });
}
function findFile(dir, base, depth = 0) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of ents) if (e.isFile() && e.name === base) return path.join(dir, e.name);
  if (depth >= 4) return null;
  for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.')) { const f = findFile(path.join(dir, e.name), base, depth + 1); if (f) return f; }
  return null;
}
function locateError(dir, msg, folders, pack) {
  const lc = /（第 (\d+) 行第 (\d+) 列附近/.exec(msg);
  const at = (f, useLc = true) => (f && fs.existsSync(f) ? { file: f, rel: path.relative(dir, f), line: useLc && lc ? Number(lc[1]) : 1, col: useLc && lc ? Number(lc[2]) : 1 } : null);
  let m;
  if ((m = /^(.+?\.txt) 的条目设置/.exec(msg))) return at(findFile(dir, m[1]));
  if ((m = /^(.+?\.json) 不是有效的 JSON/.exec(msg))) return at(path.join(dir, m[1]));
  if ((m = /^世界书条目 uid .+? 重复：「(.+?)」与「(.+?)」/.exec(msg))) return at(findFile(dir, m[2]), false);
  if ((m = /^([^：\n]+?\.txt)：/.exec(msg))) return at(findFile(dir, m[1]), false);
  if ((m = /^(.+?)：(?:引用的 |找不到引用的文件 |文件引用无效|不认识的图片格式)/.exec(msg))) return at(m[1] === 'project.json' ? path.join(dir, m[1]) : path.join(dir, m[1], 'artifact.json'), false);
  if ((m = /^(.+?)\/artifact\.json 必须是/.exec(msg))) return at(path.join(dir, m[1], 'artifact.json'), false);
  if (folders && (m = /^第 (\d+) 个 artifact/.exec(msg))) return at(path.join(dir, folders[Number(m[1]) - 1] || '', 'artifact.json'), false);
  if (folders && pack && (m = /^“(.+?)”/.exec(msg))) {
    const i = (pack.bundle?.artifacts || []).findIndex(a => a.name === m[1]);
    if (i >= 0) return at(path.join(dir, folders[i], 'artifact.json'), false);
  }
  if (/^project[.\s]|project\.json|manifest|bundle|resource_overrides|原版资源规则/.test(msg)) return at(path.join(dir, 'project.json'), false);
  return null;
}

// ---------- 汇总成“项目” ----------
function scanDir(dir, ids) {
  const out = [];
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    try {
      if (e.isFile() && isPackName(e.name)) {
        if (ids) { const pk = peekPack(p); if (!pk || !ids.has(pk.id)) continue; }
        out.push(packInfo(p));
      } else if (e.isDirectory() && isProjectDir(p)) {
        if (ids) { const q = peekProjectJson(p); if (!q || !ids.has(q.id)) continue; }
        out.push(folderInfo(p));
      }
    } catch (err) { env.log('读取失败 ' + p + '：' + err.message); }
  }
  return out;
}
function collect() {
  const projects = new Map(), loose = [], anchoredIds = new Set(), homes = new Set();
  const add = (info, at) => {
    const id = info.project?.id;
    if (!id) { if (!loose.some(x => samePath(x.path, info.path))) loose.push(info); return; }
    if (state.hidden.includes(id)) return;
    let p = projects.get(id);
    if (!p) projects.set(id, p = { id, folders: new Map(), packs: new Map(), at: 0 });
    (info.kind === 'pack' ? p.packs : p.folders).set(normKey(info.path), info);
    p.at = Math.max(p.at, at || 0);
  };
  for (const a of state.anchors) {
    let st; try { st = fs.statSync(a.path); } catch { continue; }
    try {
      if (st.isFile()) {
        const i = packInfo(a.path); add(i, a.at);
        if (i.project?.id) { anchoredIds.add(i.project.id); homes.add(path.dirname(a.path)); }
      } else if (isProjectDir(a.path)) {
        const i = folderInfo(a.path); add(i, a.at);
        if (i.project?.id) { anchoredIds.add(i.project.id); homes.add(path.dirname(a.path)); }
      } else for (const i of scanDir(a.path, null)) add(i, a.at);
    } catch (e) { env.log('读取失败 ' + a.path + '：' + e.message); }
  }
  for (const h of homes) for (const i of scanDir(h, anchoredIds)) add(i, 0);
  return { projects, loose };
}
const strip = i => { const { digest, folders, ...rest } = i; return rest; };
function worst(levels) { for (const l of ['error', 'fix', 'warn', 'ok']) if (levels.includes(l)) return l; return 'ok'; }
export function view() {
  const { projects, loose } = collect();
  const list = [];
  for (const p of projects.values()) {
    const packs = [...p.packs.values()].sort((x, y) => ((y.project?.version || 0) - (x.project?.version || 0)) || (y.mtime - x.mtime));
    const folders = [...p.folders.values()].sort((x, y) => y.mtime - x.mtime);
    const saved = packs.filter(x => !x.draft);
    const newest = packs[0] || null;
    const main = folders.find(f => f.project?.name != null) || packs.find(x => x.project?.name != null) || folders[0] || packs[0];
    const pj = main.project || {};
    const coverSrc = [...folders, ...packs].find(x => x.project?.hasCover);
    list.push({
      id: p.id, at: p.at, name: pj.name ?? '（未命名）', category: pj.category, version: pj.version, summary: pj.summary || '', tags: pj.tags || [], dependencies: pj.dependencies || [],
      cover: coverSrc ? { path: coverSrc.path, v: coverSrc.sig } : null,
      folders: folders.map(f => folderView(f, packs, newest)),
      packs: packs.map(x => ({ ...strip(x), version: x.project?.version })),
      drafts: packs.filter(x => x.draft).length,
      level: worst([...folders.map(f => f.level), newest?.level].filter(Boolean)),
      savedCount: saved.length,
    });
  }
  list.sort((a, b) => (b.at - a.at) || collate(a.name, b.name));
  return { projects: list, loose: loose.map(strip) };
}
function folderView(f, packs, newest) {
  const v = { ...strip(f), version: f.project?.version };
  if (R && f.project?.name != null && Number.isInteger(f.project.version)) {
    const name = R.safeName(f.project.name, 60), parent = path.dirname(f.path);
    const t = n => { const p = path.join(parent, name + '-v' + n + '.rwpack'); return { path: p, file: path.basename(p), exists: fs.existsSync(p), version: n }; };
    v.target = t(f.project.version);
    v.bumpTarget = t(f.project.version + 1);
  }
  if (newest && f.digest && newest.digest) {
    v.vsNewest = { path: newest.path, file: newest.file, version: newest.project?.version, ...compareDigest(f.digest, newest.digest) };
    const same = packs.find(x => x.project?.version === f.project?.version && x.digest);
    if (same) v.vsSameVersion = { path: same.path, file: same.file, ...compareDigest(f.digest, same.digest) };
  }
  return v;
}

// ---------- 查看内容 ----------
function describe(p) {
  const src = getSource(p), pack = src.pack, pj = pack.project || {};
  const KNOWN = new Set(['id', 'name', 'category', 'version', 'dependencies', 'summary', 'tags', 'has_cover', 'cover_url']);
  const extra = Object.fromEntries(Object.keys(pj).filter(k => !KNOWN.has(k)).map(k => [k, pj[k]]));
  const artifacts = (pack.bundle?.artifacts || []).map((a, i) => {
    const text = a.format === 'text' ? String(a.content ?? '') : JSON.stringify(a.content) ?? '';
    const refs = src.dir && src.folders?.[i] ? artifactRefs(path.join(src.dir, src.folders[i])) : null;
    const items = itemsOf(a).map(it => ({ key: it.key, label: it.label, uid: it.uid, folder: it.folder, chars: it.text.length, preview: it.text.slice(0, 140), sum: it.sum, file: refs ? fileForItem(refs, a, it) : null }));
    return { index: i, kind: a.kind, format: a.format, name: a.name, scope: a.scope, conflicts: a.original_conflicts || null, bytes: Buffer.byteLength(text, 'utf8'), folder: refs?.folder || null, json: refs?.json || null, items };
  });
  return {
    path: p, isFolder: !!src.dir, draft: !!src.draft, sig: src.sig,
    project: { id: pj.id, name: pj.name, category: pj.category, version: pj.version, summary: pj.summary || '', tags: pj.tags || [], dependencies: pj.dependencies || [], hasCover: !!pj.cover_url, extra },
    overrides: pack.bundle?.resource_overrides || [],
    bytes: Buffer.byteLength(JSON.stringify(pack), 'utf8'),
    artifacts,
  };
}
function detail(p, ai, key) {
  const src = getSource(p), a = src.pack.bundle?.artifacts?.[ai];
  if (!a) fail('找不到这个 artifact');
  const it = itemsOf(a).find(x => x.key === key);
  if (!it) fail('找不到这一项（可能已被删除或改名）');
  const refs = src.dir && src.folders?.[ai] ? artifactRefs(path.join(src.dir, src.folders[ai])) : null;
  const value = it.whole ? a.content : getItemValue(a, it);
  return { kind: a.kind, format: a.format, label: it.label, key: it.key, text: it.text, meta: it.meta, value, textKey: it.textKey, whole: !!it.whole, json: !!it.json, textOnly: !!it.textOnly, file: refs ? fileForItem(refs, a, it) : null, sig: src.sig, artifact: { name: a.name, scope: a.scope, format: a.format, conflicts: a.original_conflicts } };
}
function getItemValue(a, it) {
  if (a.kind === 'worldbook') { const c = parseMaybe(a.content); const e = Array.isArray(c) ? c : c.entries; return e[Array.isArray(e) ? Number(it.key) : it.key]; }
  if (it.textOnly) return a.content;
  return getAt(a, it.jp);
}
function artifactDetail(p, ai) {
  const src = getSource(p), a = src.pack.bundle?.artifacts?.[ai];
  if (!a) fail('找不到这个 artifact');
  return { name: a.name, kind: a.kind, format: a.format, scope: a.scope, conflicts: a.original_conflicts ?? null, count: itemsOf(a).length, folder: src.dir && src.folders?.[ai] ? path.join(src.dir, src.folders[ai]) : null, total: src.pack.bundle.artifacts.length, sig: src.sig };
}
function projectDetail(p) {
  const src = getSource(p), pj = src.pack.project || {};
  const { cover_url, ...rest } = pj;
  return { project: rest, hasCover: !!cover_url, overrides: src.pack.bundle?.resource_overrides || [], sig: src.sig, isFolder: !!src.dir, draft: !!src.draft };
}

// ---------- 两个版本的差异 ----------
function shortVal(v) { const s = typeof v === 'string' ? v : JSON.stringify(v); return s === undefined ? '（无）' : s.length > 300 ? s.slice(0, 300) + '…' : s; }
function fieldChanges(a, b, skip = []) {
  const out = [];
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    if (skip.includes(k)) continue;
    if (stable(a?.[k]) === stable(b?.[k])) continue;
    if (isObj(a?.[k]) && isObj(b?.[k])) { for (const c of fieldChanges(a[k], b[k])) out.push({ ...c, name: k + '.' + c.name }); continue; }
    out.push({ name: k, a: shortVal(a?.[k]), b: shortVal(b?.[k]) });
  }
  return out;
}
const CAP = 300000;
function omitContent(a) { const { content, ...rest } = a; return rest; }
function diff(pa, pb, { aSaved = false } = {}) {
  const A = aSaved ? R.loadPack(pa, []) : getSource(pa).pack, B = getSource(pb).pack;
  const proj = fieldChanges(A.project, B.project, ['version', 'cover_url']);
  if (stable(A.project?.cover_url) !== stable(B.project?.cover_url)) proj.push({ name: 'cover_url', a: '（封面图）', b: '（封面图已更换）' });
  const ka = x => x.kind + '\u0000' + x.name;
  const la = A.bundle?.artifacts || [], lb = B.bundle?.artifacts || [];
  const mapA = new Map(la.map((x, i) => [ka(x), i]));
  const arts = [], usedA = new Set();
  lb.forEach((b, bi) => {
    const ai = mapA.get(ka(b));
    if (ai === undefined) { arts.push({ status: 'added', kind: b.kind, name: b.name, bi, items: itemsOf(b).map(i => ({ status: 'added', label: i.label, mkey: i.mkey, key: i.key, bText: i.text.slice(0, CAP) })) }); return; }
    usedA.add(ai);
    const a = la[ai];
    const meta = fieldChanges(omitContent(a), omitContent(b));
    const ia = itemsOf(a), ib = itemsOf(b), mia = new Map(ia.map(x => [x.mkey, x])), seen = new Set();
    const items = [];
    for (const y of ib) {
      const x = mia.get(y.mkey);
      if (!x) { items.push({ status: 'added', label: y.label, mkey: y.mkey, key: y.key, bText: y.text.slice(0, CAP) }); continue; }
      seen.add(y.mkey);
      const fields = fieldChanges(x.meta, y.meta), textChanged = x.text !== y.text;
      if (!fields.length && !textChanged) continue;
      items.push({ status: 'changed', label: y.label, mkey: y.mkey, key: y.key, fields, textChanged, aText: textChanged ? x.text.slice(0, CAP) : null, bText: textChanged ? y.text.slice(0, CAP) : null });
    }
    for (const x of ia) if (!seen.has(x.mkey)) items.push({ status: 'removed', label: x.label, mkey: x.mkey, aText: x.text.slice(0, CAP) });
    arts.push({ status: items.length || meta.length ? 'changed' : 'same', kind: b.kind, name: b.name, ai, bi, meta, items, total: ib.length });
  });
  la.forEach((a, ai) => { if (!usedA.has(ai)) arts.push({ status: 'removed', kind: a.kind, name: a.name, ai, items: itemsOf(a).map(i => ({ status: 'removed', label: i.label, mkey: i.mkey, aText: i.text.slice(0, CAP) })) }); });
  const ov = stable(A.bundle?.resource_overrides || []) !== stable(B.bundle?.resource_overrides || []);
  return {
    a: { path: pa, version: A.project?.version }, b: { path: pb, version: B.project?.version },
    project: proj, overrides: ov ? { a: (A.bundle?.resource_overrides || []).length, b: (B.bundle?.resource_overrides || []).length } : null,
    artifacts: arts,
  };
}

// ---------- 直接编辑：共用的规则 ----------
const SCRIPT_SCOPES = ['character', 'preset', 'global'];
const KINDS = ['worldbook', 'regex', 'script', 'preset', 'data'];
// 合并时保留原有字段顺序，新字段排在后面
function mergeOrdered(orig, next) {
  if (!isObj(orig) || !isObj(next)) return next;
  const out = {};
  for (const k of Object.keys(orig)) if (k in next) out[k] = next[k];
  for (const k of Object.keys(next)) if (!(k in orig)) out[k] = next[k];
  return out;
}
// 世界书条目里与顶层字段重复的 extensions 字段保持一致
const EXT_MIRROR = [['position', 'position'], ['depth', 'depth'], ['role', 'role'], ['probability', 'probability'], ['useProbability', 'useProbability'], ['selectiveLogic', 'selectiveLogic'],
  ['excludeRecursion', 'exclude_recursion'], ['preventRecursion', 'prevent_recursion'], ['delayUntilRecursion', 'delay_until_recursion'], ['scanDepth', 'scan_depth'], ['caseSensitive', 'case_sensitive'],
  ['matchWholeWords', 'match_whole_words'], ['group', 'group'], ['groupOverride', 'group_override'], ['groupWeight', 'group_weight'], ['useGroupScoring', 'use_group_scoring'], ['sticky', 'sticky'],
  ['cooldown', 'cooldown'], ['delay', 'delay'], ['automationId', 'automation_id'], ['outletName', 'outlet_name'], ['vectorized', 'vectorized'], ['ignoreBudget', 'ignore_budget'], ['displayIndex', 'display_index']];
function syncEntry(e) {
  if (!isObj(e) || !isObj(e.extensions)) return e;
  const ext = { ...e.extensions };
  for (const [a, b] of EXT_MIRROR) if (a in e && b in ext) ext[b] = clone(e[a]);
  return { ...e, extensions: ext };
}
function checkEntry(e) {
  if (!isObj(e)) fail('条目必须是对象');
  if (!String(e.comment ?? e.name ?? '').trim()) fail('条目名称（comment）不能为空，工坊安装时必须有');
  if (e.uid === undefined || e.uid === null || e.uid === '') fail('条目缺少 uid');
  if (!Array.isArray(e.key)) fail('关键词（key）必须是列表');
}
function checkRegex(r) {
  if (!isObj(r)) fail('正则必须是对象');
  if (typeof (r.findRegex ?? r.find_regex) !== 'string') fail('正则缺少查找内容 findRegex');
}
function checkScript(s) {
  if (!isObj(s)) fail('脚本必须是对象');
  if (!String(s.content || '').trim()) fail('脚本内容不能为空（工坊安装时会失败）');
}
function checkProjectFields(f) {
  if ('name' in f && (typeof f.name !== 'string' || !f.name.trim())) fail('项目名称不能为空');
  if ('category' in f && !['extension', 'character'].includes(f.category)) fail('分类只能是扩展或角色包');
  if ('version' in f && (!Number.isInteger(Number(f.version)) || Number(f.version) < 1)) fail('版本号必须是不小于 1 的整数');
  if ('dependencies' in f) {
    if (!Array.isArray(f.dependencies) || f.dependencies.length > 12) fail('依赖最多 12 个');
    for (const d of f.dependencies) if (!isObj(d) || !String(d.project_id || '').trim() || !Number.isInteger(Number(d.min_version)) || Number(d.min_version) < 1) fail('依赖需要填写项目 id 和不小于 1 的最低版本');
  }
  if ('tags' in f && (!Array.isArray(f.tags) || f.tags.some(t => typeof t !== 'string'))) fail('标签必须是文字列表');
}
function applyProjectFields(project, f) {
  checkProjectFields(f);
  const next = { ...project };
  for (const k of ['name', 'category', 'version', 'summary', 'tags', 'dependencies']) {
    if (!(k in f)) continue;
    let v = f[k];
    if (k === 'version') v = Number(v);
    if (k === 'dependencies') v = v.map(d => ({ ...d, project_id: String(d.project_id).trim(), min_version: Number(d.min_version) }));
    if ((v === '' || (Array.isArray(v) && !v.length)) && !(k in project) && k !== 'dependencies') continue;
    next[k] = v;
  }
  return mergeOrdered(project, next);
}
function checkOverrides(list) {
  if (!Array.isArray(list) || list.length > 300) fail('原版资源规则最多 300 条');
  list.forEach((r, i) => {
    const at = '第 ' + (i + 1) + ' 条原版资源规则';
    if (!isObj(r) || !['worldbook', 'regex', 'script'].includes(r.kind) || !['enabled', 'disabled'].includes(r.state) || !isObj(r.target)) fail(at + '不完整');
    if (r.kind === 'worldbook' && !String(r.target.uid ?? '').trim() && !String(r.target.name || '').trim()) fail(at + '需要世界书条目 uid 或名称');
    if (r.kind === 'regex' && !String(r.target.id || '').trim() && !String(r.target.name || '').trim()) fail(at + '需要正则 id 或名称');
    if (r.kind === 'script' && (!SCRIPT_SCOPES.includes(String(r.target.scope || '')) || (!String(r.target.id || '').trim() && !String(r.target.name || '').trim()))) fail(at + '需要脚本作用域，以及 id 或名称');
  });
}
function checkConflicts(list, kind) {
  if (list == null) return;
  if (!Array.isArray(list)) fail('原版冲突声明必须是列表');
  for (const c of list) {
    if (!isObj(c) || !['disable', 'replace'].includes(c.action) || !isObj(c.target)) fail('原版冲突声明不完整');
    if (kind === 'script' && !SCRIPT_SCOPES.includes(String(c.target.scope || ''))) fail('脚本的原版冲突声明需要作用域');
    const idOk = kind === 'script' ? String(c.target.id || '').trim() : String(c.target.uid ?? '').trim();
    if (!idOk && !String(c.target.name ?? '').trim()) fail('原版冲突声明需要目标的 ' + (kind === 'script' ? 'id' : 'uid') + ' 或名称');
  }
}
function applyArtifactMeta(a, meta) {
  const next = { ...a };
  if ('name' in meta) { const n = String(meta.name || '').trim(); if (!n) fail('名称不能为空'); next.name = n; }
  if (a.kind === 'script' && 'scope' in meta) { if (!SCRIPT_SCOPES.includes(meta.scope)) fail('脚本作用域无效'); next.scope = meta.scope; }
  if ((a.kind === 'worldbook' || a.kind === 'script') && 'conflicts' in meta) {
    const c = meta.conflicts;
    if (c == null || (Array.isArray(c) && !c.length)) delete next.original_conflicts;
    else { checkConflicts(c, a.kind); next.original_conflicts = clone(c); }
  }
  return next;
}
// 新建各类内容的模板（字段与工坊导出的格式一致）
function newEntry(uid, fields = {}) {
  const position = fields.position ?? 0, depth = fields.depth ?? 4, role = fields.role ?? 0;
  const e = {
    uid, key: [], keysecondary: [], comment: '新条目', content: '', constant: false, selective: true, order: 100, position,
    excludeRecursion: true, preventRecursion: true, delayUntilRecursion: false, disable: false, addMemo: true, displayIndex: 0,
    probability: 100, useProbability: true, depth, selectiveLogic: 0, outletName: '', group: '', groupOverride: false, groupWeight: 100,
    scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: false, automationId: '', role, vectorized: false,
    sticky: 0, cooldown: 0, delay: 0, matchPersonaDescription: false, matchCharacterDescription: false, matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
    extensions: {
      automation_id: '', case_sensitive: null, cooldown: 0, delay: 0, delay_until_recursion: false, depth, display_index: 0,
      exclude_recursion: true, group: '', group_override: false, group_weight: 100, ignore_budget: false,
      match_character_depth_prompt: false, match_character_description: false, match_character_personality: false,
      match_creator_notes: false, match_persona_description: false, match_scenario: false, match_whole_words: null,
      outlet_name: '', position, prevent_recursion: true, probability: 100, role, scan_depth: null, selectiveLogic: 0,
      sticky: 0, triggers: [], useProbability: true, use_group_scoring: false, vectorized: false,
    },
    triggers: [], ignoreBudget: false,
  };
  return syncEntry(mergeOrdered(e, { ...e, ...fields }));
}
// 模板默认值 + 传入的字段（模板里的字段顺序在前）
const withDefaults = (tpl, fields) => mergeOrdered(tpl, { ...tpl, ...(fields || {}) });
function newRegex(fields = {}) {
  return withDefaults({ id: crypto.randomUUID(), scriptName: '新正则', disabled: false, runOnEdit: false, findRegex: '【新正则】', trimStrings: [], placement: [2], substituteRegex: 0, minDepth: null, maxDepth: null, replaceString: '', markdownOnly: true, promptOnly: false }, fields);
}
function newScript(fields = {}) {
  return withDefaults({ type: 'script', enabled: true, name: '新脚本', id: crypto.randomUUID(), button: { enabled: true, buttons: [] }, data: {}, export_with: { data: true, button: true }, content: '// 新脚本\n', info: '' }, fields);
}
function newArtifact({ kind, name }) {
  if (!KINDS.includes(kind)) fail('不支持的类型');
  let n = String(name || '').trim();
  if (!n) fail('名称不能为空');
  if (!/\.(json|txt|js)$/i.test(n)) n += '.json';
  if (kind === 'worldbook') return { kind, format: 'json', name: n, content: { entries: { 1: newEntry(1) } } };
  if (kind === 'regex') return { kind, format: 'json', name: n, content: newRegex({ scriptName: n.replace(/\.json$/i, ''), findRegex: '【' + n.replace(/\.json$/i, '') + '】' }) };
  if (kind === 'script') return { kind, format: 'json', name: n, scope: 'character', content: newScript({ name: n.replace(/\.json$/i, '') }) };
  return { kind, format: 'json', name: n, content: {} };
}
function nextUid(entries) {
  let max = 0;
  for (const e of Object.values(entries || {})) { const u = Number(e?.uid); if (Number.isFinite(u)) max = Math.max(max, u); }
  return max + 1;
}
function prepareItem(a, it, value) {
  if (a.kind === 'worldbook') { const v = syncEntry(value); checkEntry(v); return v; }
  if (a.kind === 'regex') { checkRegex(value); return value; }
  if (a.kind === 'script') { if (it?.textOnly) { if (typeof value !== 'string' || !value.trim()) fail('脚本内容不能为空'); return value; } checkScript(value); return value; }
  return value;
}

// ---------- 直接编辑：离线包（草稿） ----------
const drafts = new Map();   // normKey → { path, pack, history: [json], rev, count }
export const hasDrafts = () => [...drafts.values()].map(d => ({ path: d.path, count: d.count }));
function editPackObject(pack, op) {
  const arts = pack.bundle.artifacts;
  const art = i => { const a = arts[i]; if (!a) fail('找不到这个 artifact'); return a; };
  switch (op.op) {
    case 'project': pack.project = applyProjectFields(pack.project, op.fields || {}); return {};
    case 'cover': {
      if (op.file) { pack.project.cover_url = imageDataUrl(op.file); pack.project.has_cover = true; }
      else { delete pack.project.cover_url; pack.project.has_cover = false; }
      return {};
    }
    case 'overrides': checkOverrides(op.list); pack.bundle.resource_overrides = clone(op.list); return {};
    case 'artifactMeta': arts[op.a] = applyArtifactMeta(art(op.a), op.meta || {}); return {};
    case 'item': {
      const a = art(op.a), it = itemsOf(a).find(x => x.key === op.key);
      if (!it) fail('找不到这一项（可能已被删除）');
      if (a.kind === 'worldbook') {
        const c = a.content, e = isObj(c) ? c.entries : null;
        if (!isObj(e) && !Array.isArray(e)) fail('这个世界书的格式不支持在这里编辑');
        if (Array.isArray(e)) { e[Number(op.key)] = prepareItem(a, it, mergeOrdered(e[Number(op.key)], op.value)); return { key: op.key }; }
        const orig = e[op.key], v = prepareItem(a, it, mergeOrdered(orig, op.value));
        const newKey = op.key === String(orig.uid) ? String(v.uid) : op.key;
        if (newKey !== op.key && newKey in e) fail('uid ' + v.uid + ' 已被「' + (e[newKey].comment || newKey) + '」使用');
        for (const [k2, x] of Object.entries(e)) if (k2 !== op.key && String(x?.uid) === String(v.uid)) fail('uid ' + v.uid + ' 已被「' + (x.comment || k2) + '」使用');
        c.entries = Object.fromEntries(Object.entries(e).map(([k2, x]) => (k2 === op.key ? [newKey, v] : [k2, x])));
        return { key: newKey };
      }
      if (it.whole) { a.content = op.value; return { key: it.key }; }
      if (it.textOnly) { a.content = prepareItem(a, it, op.value); return { key: it.key }; }
      setAt(a, it.jp, prepareItem(a, it, mergeOrdered(getAt(a, it.jp), op.value)));
      return { key: it.key };
    }
    case 'addItem': {
      const a = art(op.a);
      if (a.kind === 'worldbook') {
        const c = a.content;
        if (!isObj(c) || !isObj(c.entries)) fail('这个世界书的格式不支持在这里新增条目');
        const uid = op.value?.uid != null && !Object.values(c.entries).some(x => String(x?.uid) === String(op.value.uid)) ? op.value.uid : nextUid(c.entries);
        const v = prepareItem(a, null, newEntry(uid, { ...(op.value || {}), uid }));
        c.entries[String(uid)] = v;
        return { key: String(uid) };
      }
      if (a.kind === 'regex') {
        const v = prepareItem(a, null, newRegex(op.value || {}));
        const { list, jp } = regexBase(a.content);
        if (jp) list.push(v); else a.content = [a.content, v];
        return { key: 'r:' + (itemsOf(a).length - 1) };
      }
      if (a.kind === 'script') {
        if (a.format === 'text') fail('text 格式的脚本只能有一个');
        const v = prepareItem(a, null, newScript(op.value || {}));
        if (Array.isArray(a.content)) a.content.push(v); else a.content = [a.content, v];
        return { key: 's:' + (itemsOf(a).length - 1) };
      }
      fail('这一类内容不能新增条目');
    }
    case 'deleteItem': {
      const a = art(op.a), items = itemsOf(a), it = items.find(x => x.key === op.key);
      if (!it) fail('找不到这一项');
      if (items.length <= 1) fail('至少要保留一项；不需要的话可以删除整个 artifact');
      if (a.kind === 'worldbook') {
        const c = a.content;
        if (Array.isArray(c.entries)) c.entries.splice(Number(op.key), 1); else delete c.entries[op.key];
        return {};
      }
      if (it.whole || it.textOnly) fail('这一项不能单独删除');
      const parent = getAt(a, it.jp.slice(0, -1));
      if (!Array.isArray(parent)) fail('这一项不能单独删除');
      if (parent.length <= 1) fail('文件夹里至少要保留一个脚本');
      parent.splice(it.jp[it.jp.length - 1], 1);
      return {};
    }
    case 'addArtifact': {
      if (arts.length >= (R.MAX_ARTIFACTS || 32)) fail('artifact 最多 ' + (R.MAX_ARTIFACTS || 32) + ' 个');
      arts.push(newArtifact(op));
      return { a: arts.length - 1 };
    }
    case 'deleteArtifact': { art(op.a); if (arts.length <= 1) fail('离线包至少要有一个 artifact'); arts.splice(op.a, 1); return {}; }
    case 'moveArtifact': {
      art(op.a);
      const to = Math.max(0, Math.min(arts.length - 1, op.to));
      const [x] = arts.splice(op.a, 1); arts.splice(to, 0, x);
      return { a: to };
    }
  }
  fail('不认识的编辑操作：' + op.op);
}
function imageDataUrl(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' }[ext];
  if (!type) fail('不支持的图片格式（可用 jpg / png / webp / gif / svg / avif）');
  const buf = fs.readFileSync(file);
  if (buf.length > 3 * 1024 * 1024) fail('封面图超过 3 MB，离线包总大小不能超过 6 MB，请先压缩图片');
  return 'data:' + type + ';base64,' + buf.toString('base64');
}
function editPack(p, op) {
  const k = normKey(p);
  let d = drafts.get(k);
  const fresh = !d;
  if (fresh) d = { path: p, pack: clone(R.loadPack(p, [])), history: [], rev: 0, count: 0 };
  const before = JSON.stringify(d.pack);
  const work = JSON.parse(before);
  const res = editPackObject(work, op);
  const after = JSON.stringify(work);
  if (after === before) return { changed: false, ...res };
  d.history.push(before); if (d.history.length > 60) d.history.shift();
  d.pack = work; d.rev++; d.count++;
  if (fresh) drafts.set(k, d);
  infoCache.delete('pack:' + k);
  // 撤销到与已保存文件完全一样时，草稿自动消失
  return { changed: true, ...res };
}
function undoDraft(p) {
  const k = normKey(p), d = drafts.get(k);
  if (!d || !d.history.length) fail('没有可以撤销的修改');
  d.pack = JSON.parse(d.history.pop()); d.rev++; d.count = Math.max(0, d.count - 1);
  if (!d.history.length) drafts.delete(k);
  infoCache.delete('pack:' + k);
  return { ok: true };
}
function discardDraft(p) { const k = normKey(p); drafts.delete(k); infoCache.delete('pack:' + k); return { ok: true }; }
function saveDraft(p, { mode = 'version', overwrite = false } = {}) {
  needEdit();
  const k = normKey(p), d = drafts.get(k);
  if (!d) fail('没有未保存的修改');
  const saved = R.loadPack(p, []);
  const pack = clone(d.pack);
  let target = p;
  if (mode === 'version') {
    const v = Math.max(Number(pack.project.version), Number(saved.project.version) + 1);
    pack.project.version = v;
    target = path.join(path.dirname(p), R.safeName(pack.project.name, 60) + '-v' + v + '.rwpack');
    if (fs.existsSync(target) && !samePath(target, p) && !overwrite) return { ok: false, confirm: { kind: 'overwrite', target, file: path.basename(target) } };
  }
  if (R.validateProject) R.validateProject(pack.project);
  R.validateBundle(pack.bundle);
  const errors = R.installCheck(pack);
  if (errors.length) fail('工坊安装时会失败，没有保存：\n' + errors.join('\n'));
  R.rebuildManifest(pack, []);
  R.verifyManifest(pack);
  const w = R.writePack(pack, target, { backup: state.settings.backup !== false });
  drafts.delete(k); infoCache.delete('pack:' + k); invalidate(target);
  addAnchor(target);
  const warns = R.lint(pack);
  const lines = ['■ 保存修改 ' + p, '  ✓ ' + (w.same ? '内容与已有文件相同，未改写 → ' : '已保存并通过校验 → ') + target + (w.bak ? '（原文件备份为 ' + path.basename(w.bak) + '）' : ''), ...warns.map(x => '  ⚠ ' + x)];
  return { ok: true, result: { kind: 'save', target, bak: w.bak, same: w.same, version: pack.project.version, name: pack.project.name, warns }, log: lines.join('\n') };
}

// ---------- 直接编辑：项目文件夹（逐个写回文件） ----------
const readJson = (f, label) => R.parseLoose(readTextFile(f), label, null);
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
function writeIfChanged(f, text) { try { if (fs.readFileSync(f, 'utf8') === text) return false; } catch {} fs.writeFileSync(f, text); return true; }
function uniqueName(dir, name, except) {
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  let n = name, i = 2;
  while (fs.existsSync(path.join(dir, n)) && !(except && samePath(path.join(dir, n), except))) n = stem + ' (' + (i++) + ')' + ext;
  return n;
}
function insideDir(root, f) { const r = path.relative(root, f); return !!r && !r.startsWith('..') && !path.isAbsolute(r); }
function extFor(str, kind, key) {
  if (kind === 'script' && key === 'content') return '.js';
  if (/^```html\b/.test(str) || /^\s*(<!DOCTYPE html|<html[\s>])/i.test(str)) return '.html';
  return '.txt';
}
// 写回 artifact.json：原来是 {"$file"} 引用的字段写进那个文件，其余字段直接改 JSON
function mergeRaw(rawNode, val, ctx) {
  if (isFileMark(rawNode)) {
    if (typeof val === 'string') {
      const f = path.resolve(ctx.base, rawNode.$file);
      if (!insideDir(ctx.root, f)) fail('引用的文件不在项目文件夹内：' + rawNode.$file);
      writeIfChanged(f, val);
      return rawNode;
    }
    return newRaw(val, ctx);
  }
  if (isMark(rawNode)) return newRaw(val, ctx);
  if (isObj(rawNode) && isObj(val)) {
    const out = {};
    for (const k of Object.keys(rawNode)) if (k in val) out[k] = mergeRaw(rawNode[k], val[k], ctx.child(k));
    for (const k of Object.keys(val)) if (!(k in rawNode)) out[k] = newRaw(val[k], ctx.child(k));
    return out;
  }
  if (Array.isArray(rawNode) && Array.isArray(val)) return val.map((x, i) => (i < rawNode.length ? mergeRaw(rawNode[i], x, ctx.child(i, x)) : newRaw(x, ctx.child(i, x))));
  return newRaw(val, ctx);
}
// 新写入的长文本按 rwkit 解包的习惯拆成单独文件
function newRaw(val, ctx) {
  if (typeof val === 'string' && (val.length >= 120 || val.includes('\n')) && (ctx.key === 'content' || ctx.key === 'replaceString')) {
    const name = uniqueName(ctx.base, R.safeName(ctx.labels.join('.') || 'content', 80) + extFor(val, ctx.kind, ctx.key));
    fs.writeFileSync(path.join(ctx.base, name), val);
    return { $file: name };
  }
  if (Array.isArray(val)) return val.map((x, i) => newRaw(x, ctx.child(i, x)));
  if (isObj(val)) {
    if (R.escapeLiterals && isMark(val)) return R.escapeLiterals(val);
    return Object.fromEntries(Object.keys(val).map(k => [k, newRaw(val[k], ctx.child(k))]));
  }
  return val;
}
// 文件命名与 rwkit 解包一致：artifact 的 content 这一层不计入名称（如“01 名称.replaceString.html”）
function rawCtx(root, base, kind, labels = [], depth = 0) {
  return {
    root, base, kind, labels, key: null,
    child(k, v) {
      const lab = typeof k === 'number' ? String(k + 1).padStart(2, '0') + (isObj(v) && (v.scriptName ?? v.name) ? ' ' + R.safeName(v.scriptName ?? v.name, 30) : '') : k;
      const skip = depth === 0 && k === 'content';
      const c = rawCtx(root, base, kind, skip ? labels : labels.concat(lab), depth + 1); c.key = typeof k === 'number' ? null : k; return c;
    },
  };
}
// 删除某一项时，它独占的引用文件一并移到回收站
function fileRefsIn(raw, base) {
  const out = [];
  const walk = v => { if (isFileMark(v)) out.push(path.resolve(base, v.$file)); else if (Array.isArray(v)) v.forEach(walk); else if (isObj(v) && !isMark(v)) Object.values(v).forEach(walk); };
  walk(raw);
  return out;
}
function entryFileName(key, e) { return R.safeName(key + (String(e.comment ?? e.name ?? '').trim() ? ' ' + String(e.comment ?? e.name).trim() : ''), 70) + '.txt'; }
async function editFolder(dir, op) {
  needEdit();
  const pjFile = path.join(dir, 'project.json');
  const touchDone = () => { invalidate(dir); return true; };
  if (op.op === 'project' || op.op === 'cover' || op.op === 'overrides') {
    const pj = readJson(pjFile, 'project.json');
    if (!isObj(pj.project)) fail('project.json 里缺少 project');
    if (op.op === 'project') pj.project = applyProjectFields(pj.project, op.fields || {});
    else if (op.op === 'overrides') { checkOverrides(op.list); if (!isObj(pj.bundle)) pj.bundle = { schema_version: 1, artifacts: { $artifacts: '按编号顺序读取各 artifact 文件夹' } }; pj.bundle.resource_overrides = clone(op.list); }
    else {
      const old = pj.project.cover_url, oldFile = isObj(old) && typeof old.$image === 'string' ? path.resolve(dir, old.$image) : null;
      if (op.file) {
        imageDataUrl(op.file);
        const name = 'cover' + path.extname(op.file).toLowerCase().replace('.jpeg', '.jpg');
        const dest = path.join(dir, name);
        if (!samePath(path.resolve(op.file), dest)) fs.copyFileSync(op.file, dest);
        pj.project.cover_url = { $image: name };
        pj.project.has_cover = true;
        if (oldFile && !samePath(oldFile, dest) && insideDir(dir, oldFile) && fs.existsSync(oldFile)) await env.trash(oldFile);
      } else {
        delete pj.project.cover_url; pj.project.has_cover = false;
        if (oldFile && insideDir(dir, oldFile) && fs.existsSync(oldFile)) await env.trash(oldFile);
      }
    }
    writeJson(pjFile, pj);
    touchDone();
    return { changed: true };
  }
  const src = getSource(dir);
  const arts = src.pack.bundle.artifacts, folders = src.folders;
  if (op.op === 'addArtifact') {
    if (arts.length >= (R.MAX_ARTIFACTS || 32)) fail('artifact 最多 ' + (R.MAX_ARTIFACTS || 32) + ' 个');
    const a = newArtifact(op);
    const nums = folders.map(f => Number(/^(\d+)/.exec(f)?.[1] || 0));
    const prefix = String(Math.max(arts.length, ...nums) + 1).padStart(2, '0');
    const name = uniqueName(dir, prefix + ' ' + ((R.KIND_LABEL || {})[a.kind] || a.kind) + ' · ' + R.safeName(a.name.replace(/\.(json|txt|js)$/i, ''), 40));
    const w = new R.Writer(path.join(dir, name));
    const meta = {};
    for (const k of Object.keys(a)) meta[k] = k === 'content' ? R.artifactContent(a, w) : R.escapeLiterals(clone(a[k]));
    w.write('artifact.json', JSON.stringify(meta, null, 2) + '\n');
    touchDone();
    return { changed: true, a: getSource(dir).folders.indexOf(name) };
  }
  const a = arts[op.a];
  if (!a || !folders[op.a]) fail('找不到这个 artifact');
  const adir = path.join(dir, folders[op.a]), ajson = path.join(adir, 'artifact.json');
  const raw = readJson(ajson, folders[op.a] + '/artifact.json');
  if (op.op === 'deleteArtifact') {
    if (arts.length <= 1) fail('项目至少要有一个 artifact');
    await env.trash(adir);
    touchDone();
    return { changed: true };
  }
  if (op.op === 'moveArtifact') {
    const order = folders.slice();
    const to = Math.max(0, Math.min(order.length - 1, op.to));
    const [x] = order.splice(op.a, 1); order.splice(to, 0, x);
    // 只改编号；先全部改成临时名再改成新名，任何一步失败都还原
    const rest = n => n.replace(/^\d+\s*/, '');
    const plan = order.map((n, i) => ({ from: n, to: String(i + 1).padStart(2, '0') + ' ' + rest(n) })).filter(x => x.from !== x.to);
    const moved = [];
    try {
      for (const x of plan) { x.tmp = '.rwkit-move-' + crypto.randomBytes(4).toString('hex'); fs.renameSync(path.join(dir, x.from), path.join(dir, x.tmp)); moved.push(x); }
      for (const x of plan) { if (fs.existsSync(path.join(dir, x.to))) throw new Error('已存在同名文件夹 ' + x.to); fs.renameSync(path.join(dir, x.tmp), path.join(dir, x.to)); x.done = true; }
    } catch (e) {
      for (const x of moved.reverse()) { try { fs.renameSync(path.join(dir, x.done ? x.to : x.tmp), path.join(dir, x.from)); } catch {} }
      fail('调整顺序失败（文件夹可能正被其他程序占用）：' + e.message);
    }
    touchDone();
    return { changed: true, a: to };
  }
  if (op.op === 'artifactMeta') {
    const next = applyArtifactMeta(a, op.meta || {});
    for (const k of ['name', 'scope', 'original_conflicts']) { if (k in next) raw[k] = clone(next[k]); else delete raw[k]; }
    writeJson(ajson, raw);
    // 名称改了，文件夹名也跟着改，方便辨认
    if (next.name !== a.name) {
      const prefix = /^(\d+)/.exec(folders[op.a])?.[1] || String(op.a + 1).padStart(2, '0');
      const want = uniqueName(dir, prefix + ' ' + ((R.KIND_LABEL || {})[a.kind] || a.kind) + ' · ' + R.safeName(next.name.replace(/\.(json|txt|js)$/i, ''), 40), adir);
      if (!samePath(path.join(dir, want), adir)) { try { fs.renameSync(adir, path.join(dir, want)); } catch (e) { env.log('重命名文件夹失败：' + e.message); } }
    }
    touchDone();
    return { changed: true };
  }
  const items = itemsOf(a);
  const entriesMark = a.kind === 'worldbook' && isObj(raw.content) && isObj(raw.content.entries) && typeof raw.content.entries.$entries === 'string' ? raw.content.entries : null;
  if (entriesMark) {
    // 世界书条目：一条一个 .txt
    const edir = path.resolve(adir, entriesMark.$entries), isArr = entriesMark.array === true;
    const files = entryFiles(edir);
    const entries = a.content.entries;
    if (op.op === 'item') {
      const it = items.find(x => x.key === op.key);
      if (!it) fail('找不到这一项（可能已被删除）');
      const orig = isArr ? entries[Number(op.key)] : entries[op.key];
      const v = prepareItem(a, it, mergeOrdered(orig, op.value));
      let newKey = op.key;
      if (!isArr) {
        newKey = op.key === String(orig.uid) ? String(v.uid) : op.key;
        for (const [k2, x] of Object.entries(entries)) if (k2 !== op.key && (k2 === newKey || String(x?.uid) === String(v.uid))) fail('uid ' + v.uid + ' 已被「' + (x.comment || k2) + '」使用');
      }
      const oldFile = files.get(String(op.key));
      if (!oldFile) fail('找不到这个条目的文件，可能已在外部改名或删除');
      const text = R.entryText(v, !isArr && newKey !== String(v.uid) ? newKey : undefined);
      const prefix = isArr ? (/^(\d+)/.exec(path.basename(oldFile))?.[1] || String(Number(op.key) + 1).padStart(3, '0')) : newKey;
      const want = uniqueName(edir, entryFileName(prefix, v), oldFile);
      let target = oldFile;
      if (want !== path.basename(oldFile)) { target = path.join(edir, want); fs.renameSync(oldFile, target); }
      writeIfChanged(target, text);
      touchDone();
      return { changed: true, key: newKey };
    }
    if (op.op === 'addItem') {
      if (isArr) fail('这个世界书的格式不支持在这里新增条目');
      const uid = op.value?.uid != null && !Object.values(entries).some(x => String(x?.uid) === String(op.value.uid)) ? op.value.uid : nextUid(entries);
      const v = prepareItem(a, null, newEntry(uid, { ...(op.value || {}), uid }));
      fs.mkdirSync(edir, { recursive: true });
      fs.writeFileSync(path.join(edir, uniqueName(edir, entryFileName(String(uid), v))), R.entryText(v));
      touchDone();
      return { changed: true, key: String(uid) };
    }
    if (op.op === 'deleteItem') {
      if (items.length <= 1) fail('至少要保留一条条目；不需要的话可以删除整个世界书');
      const f = files.get(String(op.key));
      if (!f) fail('找不到这个条目的文件');
      await env.trash(f);
      touchDone();
      return { changed: true };
    }
  }
  // 正则、脚本、预设、数据，以及没有拆成条目文件的世界书：改 artifact.json（引用文件写进对应文件）
  const ctx = rawCtx(dir, adir, a.kind);
  if (op.op === 'item') {
    const it = items.find(x => x.key === op.key);
    if (!it) fail('找不到这一项（可能已被删除）');
    let jp, value;
    if (a.kind === 'worldbook') { jp = Array.isArray(a.content.entries) ? ['content', 'entries', Number(op.key)] : ['content', 'entries', op.key]; value = prepareItem(a, it, mergeOrdered(getAt(a, jp), op.value)); }
    else if (it.whole) { jp = ['content']; value = op.value; }
    else if (it.textOnly) { jp = ['content']; value = prepareItem(a, it, op.value); }
    else { jp = it.jp; value = prepareItem(a, it, mergeOrdered(getAt(a, jp), op.value)); }
    let parent = raw;
    for (let i = 0; i < jp.length - 1; i++) { parent = parent?.[jp[i]]; if (!parent || isMark(parent)) fail('这一项的文件结构无法自动写回，请用编辑器直接修改 artifact.json'); }
    const last = jp[jp.length - 1];
    let c = ctx; jp.forEach((k, i) => { c = c.child(k, getAt(a, jp.slice(0, i + 1))); });
    parent[last] = mergeRaw(parent[last], value, c);
    writeJson(ajson, raw);
    touchDone();
    return { changed: true, key: op.key };
  }
  if (op.op === 'addItem') {
    if (a.kind === 'regex') {
      const v = prepareItem(a, null, newRegex(op.value || {}));
      const { jp } = regexBase(a.content);
      if (jp) { const list = getAt(raw, jp); list.push(newRaw(v, ctx.child('content').child(list.length, v))); }
      else raw.content = [raw.content, newRaw(v, ctx.child('content').child(1, v))];
    } else if (a.kind === 'script') {
      if (a.format === 'text') fail('text 格式的脚本只能有一个');
      const v = prepareItem(a, null, newScript(op.value || {}));
      if (Array.isArray(raw.content)) raw.content.push(newRaw(v, ctx.child('content').child(raw.content.length, v)));
      else raw.content = [raw.content, newRaw(v, ctx.child('content').child(1, v))];
    } else fail('这一类内容不能新增条目');
    writeJson(ajson, raw);
    touchDone();
    const after = getSource(dir).pack.bundle.artifacts[op.a];
    return { changed: true, key: itemsOf(after).at(-1)?.key };
  }
  if (op.op === 'deleteItem') {
    const it = items.find(x => x.key === op.key);
    if (!it) fail('找不到这一项');
    if (items.length <= 1) fail('至少要保留一项；不需要的话可以删除整个 artifact');
    if (it.whole || it.textOnly || !it.jp) fail('这一项不能单独删除');
    const parentRaw = getAt(raw, it.jp.slice(0, -1));
    if (!Array.isArray(parentRaw)) fail('这一项不能单独删除');
    if (parentRaw.length <= 1) fail('文件夹里至少要保留一个脚本');
    const [removed] = parentRaw.splice(it.jp[it.jp.length - 1], 1);
    writeJson(ajson, raw);
    const still = new Set(fileRefsIn(raw, adir).map(normKey));
    for (const f of fileRefsIn(removed, adir)) if (!still.has(normKey(f)) && insideDir(dir, f) && fs.existsSync(f)) await env.trash(f);
    touchDone();
    return { changed: true };
  }
  fail('不认识的编辑操作：' + op.op);
}
export async function edit(p, op) {
  needEdit();
  p = path.resolve(p);
  const res = fs.statSync(p).isDirectory() ? await editFolder(p, op) : editPack(p, op);
  touch(p);
  return res;
}

// ---------- 新建项目 ----------
function newProject({ dir, name, category = 'extension' }) {
  needEdit();
  if (!R.writeSource || !R.freeDir) fail('当前使用的 rwkit.mjs 版本不支持新建项目');
  const n = String(name || '').trim();
  if (!n) fail('项目名称不能为空');
  if (!fs.existsSync(dir)) fail('找不到文件夹：' + dir);
  const pack = {
    format: R.OFFLINE_FORMAT || 'reincarnation-workshop-project', version: R.OFFLINE_VERSION || 1, exported_at: Date.now(),
    project: { id: crypto.randomUUID(), name: n, category, version: 1, dependencies: [], summary: '', tags: [] },
    manifest: { schema_version: 1 },
    bundle: { schema_version: 1, artifacts: [newArtifact({ kind: 'worldbook', name: n + '-世界书' })], resource_overrides: [] },
  };
  pack.bundle.artifacts[0].content.entries[1].comment = n + '·总纲';
  pack.bundle.artifacts[0].content.entries[1].constant = true;
  pack.bundle.artifacts[0].content.entries[1].content = '<' + n + '>\n在这里写常驻设定。\n</' + n + '>';
  R.rebuildManifest(pack, []);
  const target = R.freeDir(path.join(dir, R.safeName(n, 60)), false);
  R.writeSource(pack, target);
  addAnchor(target);
  return target;
}

// ---------- 修复、解包、打包、示例 ----------
function doAction(body) {
  const { action, opts: o = {} } = body;
  const p = body.path ? path.resolve(String(body.path)) : null;
  const backup = state.settings.backup !== false;
  const lines = [];
  try {
    if (action === 'check') {
      invalidate(p);
      const i = fs.statSync(p).isDirectory() ? folderInfo(p) : packInfo(p);
      lines.push('■ 检查 ' + p, ...i.notes.map(n => '  · ' + n), i.fatal ? '  ✗ ' + i.fatal : '', ...i.errors.map(e => '  ✗ ' + e.text), ...i.warns.map(w => '  ⚠ ' + w.text), '  ' + ({ ok: '✓ 通过', warn: '✓ 通过（有提示）', fix: '△ 需要修复', error: '✗ 未通过' })[i.level]);
      return { ok: true, result: { kind: 'check', level: i.level, path: p }, log: lines.filter(Boolean).join('\n') };
    }
    if (action === 'fix') {
      const ro = { check: false, bump: !!o.bump, backup, out: null };
      lines.push('■ ' + (o.bump ? '修复并升版本号 ' : '修复 ') + p);
      if (o.bump) {
        const pk = R.loadPack(p, []);
        const target = path.join(path.dirname(p), R.safeName(pk.project.name, 60) + '-v' + (Number(pk.project.version) + 1) + '.rwpack');
        if (fs.existsSync(target) && !o.overwrite) return { ok: false, confirm: { kind: 'overwrite', target, file: path.basename(target) } };
        if (fs.existsSync(target) && backup) fs.copyFileSync(target, target + '.bak');
        ro.out = target;
      }
      const r = R.fixFile(p, ro);
      r.notes.forEach(n => lines.push('  · ' + n));
      lines.push(!r.needWrite ? '  ✓ 校验通过，无需修复' : '  ✓ 已修复并通过校验 → ' + r.target + (r.backup ? '（原文件备份为 ' + path.basename(r.backup) + '）' : ''));
      r.errors.forEach(e => lines.push('  ✗ 工坊安装时会失败：' + e)); r.warns.forEach(w => lines.push('  ⚠ ' + w));
      if (r.target) { addAnchor(r.target); invalidate(r.target); }
      return { ok: true, result: { kind: 'fix', wrote: r.needWrite, target: r.target, backup: r.backup, notes: r.notes, warns: r.warns, errors: r.errors, version: r.project.version, name: r.project.name }, log: lines.join('\n') };
    }
    if (action === 'unpack') {
      const pk = peekPack(p);
      if (!o.force && pk) {
        const existing = scanDir(path.dirname(p), new Set([pk.id])).filter(x => x.kind === 'folder');
        if (existing.length) return { ok: false, confirm: { kind: 'unpack-exists', folders: existing.map(x => ({ path: x.path, file: x.file, version: x.project?.version })) } };
      }
      lines.push('■ 解包 ' + p);
      const r = R.unpackFile(p, {});
      r.notes.forEach(n => lines.push('  · ' + n));
      lines.push('  ✓ 已解包到 ' + r.dir + '（' + r.files + ' 个文件）');
      addAnchor(r.dir);
      return { ok: true, result: { kind: 'unpack', dir: r.dir, files: r.files, notes: r.notes, name: r.pack.project.name, version: r.pack.project.version }, log: lines.join('\n') };
    }
    if (action === 'pack') {
      lines.push('■ ' + (o.bump ? '打包并升版本号 ' : '打包 ') + p);
      const r = R.packDir(p, { bump: !!o.bump, backup });
      r.notes.forEach(n => lines.push('  · ' + n));
      lines.push('  ✓ ' + (r.same ? '内容与已有文件相同，未改写 → ' : '已打包并通过校验 → ') + r.target + (r.bak ? '（原文件备份为 ' + path.basename(r.bak) + '）' : ''));
      r.warns.forEach(w => lines.push('  ⚠ ' + w));
      invalidate(p); invalidate(r.target);
      return { ok: true, result: { kind: 'pack', target: r.target, same: r.same, bak: r.bak, size: r.size, notes: r.notes, warns: r.warns, version: r.pack.project.version, name: r.pack.project.name }, log: lines.join('\n') };
    }
    if (action === 'example') {
      if (!o.dest) fail('请选择生成示例的位置');
      lines.push('■ 生成示例到 ' + o.dest);
      const r = R.makeExample(o.dest, { backup });
      lines.push('  ✓ 示例项目文件夹：' + r.dir, '  ✓ 示例离线包：' + r.target);
      r.warns.forEach(w => lines.push('  ⚠ ' + w));
      addAnchor(r.dir);
      return { ok: true, result: { kind: 'example', dir: r.dir, target: r.target, warns: r.warns }, log: lines.join('\n') };
    }
    if (action === 'new') {
      lines.push('■ 新建项目 ' + o.name + ' 于 ' + o.dir);
      const dir = newProject(o);
      lines.push('  ✓ 项目文件夹：' + dir);
      return { ok: true, result: { kind: 'new', dir }, log: lines.join('\n') };
    }
    fail('不认识的操作：' + action);
  } catch (e) {
    const msg = errText(e);
    if (!isPackError(e) && !(e instanceof UserError)) env.log(e.stack || msg);
    lines.push('  ✗ ' + msg);
    let loc = null;
    try { if (p && fs.statSync(p).isDirectory()) loc = locateError(p, msg, null, null); } catch {}
    return { ok: false, error: msg, loc, log: lines.join('\n') };
  }
}

// ---------- 给创意工坊模块用：rwkit 函数与本地项目的完整内容 ----------
export const rwkitModule = () => (R && !rw.error ? R : null);
export const isUserError = e => e instanceof UserError || isPackError(e);
export function sourcePack(p) {
  if (!rwkitModule()) fail(rw.error || 'rwkit.mjs 不可用');
  const s = getSource(p);
  const info = fs.statSync(p).isDirectory() ? folderInfo(p) : packInfo(p);
  return { pack: clone(s.pack), draft: !!s.draft, info };
}

// ---------- 打开、移除 ----------
export function openPaths(paths) {
  const opened = [], errors = [];
  for (const raw of paths || []) {
    const p = path.resolve(String(raw));
    let st; try { st = fs.statSync(p); } catch { errors.push({ path: p, message: '找不到：' + p }); continue; }
    try {
      if (st.isFile()) {
        if (path.basename(p).toLowerCase() === 'project.json') { opened.push(openOne(path.dirname(p))); continue; }
        if (!isPackName(p)) { errors.push({ path: p, message: path.basename(p) + ' 不是 .rwpack 离线包' }); continue; }
        opened.push(openOne(p));
      } else if (isProjectDir(p)) opened.push(openOne(p));
      else {
        const found = scanDir(p, null);
        if (!found.length) { errors.push({ path: p, message: '文件夹里没有离线包或项目文件夹：' + p }); continue; }
        addAnchor(p);
        for (const i of found) { if (i.project?.id) unhide(i.project.id); opened.push({ path: i.path, id: i.project?.id || null }); }
      }
    } catch (e) { errors.push({ path: p, message: errText(e) }); }
  }
  return { opened, errors };
}
function openOne(p) {
  const i = fs.statSync(p).isDirectory() ? folderInfo(p) : packInfo(p);
  if (i.project?.id) unhide(i.project.id);
  addAnchor(p);
  return { path: p, id: i.project?.id || null };
}
function unhide(id) { if (state.hidden.includes(id)) { state.hidden = state.hidden.filter(x => x !== id); saveState(); } }
function removeProject(id, p) {
  if (p) state.anchors = state.anchors.filter(a => !samePath(a.path, p));
  if (id) {
    state.anchors = state.anchors.filter(a => {
      try { const st = fs.statSync(a.path); if (st.isFile()) return peekPack(a.path)?.id !== id; if (isProjectDir(a.path)) return peekProjectJson(a.path)?.id !== id; return true; } catch { return true; }
    });
    for (const [k, d] of drafts) if (String(d.pack.project?.id) === id) drafts.delete(k);
    if (!state.hidden.includes(id)) state.hidden.push(id);
    state.hidden = state.hidden.slice(-500);
  }
  saveState();
}

// ---------- 封面、语法检查、VS Code ----------
export function coverOf(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    const pj = JSON.parse(readTextFile(path.join(p, 'project.json')));
    const c = pj?.project?.cover_url;
    if (isObj(c) && typeof c.$image === 'string') {
      const f = path.resolve(p, c.$image);
      if (!insideDir(p, f)) return null;
      const ext = path.extname(f).slice(1).toLowerCase();
      return { type: c.type || { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' }[ext] || 'application/octet-stream', buf: fs.readFileSync(f) };
    }
    return typeof c === 'string' ? dataUrl(c) : null;
  }
  return dataUrl(getSource(p).pack.project?.cover_url);
}
function dataUrl(u) { const m = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(String(u || '')); return m ? { type: m[1], buf: Buffer.from(m[2], 'base64') } : null; }
function syntax(code) {
  try { new vm.Script(String(code ?? ''), { filename: 'script.js' }); return { ok: true }; }
  catch (e) {
    if (/import|export|await/.test(e.message)) return { ok: true, note: '包含模块语法，跳过检查' };
    const m = /script\.js:(\d+)/.exec(e.stack || '');
    return { ok: false, message: e.message, line: m ? Number(m[1]) : null };
  }
}
let codeCmd;
export function findCode() {
  if (codeCmd !== undefined) return codeCmd;
  codeCmd = null;
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', [IS_WIN ? 'code.cmd' : 'code'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    codeCmd = out.split(/\r?\n/).map(s => s.trim()).find(Boolean) || null;
  } catch {}
  return codeCmd;
}
export function openInCode(p, line, col, root) {
  const code = findCode();
  if (!code) return false;
  const args = [];
  if (root && fs.existsSync(root)) args.push(root);
  if (fs.statSync(p).isFile()) args.push('-g', p + ':' + (line || 1) + ':' + (col || 1)); else if (!root) args.push(p);
  const c = IS_WIN
    ? spawn('cmd.exe', ['/d /s /c ""' + code + '" ' + args.map(a => (a.startsWith('-') ? a : '"' + a + '"')).join(' ') + '"'], { windowsVerbatimArguments: true, windowsHide: true, detached: true, stdio: 'ignore' })
    : spawn(code, args, { detached: true, stdio: 'ignore' });
  c.on('error', e => env.log('启动 VS Code 失败：' + e.message)); c.unref();
  return true;
}

// ---------- 留意文件变化 ----------
const watched = new Map();
function watchSig(d, deep) {
  if (deep) return dirSig(d).key;
  try {
    return fs.readdirSync(d, { withFileTypes: true })
      .filter(e => (e.isFile() && isPackName(e.name)) || (e.isDirectory() && isProjectDir(path.join(d, e.name))))
      .map(e => { const st = fs.statSync(path.join(d, e.name)); return e.name + (e.isFile() ? ':' + st.size + ':' + st.mtimeMs : '/'); })
      .sort().join('|');
  } catch { return ''; }
}
export function syncWatchers() {
  if (!R) return;
  const want = new Map();
  try {
    const v = collect();
    for (const p of v.projects.values()) {
      for (const { path: f } of p.folders.values()) { want.set(f, true); if (!want.has(path.dirname(f))) want.set(path.dirname(f), false); }
      for (const { path: k } of p.packs.values()) if (!want.has(path.dirname(k))) want.set(path.dirname(k), false);
    }
  } catch {}
  watched.clear();
  for (const [d, deep] of want) if (watched.size < 60) watched.set(d, { deep, sig: watchSig(d, deep) });
}
let pollTimer = null;
export function startPolling(active) {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!active() || !watched.size) return;
    let any = false;
    for (const [d, w] of watched) { const s = watchSig(d, w.deep); if (s !== w.sig) { w.sig = s; any = true; } }
    if (any) env.emit('changed', {});
  }, 1500);
  pollTimer.unref?.();
}

// ---------- 路由：界面通过 IPC 调用 ----------
export async function handle(route, body = {}) {
  const ready = await ensureRwkit();
  const need = () => { if (!ready) fail(rw.error || 'rwkit.mjs 不可用'); };
  const abs = v => path.resolve(String(v || ''));
  try {
    switch (route) {
      case 'state': return { rwkit: rwkitInfo(), editor: !!findCode(), settings: state.settings, lastDir: state.lastDir, ...(ready ? view() : { projects: [], loose: [] }) };
      case 'projects': return ready ? view() : { projects: [], loose: [] };
      case 'open': { need(); const r = openPaths(body.paths); syncWatchers(); return { ...r, ...view() }; }
      case 'remove': removeProject(body.id, body.path && abs(body.path)); syncWatchers(); return view();
      case 'action': { need(); const r = doAction(body); syncWatchers(); return { ...r, ...view() }; }
      case 'content': need(); return describe(abs(body.path));
      case 'detail': need(); return detail(abs(body.path), body.a, body.key);
      case 'artifact': need(); return artifactDetail(abs(body.path), body.a);
      case 'project': need(); return projectDetail(abs(body.path));
      case 'diff': need(); return diff(abs(body.a), abs(body.b), { aSaved: !!body.aSaved });
      case 'edit': {
        need();
        const r = await edit(abs(body.path), body.op);
        syncWatchers();
        return { ok: true, ...r, ...view() };
      }
      case 'draft.save': { need(); const r = saveDraft(abs(body.path), body); syncWatchers(); return { ...r, ...view() }; }
      case 'draft.undo': need(); undoDraft(abs(body.path)); return { ok: true, ...view() };
      case 'draft.discard': discardDraft(abs(body.path)); return { ok: true, ...view() };
      case 'syntax': return syntax(body.code);
      case 'editor': return { ok: openInCode(abs(body.path), body.line, body.col, body.root && abs(body.root)) };
      case 'settings': {
        for (const k of ['backup', 'sidebar']) if (typeof body[k] === 'boolean') state.settings[k] = body[k];
        if (['auto', 'light', 'dark'].includes(body.theme)) state.settings.theme = body.theme;
        if (typeof body.rwkitPath === 'string') { state.settings.rwkitPath = body.rwkitPath; R = null; await ensureRwkit(); }
        saveState();
        return { settings: state.settings, rwkit: rwkitInfo() };
      }
    }
    fail('不认识的请求：' + route);
  } catch (e) {
    if (!isPackError(e) && !(e instanceof UserError)) env.log(e.stack || String(e));
    return { ok: false, error: errText(e) };
  }
}
