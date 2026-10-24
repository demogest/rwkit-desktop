// 创意工坊的发布规则：分类（扩展 / 角色 / 开局商店 / 副本）与服务器的各项限制。
// 数值与轮回战场创意工坊服务器（cloudflare/src/projects）一致；离线包导入不受这些限制，但发布或更新工坊作品时会被拒绝。

export const LIMITS = {
  name: 80, summary: 2000, changelog: 2000, tags: 12, tag: 24, deps: 12,
  artifacts: 32, artifactName: 100, bundleBytes: 4_000_000,
  worldbookEntries: 500, regexes: 200, scriptTrees: 100, folderScripts: 100, conflicts: 100, overrides: 300,
  coverBytes: 3 * 1024 * 1024,
};
export const COVER_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
import { findScenario, scenarioProblems, scenarioBookState } from './scenario.mjs';

const CHARACTER_KINDS = ['world_character', 'opening_character', 'opening_partner', 'heretic'];
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const len = s => String(s ?? '').trim().length;

// 标签与服务器同样规范化：NFKC、去空白、转小写、去重
export function normTags(tags) {
  const out = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    const v = String(t ?? '').normalize('NFKC').trim().toLocaleLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// 数据 artifact 里声明的 kind（world_character、store_catalog……）
export function dataKinds(pack) {
  const kinds = [];
  for (const a of pack?.bundle?.artifacts || []) {
    if (a?.kind !== 'data') continue;
    let c = a.content;
    if (a.format === 'text' && typeof c === 'string') { try { c = JSON.parse(c); } catch { continue; } }
    for (const v of Array.isArray(c) ? c : [c]) { const k = String(v?.kind || '').trim(); if (k && !kinds.includes(k)) kinds.push(k); }
  }
  return kinds;
}
// 作品的具体类型：与服务器 projectContentKind 相同
export function contentKind(pack) {
  const kinds = dataKinds(pack);
  if (pack?.project?.category === 'character') {
    const ck = kinds.filter(k => CHARACTER_KINDS.includes(k));
    return { kind: ck[0] || 'world_character', mixed: ck.length > 1 ? ck : null };
  }
  // 扩展：带副本数据是副本（优先），带开局商店目录是开局商店
  return { kind: kinds.includes('scenario') ? 'scenario' : kinds.includes('store_catalog') ? 'store_catalog' : 'extension', mixed: null };
}
// 界面上的四种分类：扩展 / 角色 / 开局商店 / 副本
export const displayCategory = (category, kind) => (category === 'character' ? 'character' : kind === 'scenario' ? 'scenario' : kind === 'store_catalog' ? 'store_catalog' : 'extension');

// 开局商店目录的空模板（与官方客户端生成的一致）
export function storeCatalogTemplate() {
  return { schema_version: 1, kind: 'store_catalog', catalog: { equipments: [], items: [], skills: [] } };
}

function scriptTreeIssues(a, out) {
  let c = a.content;
  if (a.format === 'text') { if (!String(c ?? '').trim()) out.push(`“${a.name}”脚本内容为空，工坊不接受`); return; }
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { return; } }
  const trees = Array.isArray(c) ? c : [c];
  if (trees.length > LIMITS.scriptTrees) out.push(`“${a.name}”有 ${trees.length} 个脚本，超过工坊上限 ${LIMITS.scriptTrees} 个`);
  for (const t of trees) {
    if (t?.type !== 'folder') continue;
    const list = Array.isArray(t.scripts) ? t.scripts : [];
    if (list.length > LIMITS.folderScripts) out.push(`“${a.name}”的脚本文件夹「${t.name}」有 ${list.length} 个脚本，超过工坊上限 ${LIMITS.folderScripts} 个`);
    if (list.some(x => x?.type === 'folder')) out.push(`“${a.name}”的脚本文件夹「${t.name}」里还有文件夹，工坊不支持嵌套文件夹`);
  }
}
function countOf(a, pick) {
  let c = a.content;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { return 0; } }
  return pick(c);
}
const regexCount = c => (Array.isArray(c) ? c.length : Array.isArray(c?.regexes) ? c.regexes.length : Array.isArray(c?.extensions?.regex_scripts) ? c.extensions.regex_scripts.length : c && (c.find_regex !== undefined || c.findRegex !== undefined) ? 1 : 0);
function overrideKey(r) {
  const t = r?.target || {};
  if (r?.kind === 'worldbook') return t.uid != null && String(t.uid).trim() ? `worldbook:uid:${t.uid}` : `worldbook:${t.worldbook || ''}:name:${t.name || ''}`;
  if (r?.kind === 'regex') return t.id ? `regex:id:${t.id}` : `regex:name:${t.name || ''}:find:${t.find_regex ?? t.findRegex ?? ''}`;
  return t.id ? `script:${t.scope}:id:${t.id}` : `script:${t.scope}:folder:${t.folder || ''}:name:${t.name || ''}`;
}

