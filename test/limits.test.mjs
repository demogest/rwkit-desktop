// 工坊分类与发布限制：与创意工坊服务器一致
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishIssues, contentKind, displayCategory, normTags, storeCatalogTemplate } from '../src/main/limits.mjs';
import * as core from '../src/main/core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rwkit-limits-'));
core.init({ dataDir: path.join(tmp, 'data'), rwkitCandidates: () => [{ file: path.join(ROOT, 'resources', 'rwkit.mjs'), bundled: true }], emit: () => {}, log: () => {} });

const pack = (project = {}, artifacts = [], extra = {}) => ({ project: { id: 'x', name: '作品', category: 'extension', version: 1, ...project }, bundle: { schema_version: 1, artifacts, ...extra } });
const wb = { kind: 'worldbook', format: 'json', name: '世界书.json', content: { entries: { 1: { comment: '条目', content: '…' } } } };

test('三种分类：扩展、角色（含用途）、开局商店', () => {
  assert.equal(contentKind(pack({}, [wb])).kind, 'extension');
  const store = pack({}, [wb, { kind: 'data', format: 'json', name: '店.json', content: storeCatalogTemplate() }]);
  assert.equal(contentKind(store).kind, 'store_catalog');
  assert.equal(displayCategory('extension', 'store_catalog'), 'store_catalog');
  assert.equal(contentKind(pack({ category: 'character' }, [wb])).kind, 'world_character');
  const partner = pack({ category: 'character' }, [{ kind: 'data', format: 'json', name: 'p.json', content: { kind: 'opening_partner' } }]);
  assert.equal(contentKind(partner).kind, 'opening_partner');
  assert.equal(displayCategory('character', 'opening_partner'), 'character');
});

test('名称、简介、标签超出上限', () => {
  const issues = publishIssues(pack({ name: '名'.repeat(81), summary: '字'.repeat(2001), tags: [...Array(13)].map((_, i) => 't' + i).concat(['长'.repeat(25)]) }, [wb]));
  assert.ok(issues.some(x => /名称 81 个字/.test(x)));
  assert.ok(issues.some(x => /简介 2001 个字，超过工坊上限 2000/.test(x)));
  assert.ok(issues.some(x => /标签有 14 个/.test(x)));
  assert.ok(issues.some(x => /超过工坊上限 24 个字/.test(x)));
  assert.deepEqual(publishIssues(pack({ summary: '字'.repeat(2000) }, [wb])), [], '正好 2000 字可以');
});

test('标签按服务器的方式规范化后再计数', () => {
  assert.deepEqual(normTags(['ＡＢＣ', 'abc', ' Abc ', '', '美化']), ['abc', '美化']);
});

test('artifact 名称、正则与脚本数量、嵌套文件夹、重复的原版资源规则、封面', () => {
  const regex = { kind: 'regex', format: 'json', name: 'r'.repeat(101), content: [...Array(201)].map(() => ({ find_regex: 'a', replace_string: 'b' })) };
  const script = { kind: 'script', format: 'json', name: '脚本.json', content: { type: 'folder', name: '夹', scripts: [{ type: 'folder', name: '内', scripts: [] }] } };
  const ov = [{ kind: 'worldbook', state: 'disabled', target: { uid: 1 } }, { kind: 'worldbook', state: 'enabled', target: { uid: 1 } }];
  const issues = publishIssues(pack({}, [regex, script], { resource_overrides: ov }), { cover: { type: 'image/gif', size: 10 } });
  assert.ok(issues.some(x => /名称 101 个字/.test(x)));
  assert.ok(issues.some(x => /201 条正则/.test(x)));
  assert.ok(issues.some(x => /不支持嵌套文件夹/.test(x)));
  assert.ok(issues.some(x => /第 2 条原版资源规则与前面的规则重复/.test(x)));
  assert.ok(issues.some(x => /只支持 PNG、JPEG、WebP/.test(x)));
});

test('角色作品不能同时有多种角色用途', () => {
  const p = pack({ category: 'character' }, [{ kind: 'data', format: 'json', name: 'a.json', content: [{ kind: 'opening_character' }, { kind: 'opening_partner' }] }]);
  assert.ok(publishIssues(p).some(x => /多种角色用途/.test(x)));
});

test('新建开局商店项目带空的开局商店目录；项目资料按工坊上限检查', async () => {
  const r = await core.handle('action', { action: 'new', opts: { name: '测试商店', category: 'store_catalog', dir: tmp } });
  assert.equal(r.ok, true, r.error);
  const v = await core.handle('projects');
  const p = v.projects.find(x => x.name === '测试商店');
  assert.equal(p.category, 'extension');
  assert.equal(p.kind, 'store_catalog');
  const bad = await core.handle('edit', { path: r.result.dir, op: { op: 'project', fields: { summary: '字'.repeat(2001) } } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /2000/);
});
