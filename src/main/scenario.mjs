// 副本：创意工坊的副本数据（数据 artifact 里 kind 为 scenario 的对象）与由它生成的世界书。
// 格式与工坊一致：章节是蓝灯（按 MVU 里的“当前阶段”亮起），种族 / 势力 / 组织 / 冒险区域是绿灯（按关键词触发），全部放在角色定义之前；
// 开局时由工坊把世界名称、时间、地点、货币、阶段等写进 MVU。这里只依赖数据格式，不含工坊的代码。

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = v => String(v ?? '').trim();

// 资料种类：世界书顺序区间与标签（标签会写进条目正文的第一行）
export const SECTION_TYPES = {
  chapter: { label: '章节', light: '蓝灯', range: [101, 200], tag: '原著章节' },
  race: { label: '种族', light: '绿灯', range: [201, 299], tag: '种族资料' },
  force: { label: '势力', light: '绿灯', range: [302, 349], tag: '势力资料' },
  organization: { label: '组织', light: '绿灯', range: [352, 399], tag: '组织资料' },
  area: { label: '冒险区域', light: '绿灯', range: [401, 499], tag: '冒险区域' },
};
export const MAX_SECTIONS = 394;
export const MODES = { both: '多元副本与单一世界', multi: '仅多元副本', single: '仅单一世界' };
export const RANKS = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ'];
// 字段长度上限（字）
const MAX = { world: 80, time: 160, laws: 1200, location: 160, tier: 50, identity: 160, currencySystem: 1000, purchasing: 1500, fluctuation: 1500, calendarName: 80, calendarMonths: 160, calendarLeap: 160, title: 100, content: 16000, keywords: 1000, alias: 160 };
// 副本已经结束时的阶段名称：这时副本的世界书不再输出
const ENDED = ['已通关', '副本通关', '副本结束', '剧情完结', '已完结'];
// 旧测试版的资料种类
const LEGACY = { macro: 'chapter', event: 'chapter', always: 'chapter', faction: 'race', location: 'area', near: 'area' };
export const sectionType = t => (SECTION_TYPES[t] ? t : LEGACY[t] || 'chapter');
const KEY_SPLIT = /[,，、;；\n]+/u;

// 新建副本时的初始数据：世界名称留空，由作者填写
export function scenarioTemplate() {
  return {
    schema_version: 1, kind: 'scenario', world: '', time: '', stage: '', story: '', next: '', mode: 'both', laws: '', identity: '', calendar: null,
    rank: 'Ⅲ', tier: 'F~D', location: '', currency: { 体系: '', 购买力基准: '', 经济波动: '' },
    sections: [{ title: '第一章', type: 'chapter', content: '在这里写第一章：时间、地点、发生的事件与剧情走向。', keywords: '', location: '' }],
    initialEvents: {},
  };
}
export const isScenario = v => isObj(v) && v.kind === 'scenario';
// 包里的第一份副本数据：{ a: artifact 序号, data }
export function findScenario(artifacts = []) {
  for (let a = 0; a < artifacts.length; a++) {
    const x = artifacts[a];
    if (x?.kind !== 'data') continue;
    let c = x.content;
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch { continue; } }
    const hit = (Array.isArray(c) ? c : [c]).find(isScenario);
    if (hit) return { a, data: hit, array: Array.isArray(c) };
  }
  return null;
}

