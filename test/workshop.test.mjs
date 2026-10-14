// 创意工坊模块测试：用内存里的假服务器代替网络，覆盖登录轮询、下载校验、上传内容与登录失效
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as core from '../src/main/core.mjs';
import * as ws from '../src/main/workshop.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rwkit-ws-test-'));
core.init({ dataDir: path.join(tmp, 'data'), rwkitCandidates: () => [{ file: path.join(ROOT, 'resources', 'rwkit.mjs'), bundled: true }], emit: () => {}, log: () => {} });

// ---------- 假服务器 ----------
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f1b2a90000000049454e44ae426082', 'hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const srv = { calls: [], exchangeTries: 0, token: 'tok-' + crypto.randomBytes(8).toString('hex'), projects: new Map(), uploads: [], patches: [], submits: [], meStatus: 200 };
const textOf = a => (a.format === 'text' ? a.content : JSON.stringify(a.content));
function manifestOf(p, bundle, version) {
  const artifacts = bundle.artifacts.map(a => ({ kind: a.kind, format: a.format, name: a.name, ...(a.kind === 'script' ? { scope: a.scope || 'character' } : {}), byte_size: Buffer.byteLength(textOf(a)), sha256: sha(textOf(a)) }));
  return { schema_version: 1, resource_overrides: bundle.resource_overrides || [], project: { id: p.id, slug: 'workshop-x', name: p.name, category: p.category, kind: 'extension', version, dependencies: [] }, artifact_count: artifacts.length, total_bytes: artifacts.reduce((s, a) => s + a.byte_size, 0), artifacts };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function fakeFetch(url, init = {}) {
  const u = new URL(url), method = init.method || 'GET', auth = init.headers?.Authorization;
  srv.calls.push(method + ' ' + u.pathname);
  const body = () => JSON.parse(Buffer.isBuffer(init.body) ? '{}' : init.body || '{}');
  const authed = () => auth === 'Bearer ' + srv.token;
  let m;
  if (u.pathname === '/api/auth/exchange') { srv.exchangeTries++; return srv.exchangeTries < 3 ? json({ error: 'Discord 登录尚未完成', code: 'login_pending' }, 409) : json({ token: srv.token, expires_at: Math.floor(Date.now() / 1000) + 3600 }); }
  if (u.pathname === '/api/auth/me') return authed() && srv.meStatus === 200 ? json({ user: { id: 1, discord_id: '42', username: 'tester', display_name: '测试作者', avatar: null } }) : json({ error: '登录状态已失效', code: 'unauthorized' }, 401);
  if (u.pathname === '/api/my/projects') return authed() && srv.meStatus === 200 ? json({ items: [] }) : json({ error: '登录状态已失效', code: 'unauthorized' }, 401);
  if ((m = /^\/api\/projects\/([^/]+)(?:\/([a-z-]+))?$/.exec(u.pathname))) {
    const [, id, sub] = m, p = srv.projects.get(id);
    if (!p) return json({ error: '已发布作品不存在', code: 'project_not_found' }, 404);
    if (!sub && method === 'GET') return json({ project: { id, name: p.name, summary: p.summary, tags: p.tags, dependencies: [], category: p.category, kind: 'extension', has_cover: true, version: p.version, owner_name: '作者', updated_at: 1 }, changelog: '', manifest: p.manifest || manifestOf({ ...p, id }, p.bundle, p.version), content_preview: { artifacts: [], worldbook_entries: [{ name: 'x', content: 'y'.repeat(1000) }] }, version_history: [] });
    if (sub === 'download') return json(p.bundle);
    if (sub === 'cover') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    if (!authed()) return json({ error: '登录状态已失效', code: 'unauthorized' }, 401);
    if (sub === 'edit') return json({ project: { id, name: p.name, summary: p.summary, tags: p.tags, dependencies: [], category: p.category, has_cover: true, status: 'published', latest_version: p.version, published_version: p.version }, latest: { version: p.version, changelog: '', review_status: 'approved', bundle: p.bundle } });
    if (sub === 'versions') { const b = body(); srv.uploads.push(b); p.version++; return json({ project_id: id, version: p.version, manifest: {}, auto_published: !!p.published }, 201); }
    if (sub === 'submit') { srv.submits.push(id); return json({ ok: true, auto_published: false }); }
    if (!sub && method === 'PATCH') { srv.patches.push(body()); return json({ ok: true }); }
  }
  return json({ error: '接口不存在', code: 'not_found' }, 404);
}
const enc = s => Buffer.from(s).toString('base64').split('').reverse().join('');
const dec = s => Buffer.from(s.split('').reverse().join(''), 'base64').toString();
ws.init({ dataDir: path.join(tmp, 'data'), defaultDownloads: tmp, appVersion: 'test', fetch: fakeFetch, encrypt: enc, decrypt: dec, emit: () => {}, log: () => {} });
const ok = async (route, body) => { const r = await ws.handle(route, body); if (r && r.ok === false) throw new Error(route + '：' + r.error); return r; };

let samplePack;
test('准备：生成示例离线包，并放到假服务器上', async () => {
  const r = await core.handle('action', { action: 'example', opts: { dest: tmp } });
  assert.equal(r.ok, true);
  samplePack = r.result.target;
  const pack = JSON.parse(fs.readFileSync(samplePack, 'utf8'));
  srv.projects.set('remote-1', { name: '远程作品', summary: '简介', tags: ['a'], category: 'extension', version: 3, bundle: pack.bundle, published: true });
});

test('Discord 登录：轮询到授权结果后保存加密的登录凭据', async () => {
  const r = await ok('ws.login');
  assert.match(r.url, /\/api\/auth\/discord\/start\?login_id=[0-9a-f]{64}$/);
  const w = await ok('ws.loginWait');
  assert.equal(w.user.name, '测试作者');
  assert.ok(srv.exchangeTries >= 3, '409 时应继续轮询');
  assert.equal(ws.state().user.name, '测试作者');
  const saved = fs.readFileSync(path.join(tmp, 'data', 'workshop.json'), 'utf8');
  assert.ok(!saved.includes(srv.token), '登录凭据不能明文保存');
});

test('下载：生成通过 rwkit 校验、带封面的离线包；再次下载判定为相同', async () => {
  const r = await ok('ws.download', { id: 'remote-1', dir: path.join(tmp, 'dl') });
  assert.ok(fs.existsSync(r.target));
  assert.match(path.basename(r.target), /^远程作品-v3\.rwpack$/);
  const pack = JSON.parse(fs.readFileSync(r.target, 'utf8'));
  core.rwkitModule().verifyManifest(pack);
  assert.equal(pack.project.id, 'remote-1');
  assert.equal(pack.project.version, 3);
  assert.match(pack.project.cover_url, /^data:image\/png;base64,/);
  const again = await ok('ws.download', { id: 'remote-1', dir: path.join(tmp, 'dl') });
  assert.equal(again.same, true);
});

test('下载：内容与清单不符时拒绝写入', async () => {
  const p = srv.projects.get('remote-1');
  srv.projects.set('bad-1', { ...p, name: '被篡改的作品', manifest: { ...manifestOf(p, p.bundle, p.version), project: { id: 'bad-1', version: p.version } , artifacts: manifestOf(p, p.bundle, p.version).artifacts.map((a, i) => (i ? a : { ...a, sha256: '0'.repeat(64) })) } });
  const r = await ws.handle('ws.download', { id: 'bad-1', dir: path.join(tmp, 'dl') });
  assert.equal(r.ok, false);
  assert.match(r.error, /SHA-256|校验/);
  assert.ok(!fs.existsSync(path.join(tmp, 'dl', '被篡改的作品-v3.rwpack')));
});

test('详情只保留名称等摘要，不带全部正文', async () => {
  const d = await ok('ws.detail', { id: 'remote-1' });
  assert.equal(d.preview.worldbook[0].name, 'x');
  assert.equal(d.preview.worldbook[0].content, undefined);
});

test('上传新版本：发送本地内容与更新说明，按需同步资料并提交审核', async () => {
  srv.projects.set('mine-1', { name: '我的作品', summary: '', tags: [], category: 'extension', version: 1, bundle: srv.projects.get('remote-1').bundle, published: false });
  const local = await ok('ws.local', { path: samplePack, id: 'mine-1' });
  assert.ok(local.size > 0 && local.size < local.limit);
  assert.ok(local.diff.some(x => x.key === 'name'), '名称不同应列为资料差异');
  const r = await ok('ws.upload', { id: 'mine-1', path: samplePack, changelog: '第二版', syncMeta: true, submit: true });
  assert.equal(r.version, 2);
  assert.equal(r.submitted, true);
  const sent = srv.uploads.at(-1);
  assert.equal(sent.changelog, '第二版');
  assert.equal(sent.bundle.schema_version, 1);
  assert.equal(sent.manifest, undefined);
  const pack = JSON.parse(fs.readFileSync(samplePack, 'utf8'));
  assert.deepEqual(sent.bundle.artifacts, pack.bundle.artifacts);
  assert.equal(srv.patches.at(-1).name, pack.project.name);
  assert.deepEqual(srv.submits, ['mine-1']);
  assert.equal(ws.state().links[pack.project.id], 'mine-1', '上传后记住本地项目与工坊作品的关联');
});

test('上传：有未保存的草稿时拒绝', async () => {
  await core.handle('edit', { path: samplePack, op: { op: 'project', fields: { summary: '改了一下' } } });
  const r = await ws.handle('ws.upload', { id: 'mine-1', path: samplePack, changelog: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /未保存/);
  await core.handle('draft.discard', { path: samplePack });
});

test('上传：超过工坊 4 MB 限制时在本地拦下', async () => {
  const R = core.rwkitModule();
  const pack = JSON.parse(fs.readFileSync(samplePack, 'utf8'));
  pack.project = { ...pack.project, id: 'big-local', name: '大作品' };
  pack.bundle.artifacts.push({ kind: 'data', format: 'text', name: '大数据', content: 'x'.repeat(4_200_000) });
  R.rebuildManifest(pack, []);
  const big = path.join(tmp, 'big.rwpack');
  R.writePack(pack, big, { backup: false });
  const r = await ws.handle('ws.upload', { id: 'mine-1', path: big, changelog: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /4 MB/);
});

test('登录失效（401）时清除保存的登录状态', async () => {
  srv.meStatus = 401;
  const r = await ws.handle('ws.mine');
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.equal(ws.state().user, null);
});
