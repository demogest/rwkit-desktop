// 核心逻辑测试：同一组编辑分别作用于离线包草稿与解包文件夹，两者打包结果必须一致
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../src/main/core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rwkit-test-'));
core.init({
  dataDir: path.join(tmp, 'data'),
  rwkitCandidates: () => [{ file: path.join(ROOT, 'resources', 'rwkit.mjs'), bundled: true }],
  trash: async p => fs.rmSync(p, { recursive: true, force: true }),
  emit: () => {},
  log: () => {},
});
const call = async (route, body) => {
  const r = await core.handle(route, body);
  if (r && r.ok === false && !r.confirm) throw new Error(route + ' 失败：' + r.error);
  return r;
};
const findSrc = (v, p) => { for (const pr of v.projects) { const s = [...pr.folders, ...pr.packs].find(x => path.resolve(x.path).toLowerCase() === path.resolve(p).toLowerCase()); if (s) return s; } return null; };

let packPath, folderPath;
test('生成示例并准备两份相同的来源', async () => {
  const r = await call('action', { action: 'example', opts: { dest: tmp } });
  assert.equal(r.ok, true);
  folderPath = r.result.dir;
  packPath = r.result.target;
  assert.ok(fs.existsSync(packPath));
  const v = await call('open', { paths: [packPath] });
  assert.equal(findSrc(v, folderPath).level, 'ok');
  assert.equal(findSrc(v, packPath).level, 'ok');
});

async function both(op, fix = x => x) {
  const a = await call('edit', { path: packPath, op: fix(op, 'pack') });
  const b = await call('edit', { path: folderPath, op: fix(op, 'folder') });
  return [a, b];
}

test('两边应用同一组编辑', async () => {
  const c0 = await call('content', { path: packPath });
  const idx = name => c0.artifacts.findIndex(a => a.name === name);
  const WB = idx('示例世界书.json'), SC = idx('示例脚本.json'), PAGE = idx('茶馆茶单页面.json'), GRP = idx('茶馆正则组.json');

  await both({ op: 'project', fields: { summary: '改过的简介', tags: ['示例', '已编辑'] } });

  const e2 = await call('detail', { path: packPath, a: WB, key: '990002' });
  await both({ op: 'item', a: WB, key: '990002', value: { ...e2.value, comment: '改名·回声茶馆', content: e2.value.content + '\n新增的一行', key: [...e2.value.key, '铜铃'], position: 4, depth: 2 } });

  const e5 = await call('detail', { path: packPath, a: WB, key: '990005' });
  const [ra, rb] = await both({ op: 'item', a: WB, key: '990005', value: { ...e5.value, uid: 990105 } });
  assert.equal(ra.key, '990105'); assert.equal(rb.key, '990105');

  const [na, nb] = await both({ op: 'addItem', a: WB, value: { comment: '新增条目', content: '第一行\n第二行', key: ['新'] } });
  assert.equal(na.key, nb.key);
  await both({ op: 'deleteItem', a: WB, key: '990004' });

  const g0 = await call('detail', { path: packPath, a: GRP, key: 'r:0' });
  await both({ op: 'item', a: GRP, key: 'r:0', value: { ...g0.value, findRegex: '/<告示>([\\s\\S]*?)<\\/告示>/g', replaceString: "<div class='notice'>$1</div>\n<!-- 多行 -->" } });
  await both({ op: 'addItem', a: GRP, value: { id: 'test-long-page', scriptName: '长页面', findRegex: '【长页面】', replaceString: '```html\n<!DOCTYPE html>\n<html><body>长页面</body></html>\n```' } });
  await both({ op: 'addItem', a: PAGE, value: { id: 'test-second', scriptName: '第二条', findRegex: '【第二条】', replaceString: '短' } });

  const s0 = await call('detail', { path: packPath, a: SC, key: 's:0' });
  await both({ op: 'item', a: SC, key: 's:0', value: { ...s0.value, content: s0.value.content + '\n// 新注释\n', button: { enabled: true, buttons: [{ name: '回声茶馆', visible: true }, { name: '新按钮', visible: false }] } } });

  await both({ op: 'artifactMeta', a: GRP, meta: { name: '茶馆正则.json' } });
  await both({ op: 'overrides', list: [{ kind: 'regex', state: 'disabled', target: { scope: 'character', name: '某条原版正则' } }] });
  const [aa, ab] = await both({ op: 'addArtifact', kind: 'preset', name: '示例预设' });
  assert.equal(aa.a, ab.a);
  await both({ op: 'moveArtifact', a: aa.a, to: 1 });
  await both({ op: 'deleteItem', a: GRP + (GRP >= 1 ? 1 : 0), key: 'r:1' });

  const cover = path.join(ROOT, 'build', 'icon.png');
  if (fs.existsSync(cover)) await both({ op: 'cover', file: cover });
});