// ---------- 检查 ----------
// 返回所有问题（空数组表示可以发布）；与工坊副本编辑器保存时的检查一致
export function scenarioProblems(d) {
  const out = [];
  if (!isScenario(d)) return ['不是副本数据'];
  const field = (v, label, max) => {
    const s = str(v);
    if (s.length > max) out.push(`${label}超过 ${max} 字`);
    if (/<%/u.test(s)) out.push(`${label}不能包含 EJS 代码`);
    return s;
  };
  if (!field(d.world, '世界名称', MAX.world)) out.push('请填写世界名称');
  field(d.time, '开局时间', MAX.time); field(d.laws, '世界法则', MAX.laws); field(d.location, '初始地点', MAX.location);
  field(d.tier, '副本难度范围', MAX.tier); field(d.identity, '切入身份', MAX.identity);
  field(d.currency?.体系, '货币体系', MAX.currencySystem); field(d.currency?.购买力基准, '购买力基准', MAX.purchasing); field(d.currency?.经济波动, '经济波动', MAX.fluctuation);
  if (d.mode != null && d.mode !== '' && !MODES[d.mode]) out.push('适用开局模式无效');
  if (d.rank != null && d.rank !== '' && !RANKS.includes(d.rank)) out.push('世界位格应为 Ⅰ～Ⅸ');
  if (d.calendar != null) {
    const c = d.calendar;
    if (!isObj(c)) out.push('自定义历法格式不对');
    else {
      field(c.名称, '历法名称', MAX.calendarName); field(c.闰年规则, '闰年规则', MAX.calendarLeap);
      const days = c.月份天数;
      if (!str(c.名称) || !Array.isArray(days) || days.length < 1 || days.length > 24 || days.some(n => !Number.isInteger(n) || n < 1 || n > 99)) out.push('自定义历法需要填写名称与 1～24 个月的有效天数（每月 1～99 天）');
    }
  }
  const rows = d.sections;
  if (!Array.isArray(rows) || !rows.length) { out.push('请先添加第一章'); return out; }
  if (rows.length > MAX_SECTIONS) out.push(`副本资料最多 ${MAX_SECTIONS} 条（现在 ${rows.length} 条）`);
  const names = new Set(), counts = {};
  rows.forEach((r, i) => {
    const at = `第 ${i + 1} 条资料`;
    const type = sectionType(r?.type);
    const title = field(r?.title, at + '的名称', MAX.title), content = field(r?.content, at + '的正文', MAX.content);
    field(r?.keywords, at + '的关键词', MAX.keywords); field(r?.location ?? r?.match, at + '的区域别名', MAX.alias);
    if (!title || !content) out.push(at + '需要名称与正文');
    if (title && names.has(title)) out.push('资料名称不能重复：' + title);
    if (['__proto__', 'constructor', 'prototype'].includes(title)) out.push('请不要用保留的名称：' + title);
    names.add(title);
    counts[type] = (counts[type] || 0) + 1;
  });
  if (!rows.some(r => sectionType(r?.type) === 'chapter')) out.push('副本至少需要一个章节（第一章会成为开局时的当前阶段）');
  for (const [t, n] of Object.entries(counts)) {
    const [a, b] = SECTION_TYPES[t].range;
    if (n > b - a + 1) out.push(`“${SECTION_TYPES[t].label}”有 ${n} 条，超过顺序区间 ${a}–${b} 能放下的 ${b - a + 1} 条`);
  }
  return [...new Set(out)];
}

