// 副本：数据检查与整理、生成的世界书（含条件真正执行的结果）、与数据是否一致、分类与项目操作
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarioTemplate, scenarioProblems, normalizeScenario, scenarioWorldbook, scenarioBookState, scenarioEntryPlan, bodyOf, isScenarioBook } from '../src/main/scenario.mjs';
import { contentKind, displayCategory, publishIssues } from '../src/main/limits.mjs';
import * as core from '../src/main/core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rwkit-scenario-'));
core.init({ dataDir: path.join(tmp, 'data'), rwkitCandidates: () => [{ file: path.join(ROOT, 'resources', 'rwkit.mjs'), bundled: true }], emit: () => {}, log: () => {}, trash: async p => fs.rmSync(p, { recursive: true, force: true }) });

const sample = () => ({
  ...scenarioTemplate(), world: '艾泽拉斯', time: '黑暗之门 25 年', tier: 'F~C', location: '洛丹伦',
  sections: [
    { title: '第一章', type: 'chapter', content: '斯坦索姆的抉择' },
    { title: '兽人', type: 'race', content: '绿皮肤的战士', keywords: '部落，兽族' },
    { title: '第一章外传', type: 'chapter', content: '外传' },
    { title: '洛丹伦', type: 'area', content: '人类王国', location: '东部王国-洛丹伦' },
    { title: '第二章', type: 'chapter', content: '北伐' },
  ],
});

// 按 SillyTavern 的方式执行条目里的 EJS（<%_ 代码 _%> 与普通文字），返回最终文字
const lodash = { get: (o, p, d) => { const v = String(p).split('.').reduce((x, k) => (x == null ? undefined : x[k]), o); return v === undefined ? d : v; } };
function render(content, stat) {
  let js = 'let __o = "";\n';
  for (const [i, part] of content.split(/<%_|_%>/).entries()) js += i % 2 ? part + '\n' : `__o += ${JSON.stringify(part)};\n`;
  return new Function('getMessageVar', '_', js + 'return __o;')(() => stat, lodash).trim();
}

test('检查：与工坊副本编辑器相同的规则', () => {
  assert.deepEqual(scenarioProblems(scenarioTemplate()), ['请填写世界名称']);
  assert.deepEqual(scenarioProblems(sample()), []);
  const bad = { ...sample(), laws: '<% x %>', sections: [{ title: '兽人', type: 'race', content: 'a' }, { title: '兽人', type: 'race', content: 'b' }, { title: '', type: 'force', content: '' }] };
  const p = scenarioProblems(bad);
  assert.ok(p.includes('世界法则不能包含 EJS 代码'));
  assert.ok(p.includes('资料名称不能重复：兽人'));
  assert.ok(p.includes('第 3 条资料需要名称与正文'));
  assert.ok(p.some(x => /至少需要一个章节/.test(x)));
  const many = { ...sample(), sections: Array.from({ length: 101 }, (_, i) => ({ title: '章' + i, type: 'chapter', content: 'x' })) };
  assert.ok(scenarioProblems(many).some(x => /“章节”有 101 条，超过顺序区间 101–200/.test(x)));
  assert.ok(scenarioProblems({ ...sample(), calendar: { 名称: '历', 月份天数: [30, 0], 闰年规则: '' } }).some(x => /自定义历法/.test(x)));
  assert.throws(() => normalizeScenario(scenarioTemplate()), /请填写世界名称/);
});

test('整理：当前阶段、故事线、开局事件；旧测试版的资料种类与字段', () => {
  const d = normalizeScenario({ ...sample(), sections: [{ title: '序章', type: 'macro', content: '开始', time: '清晨', condition: '一切的开端' }, { title: '部落', type: 'faction', content: '兽人' }, { title: '王城', type: 'near', content: '城' }, { title: '终章', type: 'chapter', content: '结束' }] });
  assert.equal(d.stage, '序章');
  assert.equal(d.story, '序章 -> 终章');
  assert.equal(d.next, '终章');
  assert.deepEqual(d.sections.map(r => r.type), ['chapter', 'race', 'area', 'chapter']);
  assert.equal(d.sections[0].content, '【时间参考】清晨\n开始\n【剧情参考】一切的开端');
  assert.deepEqual(Object.keys(d.initialEvents), ['序章', '终章']);
  assert.equal(d.initialEvents['序章'].状态, '进行中');
  assert.equal(d.initialEvents['终章'].时间, '序章之后');
  assert.equal(d.initialEvents['终章'].前因[0], '序章');
});

