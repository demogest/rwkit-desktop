// 应用内检查更新：读 GitHub Releases 的最新版本，下载对应的安装版 / 免安装版并按 SHA-256 校验。与 Electron 无关，可单独测试。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const REPO = 'demogest/rwkit-desktop';
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
class UserError extends Error {}
const fail = msg => { throw new UserError(msg); };

const env = {
  version: '0.0.0',
  kind: 'dev',            // setup（安装版）/ portable（免安装版）/ dev（源码运行）
  dataDir: '',
  downloadDir: '',        // 免安装版：新版本放在当前 exe 旁边；安装版：临时文件夹
  fetch: (...a) => globalThis.fetch(...a),
  api: `https://api.github.com/repos/${REPO}/releases/latest`,
  log: () => {},
  emit: () => {},
};
const conf = { auto: true, lastCheck: 0, skip: '' };
const file = () => path.join(env.dataDir, 'update.json');
function save() { try { fs.writeFileSync(file(), JSON.stringify(conf, null, 1)); } catch (e) { env.log('保存更新设置失败：' + e.message); } }
export function init(options) {
  Object.assign(env, options);
  try { const s = JSON.parse(fs.readFileSync(file(), 'utf8')); if (typeof s.auto === 'boolean') conf.auto = s.auto; if (Number.isFinite(s.lastCheck)) conf.lastCheck = s.lastCheck; if (typeof s.skip === 'string') conf.skip = s.skip; } catch {}
}

// 只比较数字部分：1.10.0 > 1.9.3；带预发布后缀的版本低于同号正式版
export function compareVersions(a, b) {
  const parse = v => { const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?/.exec(String(v).trim()); return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] || '' } : null; };
  const x = parse(a), y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i] ? 1 : -1;
  if (x.pre === y.pre) return 0;
  return !x.pre ? 1 : !y.pre ? -1 : x.pre > y.pre ? 1 : -1;
}

let latest = null, download = null;
function pickAsset(assets, kind) {
  const list = (assets || []).filter(a => /\.exe$/i.test(a.name));
  const want = kind === 'portable' ? /portable\.exe$/i : /setup\.exe$/i;
  return list.find(a => want.test(a.name)) || null;
}
export function state() {
  return { version: env.version, kind: env.kind, auto: conf.auto, lastCheck: conf.lastCheck, skip: conf.skip, latest, newer: !!latest && compareVersions(latest.version, env.version) > 0, download: download && { state: download.state, received: download.received, total: download.total, file: download.file, error: download.error, version: download.version } };
}
export async function check() {
  let r;
  try { r = await env.fetch(env.api, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'rwkit-desktop/' + env.version }, signal: AbortSignal.timeout(15000) }); }
  catch (e) { fail(e.name === 'TimeoutError' ? '连接 GitHub 超时，请稍后再试' : '无法连接 GitHub：' + (e.cause?.code || e.message)); }
  if (r.status === 403 || r.status === 429) fail('GitHub 暂时限制了查询次数，请过一会儿再试');
  if (!r.ok) fail(`查询最新版本失败（${r.status}）`);
  const d = await r.json();
  if (!isObj(d) || !d.tag_name) fail('GitHub 返回的版本信息无效');
  const asset = pickAsset(d.assets, env.kind);
  latest = {
    version: String(d.tag_name).replace(/^v/i, ''), tag: d.tag_name, name: d.name || d.tag_name, notes: String(d.body || ''), url: d.html_url, publishedAt: d.published_at,
    asset: asset && { name: asset.name, size: asset.size, url: asset.browser_download_url, sha256: /^sha256:([0-9a-f]{64})$/.exec(asset.digest || '')?.[1] || null },
  };
  conf.lastCheck = Date.now(); save();
  return state();
}

// 下载到 .part，边下边算 SHA-256，校验通过后改名
async function runDownload() {
  const a = latest?.asset;
  if (!a?.url) fail('这个版本没有可下载的 ' + (env.kind === 'portable' ? '免安装版' : '安装版') + ' 文件，请到发布页下载');
  const dir = env.downloadDir;
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, a.name), part = target + '.part';
  const ctl = new AbortController();
  download = { state: 'downloading', received: 0, total: a.size || 0, file: null, error: '', version: latest.version, ctl };
  const tick = (() => { let t = 0; return force => { const now = Date.now(); if (force || now - t > 200) { t = now; env.emit('update', { type: 'progress', ...state().download }); } }; })();
  try {
    const r = await env.fetch(a.url, { signal: ctl.signal, headers: { 'User-Agent': 'rwkit-desktop/' + env.version } });
    if (!r.ok || !r.body) fail(`下载失败（${r.status}）`);
    download.total = Number(r.headers.get('content-length')) || download.total;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    for await (const chunk of r.body) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
      download.received += chunk.length; tick();
    }
    await new Promise((res, rej) => out.end(err => (err ? rej(err) : res())));
    const got = hash.digest('hex');
    if (a.sha256 && got !== a.sha256) { fs.rmSync(part, { force: true }); fail('下载的文件校验失败（SHA-256 不一致），已删除，请重试'); }
    if (a.size && download.received !== a.size) { fs.rmSync(part, { force: true }); fail('下载的文件不完整，已删除，请重试'); }
    fs.rmSync(target, { force: true });
    fs.renameSync(part, target);
    Object.assign(download, { state: 'done', file: target, verified: !!a.sha256 });
    tick(true);
    return state();
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch {}
    Object.assign(download, { state: e.name === 'AbortError' ? 'cancelled' : 'failed', error: e.name === 'AbortError' ? '已取消' : String(e.message || e) });
    tick(true);
    throw e.name === 'AbortError' ? new UserError('已取消下载') : e;
  }
}

export async function handle(route, b = {}) {
  try {
    switch (route) {
      case 'up.state': return state();
      case 'up.check': return await check();
      case 'up.settings':
        if (typeof b.auto === 'boolean') conf.auto = b.auto;
        if (typeof b.skip === 'string') conf.skip = b.skip;
        save(); return state();
      // 启动时的自动检查：关闭了、或 20 小时内查过就不查
      case 'up.auto': {
        if (!conf.auto || env.kind === 'dev' || Date.now() - conf.lastCheck < 20 * 3600 * 1000) return { ...state(), skipped: true };
        return await check();
      }
      case 'up.download': if (download?.state === 'downloading') fail('正在下载'); return await runDownload();
      case 'up.cancel': download?.ctl?.abort(); return { ok: true };
    }
    fail('不认识的请求：' + route);
  } catch (e) {
    if (!(e instanceof UserError)) env.log(e.stack || String(e));
    return { ok: false, error: String(e.message || e) };
  }
}
export const downloadedFile = () => (download?.state === 'done' ? download.file : null);