// ---------- 整理：算出当前阶段、故事线与开局事件 ----------
const chaptersOf = sections => sections.filter(r => r.type === 'chapter');
function initialEvents(d, max = 5) {
  const ch = chaptersOf(d.sections).slice(0, max), out = {};
  ch.forEach((c, i) => {
    const prev = ch[i - 1]?.title || '';
    out[c.title] = {
      分类: '宏观节点', 状态: i === 0 ? '进行中' : '待发生', 描述: c.content.slice(0, 140), 时间: i === 0 ? d.time || '' : prev + '之后',
      条件: prev ? '上一章节推进到此处' : '按当前剧情自然发展', 前因: prev ? [prev] : [], 默认走向: c.content.slice(0, 200),
      结果: '', 公开征兆: '', 地点: '', 参与者: [], 关联任务: [], 可见影响: [],
    };
  });
  return out;
}
// 检查通过后整理成保存的形式；有问题时抛出第一个问题
export function normalizeScenario(d) {
  const problems = scenarioProblems(d);
  if (problems.length) throw new Error(problems[0] + (problems.length > 1 ? `（还有 ${problems.length - 1} 处问题）` : ''));
  const sections = d.sections.map(r => {
    let content = str(r.content);
    // 旧测试版的章节把时间与条件分开写：并进正文，不丢失作者写过的内容
    if (r.type === 'macro' || r.type === 'event') {
      const t = str(r.time), c = str(r.condition);
      if (t && !content.includes(t)) content = '【时间参考】' + t + '\n' + content;
      if (c && !content.includes(c)) content += '\n【剧情参考】' + c;
    }
    return { title: str(r.title), type: sectionType(r.type), content, keywords: str(r.keywords), location: str(r.location ?? r.match) };
  });
  const names = chaptersOf(sections).map(r => r.title);
  const calendar = isObj(d.calendar) && str(d.calendar.名称) ? { 名称: str(d.calendar.名称), 月份天数: d.calendar.月份天数.slice(), 闰年规则: str(d.calendar.闰年规则) } : null;
  const out = {
    ...d, schema_version: 1, kind: 'scenario', world: str(d.world), time: str(d.time), stage: names[0], story: names.join(' -> '), next: names[1] || '',
    mode: MODES[d.mode] ? d.mode : 'both', laws: str(d.laws), identity: str(d.identity), calendar, rank: RANKS.includes(d.rank) ? d.rank : 'Ⅲ', tier: str(d.tier) || 'F~D',
    location: str(d.location), currency: { 体系: str(d.currency?.体系), 购买力基准: str(d.currency?.购买力基准), 经济波动: str(d.currency?.经济波动) }, sections,
  };
  out.initialEvents = initialEvents(out);
  return out;
}

// ---------- 生成世界书（SillyTavern 格式，工坊安装时会转换） ----------
const q = s => JSON.stringify(s);
// 共同条件：MVU 里的世界是这个副本、不在主神空间、副本还没结束
function guardOf(world) {
  return `String(__w.名称 || '') === ${q(world)} && _.get(__rw, '系统状态.是否在主神空间', false) !== true && !${q(ENDED)}.includes(__stage)`;
}
// 章节：当前阶段与章节名完全相同的优先，其次是阶段里包含的最长章节名；还没有阶段时是第一章
function chapterOn(title, names) {
  return `(() => { const __t = ${q(names)}; const __on = __t.includes(__stage) ? __stage : (__t.filter(n => __stage.includes(n)).sort((a, b) => b.length - a.length)[0] || (!__stage || __stage === '待初始化' ? __t[0] : '')); return __on === ${q(title)}; })()`;
}
// 提示词模板会把同时出现的条目放在一起执行：每条的变量放在自己的 { } 里，避免重复声明
const wrap = (cond, body) => [
  '<%_ {',
  "const __rw = getMessageVar('stat_data', { defaults: {} }) || {};",
  "const __w = _.get(__rw, '世界', {});",
  "const __stage = String(_.get(__w, '因果轨道.当前阶段', '') || '').trim();",
  `if (${cond}) {`,
  '_%>',
  body,
  '<%_ } } _%>',
].join('\n');
// 条目正文去掉外层的条件，只留可见内容（比较是否需要重新生成时用，与生成方式无关）
export const bodyOf = content => String(content ?? '').replace(/^<%_[\s\S]*?_%>\n/, '').replace(/\n<%_ }( })? _%>\s*$/, '');
function keywordsOf(r) {
  const all = [r.title, ...(r.type === 'area' && r.location ? [r.location] : []), ...String(r.keywords || '').split(KEY_SPLIT)];
  return [...new Set(all.map(str).filter(Boolean))].slice(0, 32);
}
// 每条资料对应的条目要点：名称、顺序、关键词、可见正文
export function scenarioEntryPlan(d) {
  const names = chaptersOf(d.sections).map(r => r.title), used = {}, out = [];
  for (const r of d.sections) {
    const t = SECTION_TYPES[r.type];
    const order = t.range[0] + (used[r.type] = (used[r.type] ?? -1) + 1);
    out.push({ name: `[副本] ${d.world} · ${r.title}`, order, chapter: r.type === 'chapter', keys: r.type === 'chapter' ? [] : keywordsOf(r), body: `【${t.tag}】${r.title}\n${r.content}`, title: r.title });
  }
  return out.sort((a, b) => a.order - b.order);
}
export function scenarioWorldbook(d) {
  const entries = {};
  scenarioEntryPlan(d).forEach((p, uid) => {
    const cond = guardOf(d.world) + (p.chapter ? ' && ' + chapterOn(p.title, chaptersOf(d.sections).map(r => r.title)) : '');
    const ext = { position: 0, exclude_recursion: true, prevent_recursion: true, delay_until_recursion: false, display_index: uid, probability: 100, useProbability: true, depth: 4, selectiveLogic: 0, group: '', group_override: false, group_weight: 100, scan_depth: null, case_sensitive: null, match_whole_words: null, use_group_scoring: false, automation_id: '', role: 0, vectorized: false, sticky: 0, cooldown: 0, delay: 0 };
    entries[uid] = {
      uid, key: p.keys, keysecondary: [], comment: p.name, content: wrap(cond, p.body), constant: p.chapter, vectorized: false, selective: !p.chapter, selectiveLogic: 0, addMemo: true,
      order: p.order, position: 0, disable: false, excludeRecursion: true, preventRecursion: true, delayUntilRecursion: false, probability: 100, useProbability: true, depth: 4,
      group: '', groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: false, automationId: '', role: 0,
      sticky: 0, cooldown: 0, delay: 0, displayIndex: uid, extensions: ext,
      extra: { reincarnationWorkshop: { scenario: true, scenarioWorld: d.world } },
    };
  });
  return { entries };
}
// 旧写法：变量直接声明在最外层（没有包在 { } 里）
const UNSCOPED = /^<%_\s*\n\s*const\s+__rw\b/;
// 副本世界书：条目带有工坊的副本标记，或者名称是 *.scenario.worldbook.json
const entriesOf = c => { if (typeof c === 'string') { try { c = JSON.parse(c); } catch { return []; } } const e = Array.isArray(c) ? c : c?.entries; return Array.isArray(e) ? e : isObj(e) ? Object.values(e) : []; };
const marked = e => e?.extra?.reincarnationWorkshop?.scenario === true;
export const isScenarioBook = a => a?.kind === 'worldbook' && (/\.scenario\.worldbook\.json$/i.test(a.name || '') || entriesOf(a.content).some(marked));
export const scenarioBookName = base => String(base || '副本').replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').slice(0, 65) + '.scenario.worldbook.json';

