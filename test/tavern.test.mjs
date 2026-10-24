// 安装到 SillyTavern：在模拟的 SillyTavern 页面里运行真正的“rwkit 安装桥”脚本，连到本机桥接服务，
// 用假的创意工坊（与 window.ReincarnationWorkshop 同样的接口）检查导入、安装检查、安装、覆盖安装、卸载与各种失败
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import * as core from '../src/main/core.mjs';
import * as tavern from '../src/main/tavern.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rwkit-st-test-'));
core.init({ dataDir: path.join(tmp, 'data'), rwkitCandidates: () => [{ file: path.join(ROOT, 'resources', 'rwkit.mjs'), bundled: true }], emit: () => {}, log: () => {} });
tavern.init({ dataDir: path.join(tmp, 'data'), log: () => {}, emit: () => {}, timeouts: { hold: 300, alive: 1500, deliver: 1500, run: 8000 } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return false; }

// 假的创意工坊：接口与 window.ReincarnationWorkshop 相同，导入时按工坊的规则校验离线包
const toasts = [];
const ws = {
  version: '2.0.66', records: new Map(), calls: [], blocking: [],
  async listInstalled() { return [...this.records.values()].map(r => ({ ...r, bundle: r.pack.bundle })); },
  async importProject(file) {
    this.calls.push('import');
    const p = JSON.parse(await file.text());
    core.rwkitModule().verifyManifest(p);
    const prev = this.records.get(p.project.id);
    if (prev?.applied) throw new Error('这个作品已经安装到酒馆，请先卸载后再导入离线包');
    if (prev && prev.version > p.project.version) throw new Error(`本地已有更高版本 v${prev.version}，不会被较旧离线包覆盖`);
    this.records.set(p.project.id, { id: p.project.id, name: p.project.name, version: p.project.version, applied: false, appliedVersion: null, targetCharacterName: null, source: 'offline', pack: p, fileName: file.name });
  },
  async preflightProject() { this.calls.push('preflight'); return { blocking: this.blocking, warnings: [{ message: '提示一下' }] }; },
  async applyProject(id) { this.calls.push('apply'); const r = this.records.get(id); Object.assign(r, { applied: true, appliedVersion: r.version, targetCharacterName: '轮回战场', restoreWarnings: ['<img src=x>'] }); return r; },
  async uninstallProject(id) { this.calls.push('uninstall'); const r = this.records.get(id); if (r) Object.assign(r, { applied: false, appliedVersion: null }); },
  async refresh() {},
};
function runBridge(content) {
  const page = { ReincarnationWorkshop: ws, toastr: { success: m => toasts.push('ok:' + m), error: m => toasts.push('err:' + m) }, location: { origin: 'http://127.0.0.1:8000' }, document: {}, TavernHelper: { getCurrentCharacterName: () => '轮回战场' } };
  page.parent = page;
  const listeners = {};
  const win = { parent: page, addEventListener: (t, fn) => { listeners[t] = fn; } };
  vm.runInContext(content, vm.createContext({ window: win, fetch, File, AbortController, setTimeout, clearTimeout, console }));
  return () => listeners.pagehide?.();
}
const call = async (route, body) => tavern.handle(route, body);
// 让系统挑一个空闲端口（Windows 会保留一些随机端口段，随便选可能被占用）
const port = await new Promise(res => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); }); });

let samplePack, stopBridge;
test('准备：示例离线包、启动桥接服务、运行安装桥脚本', async () => {
  const r = await core.handle('action', { action: 'example', opts: { dest: tmp } });
  samplePack = r.result.target;
  await call('st.port', { port });
  const st = await call('st.enable', { enabled: true });
  assert.equal(st.running, true, st.error);
  const { content, json } = tavern.bridgeScript();
  assert.match(content, new RegExp(`127\\.0\\.0\\.1:${port}`));
  assert.equal(json.type, 'script');
  assert.equal(json.content, content);
  stopBridge = runBridge(content);
  assert.ok(await until(() => tavern.state().connected && tavern.state().client?.character === '轮回战场'), '安装桥应连上并报告当前角色');
  assert.equal(tavern.state().client.workshop, '2.0.66');
});