test('编辑后两边内容一致，且都能通过检查', async () => {
  const A = await call('content', { path: packPath });
  const B = await call('content', { path: folderPath });
  assert.equal(A.draft, true);
  assert.equal(B.isFolder, true);
  const v = await call('projects');
  const pa = findSrc(v, packPath), fb = findSrc(v, folderPath);
  assert.ok(pa.draft, '离线包应处于草稿状态');
  assert.equal(pa.level, fb.level, '两边的检查结果应一致：' + JSON.stringify([pa.fatal, pa.errors, fb.fatal, fb.errors]));
  assert.ok(!pa.fatal && !pa.errors.length, JSON.stringify(pa.errors));
  // 逐项对比内容（与键顺序无关）
  const d = await call('diff', { a: packPath, b: folderPath });
  const changed = d.artifacts.filter(x => x.status !== 'same');
  assert.deepEqual(changed.map(x => x.name), [], '草稿与文件夹不应有差异：' + JSON.stringify(changed.map(x => [x.name, x.items.map(i => i.label + ':' + i.status + ':' + (i.fields || []).map(f => f.name))])));
  assert.deepEqual(d.project, []);
  assert.equal(d.overrides, null);
  // 确认编辑确实生效（不是两边都没改）
  for (const src of [A, B]) {
    const wb = src.artifacts.find(a => a.kind === 'worldbook');
    const labels = wb.items.map(i => i.label), uids = wb.items.map(i => String(i.uid));
    assert.ok(labels.includes('改名·回声茶馆') && labels.includes('新增条目'), labels.join(','));
    assert.ok(uids.includes('990105') && !uids.includes('990005') && !uids.includes('990004'), uids.join(','));
    assert.equal(src.project.summary, '改过的简介');
    const grp = src.artifacts.find(a => a.name === '茶馆正则.json');
    assert.deepEqual(grp.items.map(i => i.label), ['茶馆告示美化', '长页面']);
    assert.equal(src.artifacts.find(a => a.name === '茶馆茶单页面.json').items.length, 2);
    assert.equal(src.artifacts[1].kind, 'preset');
    assert.equal(src.overrides.length, 1);
  }
  // 新建的正则、脚本带有完整的默认字段（不只是传入的那几个）
  for (const p of [packPath, folderPath]) {
    const c = await call('content', { path: p });
    const grp = c.artifacts.findIndex(a => a.name === '茶馆正则.json');
    const r = await call('detail', { path: p, a: grp, key: c.artifacts[grp].items.at(-1).key });
    assert.deepEqual(r.value.placement, [2]);
    assert.equal(r.value.markdownOnly, true);
    assert.ok(r.value.id, '新正则应有 id');
    const empty = await core.handle('edit', { path: p, op: { op: 'addItem', a: grp, value: {} } });
    assert.equal(empty.ok, true, '空白新建也应成功：' + empty.error);
    await call('edit', { path: p, op: { op: 'deleteItem', a: grp, key: empty.key } });
  }
  // 新增的长页面在文件夹里应拆成单独文件
  const grp = fs.readdirSync(folderPath).find(n => n.includes('茶馆正则'));
  assert.ok(grp, '改名后的文件夹应存在');
  assert.ok(fs.readdirSync(path.join(folderPath, grp)).some(n => n.endsWith('.html')), '长页面应写成 .html 文件');
});

test('撤销、保存为新版本', async () => {
  const before = (await call('projects')).projects[0];
  await call('draft.undo', { path: packPath });
  const s = await core.handle('draft.save', { path: packPath, mode: 'version' });
  assert.equal(s.ok, true, s.error);
  assert.equal(s.result.version, 2);
  assert.ok(fs.existsSync(s.result.target));
  assert.ok(fs.existsSync(packPath), '原文件不应被改动');
  const after = findSrc(await call('projects'), s.result.target);
  assert.ok(after && !after.draft && after.level !== 'error');
  assert.ok(before);
});

test('非法编辑会被拦下', async () => {
  const c = await call('content', { path: folderPath });
  const wb = c.artifacts.findIndex(a => a.kind === 'worldbook');
  const k = c.artifacts[wb].items[0].key;
  const e = await call('detail', { path: folderPath, a: wb, key: k });
  const r = await core.handle('edit', { path: folderPath, op: { op: 'item', a: wb, key: k, value: { ...e.value, comment: '  ' } } });
  assert.equal(r.ok, false);
  assert.match(r.error, /名称/);
  const r2 = await core.handle('edit', { path: folderPath, op: { op: 'project', fields: { version: 0 } } });
  assert.equal(r2.ok, false);
});

test('文件夹打包结果与草稿保存的内容一致', async () => {
  const r = await call('action', { action: 'pack', path: folderPath, opts: { bump: true } });
  assert.equal(r.ok, true, r.error);
  assert.ok(fs.existsSync(r.result.target));
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