// 发布或更新工坊作品时会被服务器拒绝的地方。cover：{ type, size } 或 null（不检查封面）
export function publishIssues(pack, { cover = undefined } = {}) {
  const out = [];
  const p = pack?.project || {};
  if (!len(p.name)) out.push('项目名称为空，工坊不接受');
  else if (len(p.name) > LIMITS.name) out.push(`项目名称 ${len(p.name)} 个字，超过工坊上限 ${LIMITS.name} 个字`);
  if (len(p.summary) > LIMITS.summary) out.push(`项目简介 ${len(p.summary)} 个字，超过工坊上限 ${LIMITS.summary} 个字`);
  const tags = normTags(p.tags);
  if (tags.length > LIMITS.tags) out.push(`标签有 ${tags.length} 个，超过工坊上限 ${LIMITS.tags} 个`);
  const longTags = tags.filter(t => t.length > LIMITS.tag);
  if (longTags.length) out.push(`标签「${longTags.join('」「')}」超过工坊上限 ${LIMITS.tag} 个字`);
  const ck = contentKind(pack);
  if (ck.mixed) out.push(`角色作品同时包含多种角色用途（${ck.mixed.join('、')}），工坊不接受，一个作品只能选一种`);
  const arts = pack?.bundle?.artifacts || [];
  // 副本：数据要能通过工坊副本编辑器的检查，世界书要与数据一致
  const sc = findScenario(arts);
  if (sc) {
    const tag = `“${arts[sc.a].name}”`;
    for (const x of scenarioProblems(sc.data)) out.push(`${tag}副本：${x}`);
    const book = scenarioBookState(arts);
    if (book?.state === 'missing') out.push(`${tag}副本还没有生成世界书：在副本编辑器里保存一次即可`);
    if (book?.state === 'stale') out.push(`“${arts[book.w].name}”副本世界书与副本数据不一致：在副本编辑器里保存一次即可重新生成`);
  }
  for (const a of arts) {
    if (!a) continue;
    if (len(a.name) > LIMITS.artifactName) out.push(`“${a.name}”名称 ${len(a.name)} 个字，超过工坊上限 ${LIMITS.artifactName} 个字`);
    if (a.kind === 'regex') { const n = countOf(a, regexCount); if (n > LIMITS.regexes) out.push(`“${a.name}”有 ${n} 条正则，超过工坊上限 ${LIMITS.regexes} 条`); }
    if (a.kind === 'script') scriptTreeIssues(a, out);
    if (Array.isArray(a.original_conflicts) && a.original_conflicts.length > LIMITS.conflicts) out.push(`“${a.name}”的原版冲突声明有 ${a.original_conflicts.length} 条，超过工坊上限 ${LIMITS.conflicts} 条`);
  }
  const ov = Array.isArray(pack?.bundle?.resource_overrides) ? pack.bundle.resource_overrides : [];
  const seen = new Set();
  for (const [i, r] of ov.entries()) { const k = overrideKey(r); if (seen.has(k)) out.push(`第 ${i + 1} 条原版资源规则与前面的规则重复，工坊不接受`); seen.add(k); }
  const bundle = { schema_version: 1, artifacts: arts, ...(ov.length ? { resource_overrides: ov } : {}) };
  const bytes = Buffer.byteLength(JSON.stringify(bundle), 'utf8');
  if (bytes > LIMITS.bundleBytes) out.push(`内容 ${(bytes / 1048576).toFixed(2)} MB，超过工坊上传上限 4 MB（离线包仍可导入，上限 6 MB）`);
  if (cover !== undefined && cover) {
    if (!COVER_TYPES.includes(cover.type)) out.push('封面是 ' + cover.type + '，工坊封面只支持 PNG、JPEG、WebP');
    else if (cover.size > LIMITS.coverBytes) out.push(`封面 ${(cover.size / 1048576).toFixed(2)} MB，超过工坊上限 3 MB`);
  }
  return out;
}