// 副本世界书是否与数据一致：missing（还没有）、stale（数据改过、需要重新生成）、ok；数据本身有问题时为 invalid
// 比较名称、顺序、关键词与可见正文，与世界书的格式（SillyTavern 或工坊的格式）无关
export function scenarioBookState(artifacts = []) {
  const s = findScenario(artifacts);
  if (!s) return null;
  let d;
  try { d = normalizeScenario(s.data); } catch { return { state: 'invalid', a: s.a }; }
  const w = artifacts.findIndex(isScenarioBook);
  if (w < 0) return { state: 'missing', a: s.a };
  const have = entriesOf(artifacts[w].content).filter(e => marked(e) || /^\[副本\]/.test(e?.comment ?? e?.name ?? '')).map(e => JSON.stringify([
    String(e.comment ?? e.name ?? ''), Number(e.order ?? e.position?.order), [...(Array.isArray(e.key) ? e.key : e.strategy?.keys || [])].sort(), bodyOf(e.content),
  ])).sort();
  const want = scenarioEntryPlan(d).map(p => JSON.stringify([p.name, p.order, [...p.keys].sort(), p.body])).sort();
  if (JSON.stringify(have) !== JSON.stringify(want)) return { state: 'stale', a: s.a, w };
  // 旧的写法（rwkit 1.2.1 与工坊客户端）：变量直接声明在最外层，多条条目同时出现时提示词模板会报“重复声明”
  if (entriesOf(artifacts[w].content).some(e => marked(e) && UNSCOPED.test(String(e.content || '')))) return { state: 'stale', reason: 'scope', a: s.a, w };
  return { state: 'ok', a: s.a, w };
}