test('世界书：顺序区间、蓝灯常驻、绿灯关键词、副本标记', () => {
  const d = normalizeScenario(sample());
  const entries = Object.values(scenarioWorldbook(d).entries);
  assert.deepEqual(entries.map(e => [e.order, e.comment]), [
    [101, '[副本] 艾泽拉斯 · 第一章'], [102, '[副本] 艾泽拉斯 · 第一章外传'], [103, '[副本] 艾泽拉斯 · 第二章'], [201, '[副本] 艾泽拉斯 · 兽人'], [401, '[副本] 艾泽拉斯 · 洛丹伦'],
  ]);
  assert.deepEqual(entries.map(e => e.uid), [0, 1, 2, 3, 4]);
  assert.equal(entries[0].constant, true);
  assert.deepEqual(entries[0].key, []);
  assert.deepEqual(entries[3].key, ['兽人', '部落', '兽族']);
  assert.deepEqual(entries[4].key, ['洛丹伦', '东部王国-洛丹伦']);
  assert.ok(entries.every(e => e.position === 0 && e.extra.reincarnationWorkshop.scenario === true && e.extra.reincarnationWorkshop.scenarioWorld === '艾泽拉斯'));
  assert.equal(bodyOf(entries[3].content), '【种族资料】兽人\n绿皮肤的战士');
});

test('世界书的条件：只在这个副本里、主神空间外、副本结束前输出；章节按当前阶段亮起', () => {
  const d = normalizeScenario(sample());
  const e = Object.values(scenarioWorldbook(d).entries);
  const [ch1, ch1x, ch2, orc] = e;
  const at = (stage, extra = {}) => ({ 世界: { 名称: '艾泽拉斯', 因果轨道: { 当前阶段: stage } }, 系统状态: { 是否在主神空间: false }, ...extra });
  const shown = stat => e.filter(x => render(x.content, stat)).map(x => x.comment.replace('[副本] 艾泽拉斯 · ', ''));
  // 还没有阶段：第一章亮起
  assert.deepEqual(shown(at('')), ['第一章', '兽人', '洛丹伦']);
  assert.deepEqual(shown(at('待初始化')), ['第一章', '兽人', '洛丹伦']);
  // 完全相同的优先；其次是阶段里包含的最长章节名
  assert.deepEqual(shown(at('第一章外传')).slice(0, 1), ['第一章外传']);
  assert.deepEqual(shown(at('进入第二章：北上')).slice(0, 1), ['第二章']);
  assert.deepEqual(shown(at('第一章外传的结尾')).slice(0, 1), ['第一章外传']);
  // 别的世界、主神空间、副本结束：都不输出
  assert.deepEqual(shown({ ...at('第一章'), 世界: { 名称: '别的世界' } }), []);
  assert.deepEqual(shown(at('第一章', { 系统状态: { 是否在主神空间: true } })), []);
  assert.deepEqual(shown(at('已通关')), []);
  assert.equal(render(orc.content, at('第二章')), '【种族资料】兽人\n绿皮肤的战士');
  assert.equal(render(ch2.content, at('第二章')), '【原著章节】第二章\n北伐');
  assert.equal(render(ch1.content, at('第二章')), '');
  assert.equal(render(ch1x.content, at('第二章')), '');
});

test('多条条目一起执行（提示词模板的做法）时不会重复声明变量', () => {
  const d = normalizeScenario(sample());
  const all = Object.values(scenarioWorldbook(d).entries).map(e => e.content).join('\n');
  const stat = { 世界: { 名称: '艾泽拉斯', 因果轨道: { 当前阶段: '第二章' } }, 系统状态: { 是否在主神空间: false } };
  const out = render(all, stat);
  assert.match(out, /【原著章节】第二章\n北伐/);
  assert.match(out, /【种族资料】兽人/);
  assert.doesNotMatch(out, /【原著章节】第一章\n/);
});

test('世界书与数据是否一致：缺少、过期、一致；官方客户端格式也认得', () => {
  const d = normalizeScenario(sample());
  const data = { kind: 'data', format: 'json', name: 'a.scenario.json', content: d };
  assert.equal(scenarioBookState([data]).state, 'missing');
  const book = { kind: 'worldbook', format: 'json', name: 'a.scenario.worldbook.json', content: scenarioWorldbook(d) };
  assert.equal(scenarioBookState([book, data]).state, 'ok');
  assert.equal(scenarioBookState([book, { ...data, content: { ...d, sections: [...d.sections, { title: '第三章', type: 'chapter', content: '新' }] } }]).state, 'stale');
  // 官方客户端：条目是数组，字段名不同，条件写法不同，但名称、顺序、关键词与正文一样
  const official = { kind: 'worldbook', format: 'json', name: '作品.scenario.worldbook.json', content: { entries: scenarioEntryPlan(d).map(p => ({ name: p.name, enabled: true, strategy: { type: p.chapter ? 'constant' : 'selective', keys: p.keys }, position: { type: 'before_character_definition', role: 'system', order: p.order }, content: '<%_\nif (official) {\n_%>\n' + p.body + '\n<%_ } _%>', extra: { reincarnationWorkshop: { scenario: true, scenarioWorld: d.world } } })) } };
  assert.equal(isScenarioBook(official), true);
  assert.equal(scenarioBookState([official, data]).state, 'ok');
  // 变量直接声明在最外层的旧写法：内容一致也要重新生成
  const unscoped = { ...official, content: { entries: official.content.entries.map(e => ({ ...e, content: '<%_\nconst __rw = getMessageVar("stat_data") || {};\nif (x) {\n_%>\n' + bodyOf(e.content) + '\n<%_ } _%>' })) } };
  assert.deepEqual(scenarioBookState([unscoped, data]), { state: 'stale', reason: 'scope', a: 1, w: 0 });
  assert.equal(scenarioBookState([{ ...data, content: { ...d, world: '' } }]).state, 'invalid');
});