async function install(body) {
  const r = await call('st.install', { path: samplePack, ...body });
  assert.equal(r.ok, true, r.error);
  return (await call('st.wait', { id: r.job.id })).job;
}

test('安装：导入 → 安装检查 → 安装，结果带回提示', async () => {
  const j = await install({});
  assert.equal(j.state, 'done', j.result?.error);
  assert.deepEqual(ws.calls, ['import', 'preflight', 'apply']);
  const pack = JSON.parse(fs.readFileSync(samplePack, 'utf8'));
  const rec = ws.records.get(pack.project.id);
  assert.equal(rec.applied, true);
  assert.match(rec.fileName, /-v1\.rwpack$/);
  assert.deepEqual(j.result.warnings, ['提示一下']);
  assert.equal(j.result.record.targetCharacterName, '轮回战场');
  assert.ok(await until(() => toasts.some(t => t.startsWith('ok:已安装'))), 'SillyTavern 里应提示安装成功');
});

test('已安装时：不确认就不覆盖；确认后先卸载再安装', async () => {
  ws.calls = [];
  const a = await install({});
  assert.equal(a.state, 'failed');
  assert.equal(a.result.code, 'installed');
  assert.deepEqual(ws.calls, []);
  const b = await install({ replace: true });
  assert.equal(b.state, 'done', b.result?.error);
  assert.deepEqual(ws.calls, ['uninstall', 'import', 'preflight', 'apply']);
});

test('安装检查不通过时报告原因', async () => {
  ws.blocking = [{ type: 'missing_dependency', message: '缺少依赖“回声茶馆”' }];
  const j = await install({ replace: true });
  ws.blocking = [];
  assert.equal(j.state, 'failed');
  assert.equal(j.result.code, 'blocked');
  assert.match(j.result.error, /缺少依赖“回声茶馆”/);
});

test('卸载', async () => {
  await install({});
  ws.calls = [];
  const pack = JSON.parse(fs.readFileSync(samplePack, 'utf8'));
  const r = await call('st.uninstall', { projectId: pack.project.id, name: pack.project.name });
  const j = (await call('st.wait', { id: r.job.id })).job;
  assert.equal(j.state, 'done', j.result?.error);
  assert.deepEqual(ws.calls, ['uninstall']);
  assert.equal(ws.records.get(pack.project.id).applied, false);
});

test('有未保存的草稿时不安装', async () => {
  await core.handle('edit', { path: samplePack, op: { op: 'project', fields: { summary: '草稿' } } });
  const r = await call('st.install', { path: samplePack });
  await core.handle('draft.discard', { path: samplePack });
  assert.equal(r.ok, false);
  assert.match(r.error, /未保存/);
});

test('不带配对码的请求一律拒绝（网页无法探测本机是否开着 rwkit）', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/rwkit/ping`);
  assert.equal(r.status, 401);
});

test('页面报回的安装记录只保留需要的字段', async () => {
  const j = await install({ replace: true });
  assert.equal(j.state, 'done', j.result?.error);
  assert.deepEqual(Object.keys(j.result.record).sort(), ['appliedVersion', 'restoreWarnings', 'targetCharacterName']);
  assert.equal(typeof j.result.record.restoreWarnings, 'number');
});

test('配对码不对时，安装桥提示重新复制脚本', async () => {
  const { content } = tavern.bridgeScript();
  const stop = runBridge(content.replace(/const TOKEN = '[0-9a-f]+'/, `const TOKEN = '${'0'.repeat(48)}'`));
  assert.ok(await until(() => toasts.some(t => t.includes('配对码不正确'))));
  stop();
});

test('SillyTavern 没有连接时，任务超时并说明原因', async () => {
  stopBridge();
  assert.ok(await until(() => !tavern.state().connected, 4000), '停止后应显示未连接');
  const j = await install({});
  assert.equal(j.state, 'failed');
  assert.equal(j.result.code, 'not_connected');
  await call('st.enable', { enabled: false });
});