test('分类：副本优先于开局商店；发布检查带上副本的问题', () => {
  const d = normalizeScenario(sample());
  const pack = (arts, category = 'extension') => ({ project: { name: '副本作品', category }, bundle: { artifacts: arts } });
  const data = { kind: 'data', format: 'json', name: 'a.scenario.json', content: d }, store = { kind: 'data', format: 'json', name: 's.json', content: { kind: 'store_catalog', catalog: {} } };
  assert.equal(contentKind(pack([data, store])).kind, 'scenario');
  assert.equal(displayCategory('extension', 'scenario'), 'scenario');
  assert.equal(contentKind(pack([data], 'character')).kind, 'world_character');
  assert.deepEqual(publishIssues(pack([data])), ['“a.scenario.json”副本还没有生成世界书：在副本编辑器里保存一次即可']);
  assert.deepEqual(publishIssues(pack([{ ...data, content: { ...d, world: '' } }])), ['“a.scenario.json”副本：请填写世界名称']);
});

test('新建副本项目、在副本编辑器里保存：项目文件夹与离线包', async () => {
  const r = await core.handle('action', { action: 'new', opts: { name: '测试副本', category: 'scenario', dir: tmp } });
  assert.equal(r.ok, true, r.error);
  const dir = r.result.dir;
  let d = await core.handle('project', { path: dir });
  assert.equal(d.kind, 'scenario');
  assert.equal(d.hasScenario, true);
  assert.equal(d.project.category, 'extension');
  // 保存副本数据：生成世界书，检查通过
  const bad = await core.handle('edit', { path: dir, op: { op: 'scenario', a: 0, data: scenarioTemplate() } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /副本：请填写世界名称/);
  const ok = await core.handle('edit', { path: dir, op: { op: 'scenario', a: 0, data: sample() } });
  assert.equal(ok.ok, true, ok.error);
  let src = core.sourcePack(dir);
  assert.equal(src.pack.bundle.artifacts.length, 2);
  assert.equal(scenarioBookState(src.pack.bundle.artifacts).state, 'ok');
  assert.equal(src.pack.bundle.artifacts[0].content.stage, '第一章');
  // 再保存一次：世界书整个换掉（条目文件跟着变）
  const again = await core.handle('edit', { path: dir, op: { op: 'scenario', a: 0, data: { ...sample(), sections: sample().sections.slice(0, 2) } } });
  assert.equal(again.ok, true, again.error);
  src = core.sourcePack(dir);
  assert.equal(Object.keys(src.pack.bundle.artifacts[1].content.entries).length, 2);
  assert.equal(scenarioBookState(src.pack.bundle.artifacts).state, 'ok');
  // 离线包：写进草稿，世界书放在副本数据后面
  const R = core.rwkitModule();
  const pk = { format: R.OFFLINE_FORMAT || 'reincarnation-workshop-project', version: R.OFFLINE_VERSION || 1, exported_at: Date.now(), project: { id: 'sc-pack', name: '离线副本', category: 'extension', version: 1, dependencies: [], summary: '', tags: [] }, manifest: { schema_version: 1 }, bundle: { schema_version: 1, artifacts: [{ kind: 'data', format: 'json', name: '离线副本.scenario.json', content: scenarioTemplate() }], resource_overrides: [] } };
  R.rebuildManifest(pk, []);
  const file = path.join(tmp, '离线副本-v1.rwpack');
  R.writePack(pk, file, { backup: false });
  core.openPaths([file]);
  const e = await core.handle('edit', { path: file, op: { op: 'scenario', a: 0, data: sample() } });
  assert.equal(e.ok, true, e.error);
  const s2 = core.sourcePack(file);
  assert.equal(s2.draft, true);
  assert.deepEqual(s2.pack.bundle.artifacts.map(a => a.kind), ['data', 'worldbook']);
  assert.equal(scenarioBookState(s2.pack.bundle.artifacts).state, 'ok');
});
