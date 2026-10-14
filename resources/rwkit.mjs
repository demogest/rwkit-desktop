#!/usr/bin/env node
// rwkit：轮回战场创意工坊离线包（.rwpack）工具包——修复、检查、解包、打包、生成示例
// 校验口径与工坊导入（offline.js / integrity.js）和安装（installer/plan.js）一致。
// 需要 Node.js 18 及以上，无第三方依赖。用法见 usage()，或运行 node rwkit.mjs help。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import zlib from 'node:zlib';

const OFFLINE_FORMAT = 'reincarnation-workshop-project';
const OFFLINE_VERSION = 1;
const MAX_OFFLINE_BYTES = 6 * 1024 * 1024;
const MAX_ARTIFACTS = 32;
const ALLOWED_KINDS = new Set(['worldbook', 'regex', 'preset', 'script', 'data']);
const ALLOWED_FORMATS = new Set(['json', 'text']);
const SCRIPT_SCOPES = ['character', 'preset', 'global'];
const KIND_LABEL = { worldbook: '世界书', regex: '正则', script: '脚本', preset: '预设', data: '数据' };
// 轮回战场原版与常见扩展里作用于 AI 输出显示的正则：本包页面源码里若出现这些文字，会被它们二次替换
const HOST_DISPLAY_REGEX = [
  ['原版·封面', /【封面】/], ['原版·开局', /【开局】/], ['原版·选择世界美化', /<mission>[\s\S]*?<\/mission>/i],
  ['原版·主神任务美化', /<god quest>[\s\S]*?<\/god quest>/i], ['原版·试炼任务美化', /<trial quest>[\s\S]*?<\/trial quest>/i],
  ['原版·结算任务美化', /<settlement tasks>[\s\S]*?<\/settlement tasks>/i], ['原版·变量折叠', /<update(?:variable)?>[\s\S]*<\/update(?:variable)?>/i],
  ['原版·选项', /<options>[\s\S]*?<\/options>/], ['原版·检定美化', /<(?:Check|Craft|Combat)Result>[\s\S]*?<\/(?:Check|Craft|Combat)Result>/i],
  ['原版·隐藏思维链', /<dm_think>[\s\S]*?<\/dm_think>/], ['原版·隐藏状态栏', /<StatusPlaceHolderImpl\/>/],
];
// 解包文件夹里的引用标记：打包时换回原内容
const MARK_KEYS = new Set(['$file', '$image', '$entries', '$artifacts', '$literal']);
const CONTENT_MARK = '（正文在下方分隔线之后）';
const AUTO_NOTE = '（打包时自动生成）';
const MANIFEST_AUTO = new Set(['resource_overrides', 'artifact_count', 'total_bytes', 'artifacts']);
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' };
const ARTIFACTS_SLOT = Symbol('artifacts');

// ---------- 小工具 ----------
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const sha256 = text => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const bytes = text => Buffer.byteLength(text, 'utf8');
const contentText = a => (a.format === 'text' ? a.content : JSON.stringify(a.content));
const clone = v => JSON.parse(JSON.stringify(v));
const collate = (a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true });
class PackError extends Error {}
const fail = msg => { throw new PackError(msg); };

function safeName(value, max = 48) {
  const s = String(value ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, max).replace(/[. ]+$/, '');
  return s || '未命名';
}
function readText(file) {
  const t = fs.readFileSync(file, 'utf8');
  return t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t;
}
function lineCol(text, pos) {
  const before = text.slice(0, pos), line = before.split('\n').length, col = pos - before.lastIndexOf('\n');
  const start = Math.max(0, pos - 60), end = Math.min(text.length, pos + 60);
  return { line, col, snippet: text.slice(start, end).replace(/\s+/g, ' ') };
}
// 自己扫一遍 JSON，找出第一处语法错误的位置（Node 的部分报错不带位置）
function scanJsonError(t) {
  let i = 0;
  const ws = () => { while (i < t.length && ' \t\n\r'.includes(t[i])) i++; };
  const bad = () => { throw i; };
  const str = () => { if (t[i] !== '"') bad(); i++; while (i < t.length) { const c = t[i]; if (c === '"') { i++; return; } if (c === '\\') { i += 2; continue; } if (c < ' ') bad(); i++; } bad(); };
  const lit = w => { if (t.startsWith(w, i)) i += w.length; else bad(); };
  const num = () => { const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(t.slice(i, i + 64)); if (!m) bad(); i += m[0].length; };
  const val = () => {
    ws(); const c = t[i];
    if (c === '{') { i++; ws(); if (t[i] === '}') { i++; return; } for (;;) { ws(); str(); ws(); if (t[i] !== ':') bad(); i++; val(); ws(); if (t[i] === ',') { i++; continue; } if (t[i] === '}') { i++; return; } bad(); } }
    if (c === '[') { i++; ws(); if (t[i] === ']') { i++; return; } for (;;) { val(); ws(); if (t[i] === ',') { i++; continue; } if (t[i] === ']') { i++; return; } bad(); } }
    if (c === '"') return str();
    if (c === 't') return lit('true'); if (c === 'f') return lit('false'); if (c === 'n') return lit('null');
    return num();
  };
  try { val(); ws(); if (i < t.length) bad(); return null; } catch (pos) { return typeof pos === 'number' ? Math.min(pos, t.length - 1) : null; }
}
function errorPos(e, text) {
  const m = String(e.message).match(/position (\d+)/) || String(e.message).match(/line (\d+) column (\d+)/);
  if (!m) return scanJsonError(text);
  if (m.length === 2) return Number(m[1]);
  const lines = text.split('\n'); let pos = 0;
  for (let i = 0; i < Number(m[1]) - 1 && i < lines.length; i++) pos += lines[i].length + 1;
  return pos + Number(m[2]) - 1;
}
// 去掉对象/数组结尾多余的逗号（只在字符串之外处理）
function stripTrailingCommas(text) {
  let out = '', inStr = false, esc = false, removed = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ',') { let j = i + 1; while (j < text.length && /\s/.test(text[j])) j++; if (text[j] === '}' || text[j] === ']') { removed++; continue; } }
    out += c;
  }
  return { text: out, removed };
}
// 宽松解析：去 BOM、删结尾多余逗号；写坏时报出第几行第几列与附近原文
function parseLoose(text, label, notes, lineOffset = 0) {
  const pre = label ? label + '：' : '';
  if (text.charCodeAt(0) === 0xFEFF) { text = text.slice(1); notes?.push(pre + '去掉了文件开头的 BOM'); }
  try { return JSON.parse(text); } catch (e) {
    const fixed = stripTrailingCommas(text);
    if (fixed.removed) { try { const v = JSON.parse(fixed.text); notes?.push(pre + '删除了 ' + fixed.removed + ' 处多余的结尾逗号'); return v; } catch (_) {} }
    const pos = errorPos(e, text);
    const where = pos == null ? '' : (() => { const lc = lineCol(text, pos); return '（第 ' + (lc.line + lineOffset) + ' 行第 ' + lc.col + ' 列附近：…' + lc.snippet + '…）'; })();
    fail((label ? label + ' ' : '') + '不是有效的 JSON：' + String(e.message).replace(/\s+/g, ' ') + where);
  }
}
function toRegExp(src) {
  const m = String(src).match(/^\/([\s\S]*)\/([dgimsuvy]*)$/);
  return m ? new RegExp(m[1], m[2]) : new RegExp(String(src));
}

// ---------- 导入校验（与工坊 offline.js / integrity.js 同一口径） ----------
function validateProject(project) {
  if (!isObj(project)) fail('缺少 project 项目资料');
  if (typeof project.id !== 'string' || !project.id) fail('project.id 无效');
  if (typeof project.name !== 'string') fail('project.name 无效');
  if (project.category !== 'character' && project.category !== 'extension') fail('project.category 只能是 extension 或 character');
  if (!Number.isInteger(Number(project.version)) || Number(project.version) < 1) fail('project.version 必须是不小于 1 的整数');
  if (project.dependencies !== undefined) {
    if (!Array.isArray(project.dependencies) || project.dependencies.length > 12) fail('project.dependencies 无效（最多 12 个）');
    for (const d of project.dependencies) if (!isObj(d) || typeof d.project_id !== 'string' || !d.project_id || !Number.isInteger(Number(d.min_version)) || Number(d.min_version) < 1) fail('project.dependencies 里有无效依赖');
  }
}
function validateBundle(bundle) {
  if (!isObj(bundle) || bundle.schema_version !== 1) fail('bundle 结构无效（schema_version 应为 1）');
  if (!Array.isArray(bundle.artifacts) || !bundle.artifacts.length || bundle.artifacts.length > MAX_ARTIFACTS) fail('bundle.artifacts 数量无效（1~' + MAX_ARTIFACTS + ' 个）');
  if (bundle.resource_overrides !== undefined) {
    if (!Array.isArray(bundle.resource_overrides) || bundle.resource_overrides.length > 300) fail('resource_overrides 无效');
    bundle.resource_overrides.forEach((r, i) => {
      const at = '第 ' + (i + 1) + ' 条原版资源规则';
      if (!r || !['worldbook', 'regex', 'script'].includes(r.kind) || !['enabled', 'disabled'].includes(r.state) || !r.target) fail(at + '无效');
      if (r.kind === 'worldbook' && !String(r.target.uid ?? '').trim() && !String(r.target.name || '').trim()) fail(at + '缺少世界书条目 uid 或名称');
      if (r.kind === 'regex' && (String(r.target.scope || 'character') !== 'character' || (!String(r.target.id || '').trim() && !String(r.target.name || '').trim()))) fail(at + '的正则目标无效');
      if (r.kind === 'script' && (!SCRIPT_SCOPES.includes(String(r.target.scope || '')) || (!String(r.target.id || '').trim() && !String(r.target.name || '').trim()))) fail(at + '的脚本目标无效');
    });
  }
  bundle.artifacts.forEach((a, i) => {
    const at = '第 ' + (i + 1) + ' 个 artifact';
    if (!isObj(a) || !ALLOWED_KINDS.has(a.kind)) fail(at + '类型不受支持（只能是 worldbook / regex / preset / script / data）');
    if (!ALLOWED_FORMATS.has(a.format) || typeof a.name !== 'string' || !a.name.trim()) fail(at + '的 format 或 name 无效');
    if (a.format === 'text' && typeof a.content !== 'string') fail('“' + a.name + '”是 text 格式，content 必须是字符串');
    if (a.format === 'json' && a.content === undefined) fail('“' + a.name + '”缺少 content');
    const checkConflicts = (scriptTarget) => {
      if (a.original_conflicts === undefined) return;
      if (!Array.isArray(a.original_conflicts)) fail('“' + a.name + '”的 original_conflicts 必须是数组');
      for (const c of a.original_conflicts) {
        if (!c || !['disable', 'replace'].includes(c.action) || !c.target) fail('“' + a.name + '”的原版冲突声明无效');
        if (scriptTarget && !SCRIPT_SCOPES.includes(String(c.target.scope || ''))) fail('“' + a.name + '”的原脚本冲突作用域无效');
        const idOk = scriptTarget ? String(c.target.id || '').trim() : String(c.target.uid ?? '').trim();
        if (!idOk && !String(c.target.name ?? '').trim()) fail('“' + a.name + '”的原版冲突目标无效');
      }
    };
    if (a.kind === 'worldbook') checkConflicts(false);
    if (a.kind === 'script') { if (!SCRIPT_SCOPES.includes(String(a.scope || 'character'))) fail('“' + a.name + '”的脚本作用域无效'); checkConflicts(true); }
  });
}
function verifyManifest(pack) {
  const { bundle, manifest, project } = pack;
  validateBundle(bundle);
  if (!isObj(manifest) || manifest.schema_version !== 1) fail('manifest 无效');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== bundle.artifacts.length) fail('manifest 与 bundle 的 artifact 数量不一致');
  if (Number(manifest.artifact_count) !== bundle.artifacts.length) fail('manifest.artifact_count 不一致');
  if (manifest.project?.id !== project.id || Number(manifest.project?.version) !== Number(project.version)) fail('manifest 与项目版本不一致');
  if (JSON.stringify(manifest.resource_overrides || []) !== JSON.stringify(bundle.resource_overrides || [])) fail('原版资源状态规则与 manifest 不一致');
  let total = 0;
  bundle.artifacts.forEach((a, i) => {
    const d = manifest.artifacts[i];
    if (!d || d.kind !== a.kind || d.format !== a.format || d.name !== a.name) fail('“' + a.name + '”与 manifest 描述不一致');
    if (a.kind === 'script' && String(d.scope || 'character') !== String(a.scope || 'character')) fail('“' + a.name + '”的脚本作用域与 manifest 不一致');
    if (['worldbook', 'script'].includes(a.kind) && JSON.stringify(d.original_conflicts || []) !== JSON.stringify(a.original_conflicts || [])) fail('“' + a.name + '”的原版冲突声明与 manifest 不一致');
    const text = contentText(a), n = bytes(text); total += n;
    if (Number(d.byte_size) !== n) fail('“' + a.name + '”大小校验失败');
    if (sha256(text) !== d.sha256) fail('“' + a.name + '”SHA-256 校验失败');
  });
  if (Number(manifest.total_bytes) !== total) fail('manifest 总大小校验失败');
}

// ---------- 安装检查（与工坊 installer/normalize 同一口径：不通过时工坊安装会报错） ----------
function parseJsonLike(value, label) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { throw new Error(label + '不是有效 JSON'); }
}
function installCheck(pack) {
  const errs = [];
  pack.bundle.artifacts.forEach(a => {
    const tag = '“' + a.name + '”';
    try {
      if (a.kind === 'worldbook') {
        const parsed = parseJsonLike(a.content, tag + '世界书');
        const values = Array.isArray(parsed) ? parsed : isObj(parsed) && Array.isArray(parsed.entries) ? parsed.entries : isObj(parsed) && isObj(parsed.entries) ? Object.values(parsed.entries) : null;
        if (!values) throw new Error(tag + '世界书不包含 entries');
        if (!values.length) throw new Error(tag + '世界书没有任何条目');
        if (values.length > 500) throw new Error(tag + '单个世界书最多 500 个条目（现有 ' + values.length + ' 个）');
        values.forEach((e, j) => {
          if (!isObj(e)) throw new Error(tag + '第 ' + (j + 1) + ' 个条目结构无效');
          if (!String(e.name ?? e.comment ?? '').trim()) throw new Error(tag + '第 ' + (j + 1) + ' 个条目（uid ' + e.uid + '）缺少名称 comment');
        });
      }
      if (a.kind === 'regex') {
        const parsed = parseJsonLike(a.content, tag + '正则');
        const values = Array.isArray(parsed) ? parsed : isObj(parsed) && Array.isArray(parsed.regexes) ? parsed.regexes
          : isObj(parsed) && Array.isArray(parsed.extensions?.regex_scripts) ? parsed.extensions.regex_scripts
          : isObj(parsed) && (parsed.find_regex !== undefined || parsed.findRegex !== undefined) ? [parsed] : null;
        if (!values) throw new Error(tag + '中没有可识别的正则列表');
        values.forEach((r, j) => {
          if (!isObj(r)) throw new Error(tag + '第 ' + (j + 1) + ' 个正则结构无效');
          if (typeof (r.find_regex ?? r.findRegex) !== 'string') throw new Error(tag + '第 ' + (j + 1) + ' 个正则缺少 findRegex');
        });
      }
      if (a.kind === 'preset' && !isObj(parseJsonLike(a.content, tag + '预设'))) throw new Error(tag + '预设必须是 JSON 对象');
      if (a.kind === 'script') {
        const trees = a.format === 'text' ? [{ type: 'script', content: a.content }] : Array.isArray(a.content) ? a.content : [a.content];
        trees.forEach(t => {
          if (!isObj(t)) throw new Error(tag + '脚本结构无效');
          if (t.type === 'folder') {
            const list = Array.isArray(t.scripts) ? t.scripts : [];
            if (!list.length || list.some(s => !String(s?.content || '').trim())) throw new Error(tag + '包含空脚本');
          } else if (!String(t.content || '').trim()) throw new Error(tag + '脚本内容为空');
        });
      }
    } catch (e) { errs.push(e.message); }
  });
  return errs;
}

// ---------- 重算清单 ----------
function canonicalManifestProject(project) {
  return { id: project.id, slug: 'workshop-' + String(project.id).slice(0, 8), name: project.name, category: project.category, kind: project.category, version: Number(project.version), dependencies: clone(project.dependencies || []) };
}
// manifest 全部是工坊可以重新算出来的内容时，解包后只留一句“自动生成”
function manifestIsDerived(manifest, project) {
  if (!isObj(manifest) || manifest.schema_version !== 1) return false;
  if (!Object.keys(manifest).every(k => k === 'schema_version' || k === 'project' || MANIFEST_AUTO.has(k))) return false;
  return manifest.project === undefined || JSON.stringify(manifest.project) === JSON.stringify(canonicalManifestProject(project));
}
function rebuildManifest(pack, notes) {
  const { bundle, project } = pack, old = isObj(pack.manifest) ? pack.manifest : {};
  const oldArts = Array.isArray(old.artifacts) ? old.artifacts : [];
  let total = 0, changed = 0;
  const artifacts = bundle.artifacts.map((a, i) => {
    const text = contentText(a), n = bytes(text), h = sha256(text);
    total += n;
    const prev = oldArts[i] || {};
    if (prev.byte_size !== n || prev.sha256 !== h || prev.name !== a.name || prev.kind !== a.kind || prev.format !== a.format) changed++;
    const m = { kind: a.kind, format: a.format, name: a.name };
    if (a.kind === 'script') m.scope = String(a.scope || 'character');
    if (['worldbook', 'script'].includes(a.kind) && a.original_conflicts !== undefined) m.original_conflicts = clone(a.original_conflicts);
    m.byte_size = n; m.sha256 = h;
    return m;
  });
  if (changed) notes.push('重新计算了 ' + changed + ' 个 artifact 的大小与 SHA-256');
  const oldProject = isObj(old.project) ? old.project : {};
  // 没有旧的 manifest.project 时按工坊导出的字段顺序生成
  const syncedProject = isObj(old.project)
    ? { ...oldProject, id: project.id, name: project.name, category: project.category, version: Number(project.version), dependencies: clone(project.dependencies || []) }
    : canonicalManifestProject(project);
  if (!syncedProject.slug) syncedProject.slug = 'workshop-' + String(project.id).slice(0, 8);
  if (!syncedProject.kind) syncedProject.kind = project.category;
  if (JSON.stringify(oldProject) !== JSON.stringify(syncedProject)) notes.push('manifest.project 已与 project 同步');
  const overrides = clone(bundle.resource_overrides || []);
  if (JSON.stringify(old.resource_overrides || []) !== JSON.stringify(overrides)) notes.push('manifest.resource_overrides 已与 bundle 同步');
  if (old.artifact_count !== artifacts.length) notes.push('artifact_count 已更正为 ' + artifacts.length);
  if (old.total_bytes !== total) notes.push('total_bytes 已更正为 ' + total);
  pack.manifest = { ...old, schema_version: 1, resource_overrides: overrides, project: syncedProject, artifact_count: artifacts.length, total_bytes: total, artifacts };
}

// ---------- 提示（不改动内容，只提醒常见的坑） ----------
function lint(pack) {
  const warns = [];
  for (const a of pack.bundle.artifacts) {
    const tag = '“' + a.name + '”';
    if (a.kind === 'worldbook' && a.format === 'json') {
      const raw = a.content?.entries;
      const list = isObj(raw) ? Object.entries(raw) : Array.isArray(raw) ? raw.map((e, i) => [null, e, i]) : null;
      if (!list) { if (!Array.isArray(a.content)) warns.push(tag + '没有 entries'); continue; }
      const seen = new Map();
      for (const [k, e, i] of list) {
        if (!isObj(e)) { warns.push(tag + ' 条目 ' + (k ?? i + 1) + ' 不是对象'); continue; }
        const name = e.comment || e.name || k || '第 ' + (i + 1) + ' 条';
        if (k !== null && String(e.uid) !== k) warns.push(tag + ' 条目「' + name + '」的键 ' + k + ' 与 uid ' + e.uid + ' 不一致');
        if (e.uid !== undefined) { if (seen.has(e.uid)) warns.push(tag + ' uid ' + e.uid + ' 重复（「' + seen.get(e.uid) + '」与「' + name + '」）'); else seen.set(e.uid, name); }
        if (typeof e.content !== 'string') warns.push(tag + ' 条目「' + name + '」的 content 不是字符串');
        if (!Array.isArray(e.key)) warns.push(tag + ' 条目「' + name + '」的 key 不是数组');
        else if (!e.constant && !e.key.length && !e.disable) warns.push(tag + ' 条目「' + name + '」既不常驻也没有关键词，永远不会触发');
        if (typeof e.content === 'string' && (e.content.match(/<%/g) || []).length !== (e.content.match(/%>/g) || []).length) warns.push(tag + ' 条目「' + name + '」的 EJS 标签 <% 与 %> 数量不等');
      }
    }
    if (a.kind === 'script') {
      const trees = a.format === 'text' ? [{ name: a.name, content: a.content }] : (Array.isArray(a.content) ? a.content : [a.content]).flatMap(t => isObj(t) && t.type === 'folder' && Array.isArray(t.scripts) ? t.scripts : [t]);
      for (const t of trees) {
        const code = t?.content;
        if (typeof code !== 'string') { warns.push(tag + '没有脚本正文 content'); continue; }
        try { new vm.Script(code, { filename: a.name }); } catch (e) { if (!/import|export|await/.test(e.message)) warns.push(tag + (t.name && t.name !== a.name ? '（' + t.name + '）' : '') + ' 脚本语法错误：' + e.message); }
      }
    }
    if (a.kind === 'regex' && a.format === 'json') {
      const list = Array.isArray(a.content) ? a.content : [a.content];
      for (const r of list) {
        if (!isObj(r)) continue;
        const rn = tag + '（' + (r.scriptName || '未命名正则') + '）';
        try { toRegExp(r.findRegex); } catch (e) { warns.push(rn + ' 查找正则无法编译：' + e.message); }
        const rep = String(r.replaceString || ''), fence = rep.match(/^```\w*\n([\s\S]*)\n```\s*$/);
        if (!fence || !/<(script|html|body|style)\b/i.test(fence[1])) continue;
        const html = fence[1];
        // 以下都是酒馆把正则结果显示到楼层、再交给酒馆助手渲染时会改写源码的情况
        if (/&[#A-Za-z0-9]/.test(html)) warns.push(rn + ' 页面源码里直接写了 HTML 实体（如 &amp; &#39;），显示时会被解码，可能让脚本语法错误；脚本里请用 \\x26 书写');
        const odd = html.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.split('"').length % 2 === 0 || l.split('*').length % 2 === 0).map(([n]) => n);
        if (odd.length) warns.push(rn + ' 第 ' + odd.slice(0, 8).join('、') + (odd.length > 8 ? ' 等' : '') + ' 行的 " 或 * 个数为奇数，酒馆开启自动修复 Markdown 时会在行尾补字符');
        if (/\$(\d|<)/.test(html)) warns.push(rn + ' 页面源码里出现 $数字 或 $<，会被当作正则捕获组替换');
        if (html.includes('{{')) warns.push(rn + ' 页面源码里出现 {{，会被当作酒馆宏替换');
        if (html.includes('```')) warns.push(rn + ' 页面源码里出现 ```，会截断代码块');
        if (/<(user|char|bot|group|charifnotgroup)>/i.test(html)) warns.push(rn + ' 页面源码里出现 <user> 等旧式宏，会被替换成名字');
        for (const [hn, re] of HOST_DISPLAY_REGEX) if (re.test(html)) warns.push(rn + ' 页面源码会被' + hn + '正则匹配，显示时会插进别的内容');
        for (const other of pack.bundle.artifacts.filter(o => o.kind === 'regex')) {
          for (const o of (Array.isArray(other.content) ? other.content : [other.content])) {
            if (o === r || !isObj(o) || !o.findRegex || o.promptOnly === true) continue;
            try { if (toRegExp(o.findRegex).test(html)) warns.push(rn + ' 页面源码会被本包的正则「' + (o.scriptName || other.name) + '」匹配'); } catch (_) {}
          }
        }
      }
    }
  }
  return warns;
}

// ---------- 读离线包 ----------
function loadPack(file, notes) {
  const pack = parseLoose(fs.readFileSync(file, 'utf8'), '', notes);
  if (!isObj(pack)) fail('文件内容不是离线包对象');
  if (pack.format !== OFFLINE_FORMAT || pack.version !== OFFLINE_VERSION) fail('不是轮回战场创意工坊离线包（format/version 不对）');
  if (!isObj(pack.project) && isObj(pack.manifest?.project)) {
    const mp = pack.manifest.project;
    pack.project = { id: mp.id, name: mp.name, category: mp.category, version: mp.version, dependencies: mp.dependencies || [] };
    notes.push('project 缺失，已从 manifest.project 还原');
  }
  validateProject(pack.project);
  if (!Array.isArray(pack.project.dependencies)) pack.project.dependencies = [];
  if (isObj(pack.bundle) && pack.bundle.schema_version === undefined) { pack.bundle.schema_version = 1; notes.push('补上了 bundle.schema_version'); }
  validateBundle(pack.bundle);
  return pack;
}
function writePack(pack, target, { backup = true } = {}) {
  const out = JSON.stringify(pack);
  if (bytes(out) > MAX_OFFLINE_BYTES) fail('离线包超过 6 MB，工坊无法导入（当前 ' + (bytes(out) / 1048576).toFixed(2) + ' MB）');
  let bak = null, same = false;
  if (fs.existsSync(target)) {
    if (fs.readFileSync(target, 'utf8') === out) same = true;
    else if (backup) { bak = target + '.bak'; fs.copyFileSync(target, bak); }
  }
  if (!same) fs.writeFileSync(target, out, 'utf8');
  verifyManifest(JSON.parse(fs.readFileSync(target, 'utf8')));
  return { bak, same, size: bytes(out) };
}

// ---------- 修复 ----------
function fixFile(file, opts) {
  const notes = [];
  const pack = loadPack(file, notes);
  if (opts.bump) { pack.project.version = Number(pack.project.version) + 1; notes.push('版本号升为 v' + pack.project.version); }
  let alreadyOk = true;
  try { verifyManifest(pack); } catch (e) { alreadyOk = false; if (!(e instanceof PackError)) throw e; notes.push('原校验失败：' + e.message); }
  if (!alreadyOk || opts.bump) rebuildManifest(pack, notes);
  verifyManifest(pack);
  const errors = installCheck(pack), warns = lint(pack);
  const out = JSON.stringify(pack);
  if (bytes(out) > MAX_OFFLINE_BYTES) fail('离线包超过 6 MB，工坊无法导入（当前 ' + (bytes(out) / 1048576).toFixed(2) + ' MB）');
  const needWrite = notes.length > 0;
  let target = null, backup = null;
  if (needWrite && !opts.check) {
    target = opts.out ? path.resolve(opts.out) : file;
    if (target === path.resolve(file) && opts.backup) { backup = file + '.bak'; fs.copyFileSync(file, backup); }
    fs.writeFileSync(target, out, 'utf8');
    verifyManifest(JSON.parse(fs.readFileSync(target, 'utf8')));
  }
  return { project: pack.project, artifacts: pack.bundle.artifacts.length, bytes: bytes(out), notes, warns, errors, needWrite, target, backup };
}

// ---------- 解包：离线包 → 可编辑的项目文件夹 ----------
class Writer {
  constructor(dir) { this.dir = dir; this.used = new Set(); fs.mkdirSync(dir, { recursive: true }); }
  unique(name) {
    const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
    let n = name, i = 2;
    while (this.used.has(n.toLowerCase())) n = stem + ' (' + (i++) + ')' + ext;
    this.used.add(n.toLowerCase());
    return n;
  }
  write(name, data) { fs.writeFileSync(path.join(this.dir, name), data); Writer.count++; return name; }
  sub(name) { const n = this.unique(name); const w = new Writer(path.join(this.dir, n)); w.name = n; return w; }
  // data:image/...;base64 → 图片文件；base64 不规范时返回 null，保持原文内嵌
  image(stem, url) {
    const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (!m) return null;
    const buf = Buffer.from(m[2], 'base64');
    if (buf.toString('base64') !== m[2]) return null;
    const ext = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' }[m[1]] || m[1].slice(6);
    const name = this.write(this.unique(stem + '.' + ext), buf);
    return MIME[ext] === m[1] ? { $image: name } : { $image: name, type: m[1] };
  }
}
Writer.count = 0;
// 数据里本来就有形如 {"$file": …} 的对象时，包一层 $literal，打包时原样还原
function escapeLiterals(v) {
  if (Array.isArray(v)) return v.map(escapeLiterals);
  if (!isObj(v)) return v;
  const ks = Object.keys(v);
  if (ks.length && ks.every(k => MARK_KEYS.has(k) || k === 'array' || k === 'type') && ks.some(k => MARK_KEYS.has(k))) return { $literal: v };
  const o = {}; for (const k of ks) o[k] = escapeLiterals(v[k]); return o;
}
function extFor(str, kind, key) {
  if (kind === 'script' && key === 'content') return '.js';
  if (/^```html\b/.test(str) || /^\s*(<!DOCTYPE html|<html[\s>])/i.test(str)) return '.html';
  return '.txt';
}
function itemLabel(x, i) {
  const n = isObj(x) ? (x.scriptName ?? x.script_name ?? x.name ?? x.identifier ?? x.comment) : null;
  return String(i + 1).padStart(2, '0') + (n ? ' ' + safeName(n, 30) : '');
}
// 较长或多行的文字拆成单独文件，JSON 里留下 {"$file": 文件名}
function externalize(v, w, kind, labels, key) {
  if (typeof v === 'string') {
    if (v.length < 120 && !v.includes('\n')) return v;
    return { $file: w.write(w.unique(safeName(labels.join('.') || 'content', 80) + extFor(v, kind, key)), v) };
  }
  if (Array.isArray(v)) return v.map((x, i) => externalize(x, w, kind, labels.concat(itemLabel(x, i)), null));
  if (!isObj(v)) return v;
  const ks = Object.keys(v);
  if (ks.length && ks.every(k => MARK_KEYS.has(k) || k === 'array' || k === 'type') && ks.some(k => MARK_KEYS.has(k))) return { $literal: v };
  const o = {}; for (const k of ks) o[k] = externalize(v[k], w, kind, labels.concat(k), k); return o;
}
function entryText(e, keyOverride) {
  const body = typeof e.content === 'string';
  const rows = keyOverride === undefined ? [] : [['$key', keyOverride]];
  for (const k of Object.keys(e)) rows.push([k, k === 'content' && body ? CONTENT_MARK : e[k]]);
  return '---\n{\n' + rows.map(([k, v]) => '  ' + JSON.stringify(k) + ': ' + JSON.stringify(v)).join(',\n') + '\n}\n---\n' + (body ? e.content : '');
}
function writeEntries(entries, w) {
  const isArr = Array.isArray(entries), ew = w.sub('entries');
  const list = isArr ? entries.map((e, i) => [i, e]) : Object.entries(entries);
  for (const [k, e] of list) {
    const label = String(e.comment ?? e.name ?? '').trim();
    const prefix = isArr ? String(k + 1).padStart(3, '0') : String(k);
    const keyOverride = !isArr && String(e.uid) !== String(k) ? k : undefined;
    ew.write(ew.unique(safeName(prefix + (label ? ' ' + label : ''), 70) + '.txt'), entryText(e, keyOverride));
  }
  return isArr ? { $entries: ew.name, array: true } : { $entries: ew.name };
}
function artifactContent(a, w) {
  const c = a.content;
  if (a.format === 'text' && typeof c === 'string') return { $file: w.write(w.unique('content' + extFor(c, a.kind, 'content')), c) };
  const entries = isObj(c) ? c.entries : undefined;
  if (a.kind === 'worldbook' && (isObj(entries) || Array.isArray(entries)) && Object.values(entries).every(isObj)) {
    const o = {};
    for (const k of Object.keys(c)) o[k] = k === 'entries' ? writeEntries(entries, w) : externalize(c[k], w, a.kind, [k], k);
    return o;
  }
  return externalize(c, w, a.kind, [], null);
}
function writeSource(pack, dir) {
  const root = new Writer(dir), pj = {};
  for (const k of Object.keys(pack)) {
    const v = pack[k];
    if (k === 'project' && isObj(v)) {
      const p = escapeLiterals(clone(v));
      if (typeof v.cover_url === 'string') { const img = root.image('cover', v.cover_url); if (img) p.cover_url = img; }
      pj.project = p;
    } else if (k === 'manifest' && isObj(v)) {
      if (manifestIsDerived(v, pack.project)) { pj.manifest = AUTO_NOTE; continue; }
      const m = {}; for (const mk of Object.keys(v)) m[mk] = MANIFEST_AUTO.has(mk) ? AUTO_NOTE : escapeLiterals(clone(v[mk])); pj.manifest = m;
    } else if (k === 'bundle' && isObj(v)) {
      const b = {}; for (const bk of Object.keys(v)) b[bk] = bk === 'artifacts' ? { $artifacts: '按编号顺序读取各 artifact 文件夹' } : escapeLiterals(clone(v[bk])); pj.bundle = b;
    } else pj[k] = escapeLiterals(clone(v));
  }
  root.write(root.unique('project.json'), JSON.stringify(pj, null, 2) + '\n');
  pack.bundle.artifacts.forEach((a, i) => {
    const w = root.sub(String(i + 1).padStart(2, '0') + ' ' + (KIND_LABEL[a.kind] || a.kind) + ' · ' + safeName(String(a.name).replace(/\.(json|txt|js)$/i, ''), 40));
    const meta = {};
    for (const k of Object.keys(a)) meta[k] = k === 'content' ? artifactContent(a, w) : escapeLiterals(clone(a[k]));
    w.write('artifact.json', JSON.stringify(meta, null, 2) + '\n');
  });
  root.write(root.unique('_说明.txt'), SOURCE_README);
}
function freeDir(base, strict) {
  const empty = d => fs.statSync(d).isDirectory() && fs.readdirSync(d).length === 0;
  if (!fs.existsSync(base) || empty(base)) return base;
  if (strict) fail('目标文件夹已存在且不为空：' + base);
  for (let i = 2; ; i++) { const d = base + ' (' + i + ')'; if (!fs.existsSync(d) || empty(d)) return d; }
}
function unpackFile(file, opts) {
  const notes = [], pack = loadPack(file, notes);
  try { verifyManifest(pack); } catch (e) { if (!(e instanceof PackError)) throw e; notes.push('清单校验未通过（' + e.message + '），已按内容解包，打包时会重新计算'); }
  const base = opts.out ? path.resolve(opts.out) : path.join(path.dirname(path.resolve(file)), safeName(pack.project.name, 60) + '-v' + pack.project.version);
  const dir = freeDir(base, !!opts.out);
  Writer.count = 0;
  writeSource(pack, dir);
  return { dir, pack, notes, files: Writer.count };
}

// ---------- 打包：项目文件夹 → 离线包 ----------
function inside(root, base, rel, where) {
  if (typeof rel !== 'string' || !rel.trim()) fail(where + '：文件引用无效');
  const f = path.resolve(base, rel), r = path.relative(root, f);
  if (r.startsWith('..') || path.isAbsolute(r)) fail(where + '：引用的 ' + rel + ' 不在项目文件夹内');
  if (!fs.existsSync(f)) fail(where + '：找不到引用的文件 ' + rel);
  return f;
}
function parseEntryFile(file) {
  const t = readText(file), rel = path.basename(file);
  const open = /^---\r?\n/.exec(t);
  if (!open) fail(rel + '：第一行应是 ---（条目设置从这里开始）');
  const sep = /\r?\n---(?:\r?\n|$)/g; sep.lastIndex = open[0].length - 1;
  const close = sep.exec(t);
  if (!close) fail(rel + '：缺少第二条 ---（条目设置到这里结束，下面是正文）');
  const head = t.slice(open[0].length, close.index), body = t.slice(close.index + close[0].length);
  if (!head.trim()) fail(rel + '：两条 --- 之间没有条目设置');
  const meta = parseLoose(head, rel + ' 的条目设置', null, 1);
  if (!isObj(meta)) fail(rel + '：条目设置必须是 { } 包起来的 JSON 对象');
  let key;
  if ('$key' in meta) { key = String(meta.$key); delete meta.$key; }
  else if (meta.uid === undefined || meta.uid === null || meta.uid === '') fail(rel + '：条目设置里缺少 uid');
  else key = String(meta.uid);
  if (!('content' in meta) || meta.content === CONTENT_MARK) meta.content = body;
  return { key, entry: meta };
}
function readEntries(dir, isArr) {
  if (!fs.statSync(dir).isDirectory()) fail('世界书条目应放在文件夹里：' + dir);
  const names = fs.readdirSync(dir).filter(n => /\.txt$/i.test(n) && !n.startsWith('_')).sort(collate);
  const out = isArr ? [] : {}, seen = new Map();
  for (const n of names) {
    const { key, entry } = parseEntryFile(path.join(dir, n));
    if (isArr) { out.push(entry); continue; }
    if (seen.has(key)) fail('世界书条目 uid ' + key + ' 重复：「' + seen.get(key) + '」与「' + n + '」（复制条目文件新建条目时要改 uid）');
    seen.set(key, n); out[key] = entry;
  }
  return out;
}
function resolveMarks(v, root, base, where) {
  if (Array.isArray(v)) return v.map(x => resolveMarks(x, root, base, where));
  if (!isObj(v)) return v;
  const ks = Object.keys(v), only = list => ks.every(k => list.includes(k));
  if ('$literal' in v && ks.length === 1) return v.$literal;
  if ('$file' in v && only(['$file'])) return readText(inside(root, base, v.$file, where));
  if ('$image' in v && only(['$image', 'type'])) {
    const f = inside(root, base, v.$image, where), type = v.type || MIME[path.extname(f).slice(1).toLowerCase()];
    if (!type) fail(where + '：不认识的图片格式 ' + v.$image + '（支持 jpg / png / webp / gif / svg）');
    return 'data:' + type + ';base64,' + fs.readFileSync(f).toString('base64');
  }
  if ('$entries' in v && only(['$entries', 'array'])) return readEntries(inside(root, base, v.$entries, where), v.array === true);
  if ('$artifacts' in v && ks.length === 1) return ARTIFACTS_SLOT;
  const o = {}; for (const k of ks) o[k] = resolveMarks(v[k], root, base, where); return o;
}
function projectDirs(input) {
  const p = path.resolve(input);
  if (fs.statSync(p).isFile()) { if (path.basename(p).toLowerCase() === 'project.json') return [path.dirname(p)]; fail('请拖入解包得到的项目文件夹（里面有 project.json）'); }
  if (fs.existsSync(path.join(p, 'project.json'))) return [p];
  const subs = fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory() && fs.existsSync(path.join(p, d.name, 'project.json'))).map(d => path.join(p, d.name));
  if (!subs.length) fail('文件夹里没有 project.json，不是解包得到的项目文件夹：' + p);
  return subs;
}
function buildFromDir(dir, notes) {
  const pjFile = path.join(dir, 'project.json');
  const pj = parseLoose(readText(pjFile), 'project.json', notes);
  if (!isObj(pj)) fail('project.json 必须是 JSON 对象');
  const pack = resolveMarks(pj, dir, dir, 'project.json');
  if (pack.format !== OFFLINE_FORMAT || pack.version !== OFFLINE_VERSION) fail('project.json 里的 format / version 应为 "' + OFFLINE_FORMAT + '" / 1');
  validateProject(pack.project);
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'artifact.json'))).map(d => d.name).sort(collate);
  if (!subs.length) fail('没有找到 artifact 文件夹（含 artifact.json 的子文件夹）');
  const artifacts = subs.map(name => {
    const ad = path.join(dir, name), a = parseLoose(readText(path.join(ad, 'artifact.json')), name + '/artifact.json', notes);
    if (!isObj(a)) fail(name + '/artifact.json 必须是 JSON 对象');
    return resolveMarks(a, dir, ad, name);
  });
  if (!isObj(pack.bundle)) pack.bundle = { schema_version: 1, artifacts: ARTIFACTS_SLOT };
  if (pack.bundle.artifacts !== undefined && pack.bundle.artifacts !== ARTIFACTS_SLOT) fail('project.json 的 bundle.artifacts 应写成 {"$artifacts": "…"}，内容来自各 artifact 文件夹');
  pack.bundle.artifacts = artifacts;
  if ('manifest' in pack && !isObj(pack.manifest)) pack.manifest = { schema_version: 1 };
  if (!isObj(pack.manifest)) {
    const ordered = {};
    for (const k of Object.keys(pack)) { if (k === 'bundle') ordered.manifest = { schema_version: 1 }; ordered[k] = pack[k]; }
    return { pack: ordered, pj, folders: subs };
  }
  return { pack, pj, folders: subs };
}
function packDir(dir, opts) {
  const notes = [];
  const { pack, pj, folders } = buildFromDir(dir, notes);
  if (opts.bump) { pack.project.version = Number(pack.project.version) + 1; notes.push('版本号升为 v' + pack.project.version + '（已写回 project.json）'); }
  validateBundle(pack.bundle);
  const errors = installCheck(pack);
  if (errors.length) fail('工坊安装时会失败，未生成离线包：\n    ' + errors.join('\n    '));
  rebuildManifest(pack, []);
  verifyManifest(pack);
  const warns = lint(pack);
  const target = opts.out ? path.resolve(opts.out) : path.join(path.dirname(dir), safeName(pack.project.name, 60) + '-v' + pack.project.version + '.rwpack');
  const w = writePack(pack, target, opts);
  if (opts.bump) { pj.project.version = pack.project.version; fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(pj, null, 2) + '\n'); }
  return { target, ...w, pack, notes, warns, folders };
}

// ---------- 示例项目 ----------
function crcTable() { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t.push(c >>> 0); } return t; }
function png(w, h, pixel) {
  const T = crcTable(), crc = b => { let c = 0xFFFFFFFF; for (const x of b) c = T[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = pixel(x, y), o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = p[0]; raw[o + 1] = p[1]; raw[o + 2] = p[2]; }
  const chunk = (type, data) => { const td = Buffer.concat([Buffer.from(type, 'ascii'), data]), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// 封面：暖色灯光与一圈圈“回声”涟漪
function exampleCover() {
  const W = 480, H = 270, cx = W * 0.68, cy = H * 0.46;
  return png(W, H, (x, y) => {
    const t = y / H, d = Math.hypot(x - cx, y - cy);
    const glow = Math.exp(-((d / (H * 0.32)) ** 2)), ring = d > H * 0.1 ? Math.max(0, Math.cos(d / 7)) ** 30 * Math.exp(-d / (H * 0.8)) : 0;
    const steam = Math.max(0, Math.sin(y / 9 + Math.sin(x / 23) * 2)) ** 40 * Math.exp(-(((x - W * 0.24) / 28) ** 2)) * (y < H * 0.7 ? 1 - y / (H * 0.7) : 0);
    const base = [43 - 27 * t, 30 - 19 * t, 24 - 15 * t];
    return [[240, 0.62], [186, 0.5], [118, 0.32]].map(([c, k], i) => Math.min(255, Math.round(base[i] + c * glow * k + [250, 214, 160][i] * ring * 0.55 + [230, 220, 205][i] * steam * 0.35)));
  });
}
function stEntry(uid, comment, content, keys, o = {}) {
  const position = o.position ?? 0, depth = o.depth ?? 4, role = o.role ?? 0, order = o.order ?? 100;
  return {
    uid, key: keys, keysecondary: [], comment, content, constant: !!o.constant, selective: true, order, position,
    excludeRecursion: true, preventRecursion: true, delayUntilRecursion: false, disable: !!o.disable, addMemo: true, displayIndex: 0,
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
}
// 示例页面：显示在聊天楼层里的 HTML（酒馆助手渲染）。写法要点：不写 HTML 实体、每行双引号与星号成对（这里一律用单引号）、不出现 $数字 与双花括号
const EXAMPLE_PAGE = `<!DOCTYPE html>
<html lang='zh-CN'>
<head>
<meta charset='UTF-8'>
<meta name='viewport' content='width=device-width, initial-scale=1'>
<style>
html, body { margin: 0; padding: 0; background: transparent; height: auto !important; }
#app { font-family: system-ui, sans-serif; color: #ece4d8; background: linear-gradient(160deg, #2c211b, #17120f); border: 1px solid #5b4637; border-radius: 12px; padding: 14px 16px; }
h3 { margin: 0 0 4px; font-size: 17px; color: #f0c98a; }
.hint { margin: 0 0 12px; font-size: 13px; opacity: .75; }
.menu { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.item { border: 1px solid #5b4637; border-radius: 10px; padding: 10px; cursor: pointer; background: rgba(255, 255, 255, .03); }
.item:hover, .item.on { border-color: #f0c98a; background: rgba(240, 201, 138, .08); }
.item b { display: block; font-size: 14px; margin-bottom: 4px; }
.item span { font-size: 12px; opacity: .72; }
.msg { margin-top: 10px; font-size: 13px; min-height: 18px; color: #f0c98a; }
</style>
</head>
<body>
<div id='app'>
  <h3>回声茶馆 · 今日茶单</h3>
  <p class='hint'>点一壶茶：点单会填进酒馆输入框，发不发送由你决定。</p>
  <div class='menu' id='menu'></div>
  <div class='msg' id='msg'></div>
</div>
<script>
(function () {
  var MENU = [
    { name: '回声乌龙', note: '回甘悠长，据说能让人想起忘掉的梦' },
    { name: '雾港红茶', note: '茶馆招牌，配一碟桂花糕' },
    { name: '空白白茶', note: '没有味道，老板说这正是它的味道' }
  ];
  var app = document.getElementById('app');
  function el(id) { return document.getElementById(id); }
  // 用 DOM 接口生成卡片，不拼接 HTML 字符串，也就不需要转义
  function render() {
    MENU.forEach(function (m) {
      var card = document.createElement('div'), b = document.createElement('b'), s = document.createElement('span');
      card.className = 'item'; b.textContent = m.name; s.textContent = m.note;
      card.appendChild(b); card.appendChild(s);
      card.addEventListener('click', function () { order(m, card); });
      el('menu').appendChild(card);
    });
  }
  // 页面在酒馆助手的 iframe 里，与酒馆同源，可以直接操作酒馆的输入框
  function order(m, card) {
    [].forEach.call(document.querySelectorAll('.item'), function (x) { x.classList.remove('on'); });
    card.classList.add('on');
    var text = '我在回声茶馆点了一壶' + m.name + '。';
    try {
      var input = window.parent.document.getElementById('send_textarea');
      if (!input) throw new Error('没有输入框');
      input.value = text;
      input.dispatchEvent(new window.parent.Event('input', { bubbles: true }));
      el('msg').textContent = '已填入输入框：' + text;
    } catch (e) {
      el('msg').textContent = '没有找到酒馆输入框，请手动输入：' + text;
    }
    fit();
  }
  // 按内容高度调整 iframe：量 #app 的实际高度，不用 scrollHeight，避免与外层的自动调整互相放大
  function fit() {
    try {
      var frame = window.frameElement;
      if (!frame) return;
      var h = Math.ceil(app.getBoundingClientRect().bottom + (window.pageYOffset || 0)) + 2;
      if (Math.abs((parseFloat(frame.style.height) || 0) - h) < 1) return;
      frame.style.minHeight = '0px';
      frame.style.height = h + 'px';
    } catch (e) {}
  }
  render();
  fit();
  window.addEventListener('resize', fit);
})();
</script>
</body>
</html>`;
const EXAMPLE_SCRIPT = `// 示例脚本（酒馆助手）：在输入框上方加一个“回声茶馆”按钮。
// 按钮名要和脚本设置里 button.buttons 的 name 一致；点击后读取当前世界（MVU 变量），再插入一条消息，由“茶馆茶单页面”正则显示成茶单。
(function () {
  var BUTTON = '回声茶馆';
  var host = window.parent || window;
  // 酒馆助手脚本运行在 iframe 里：MVU、toastr 等挂在酒馆页面上，先找自己再找外层
  function pick(name) { return window[name] || host[name] || null; }
  function notify(kind, text) { var t = pick('toastr'); if (t) t[kind](text, '示例扩展'); else console.log('[示例扩展] ' + text); }
  function worldName() {
    try {
      var data = pick('Mvu').getMvuData({ type: 'message', message_id: 'latest' });
      var w = data && data.stat_data && data.stat_data.世界;
      return (w && w.名称) || '未知世界';
    } catch (e) { return '未知世界'; }
  }
  if (typeof eventOn !== 'function' || typeof getButtonEvent !== 'function') return;
  eventOn(getButtonEvent(BUTTON), async function () {
    notify('info', '你推开了回声茶馆的门。当前所在：' + worldName());
    if (typeof createChatMessages === 'function') {
      await createChatMessages([{ role: 'assistant', message: '【回声茶馆】' }], { refresh: 'affected' });
    } else {
      notify('warning', '当前酒馆助手没有 createChatMessages 接口，请手动发送：【回声茶馆】');
    }
  });
})();
`;
function examplePack() {
  const uuid = () => crypto.randomUUID();
  const entries = [
    stEntry(990001, '示例·常驻总纲', '<示例扩展>\n这是“示例扩展”的常驻条目（constant 为 true），每次都会发给 AI。\n设定：主神空间的街角有一家“回声茶馆”，轮回者休整期间都可以进去坐坐。茶馆不参与任务、不卖装备，只卖茶和故事。\n</示例扩展>', [], { constant: true, order: 100 }),
    stEntry(990002, '示例·关键词触发·回声茶馆', '<回声茶馆>\n位置: 主神空间中枢东侧一条窄巷的尽头，门口挂着一串会自己响的铜铃\n老板: 阿篱，看不出年纪，记性极好，能复述客人上次来时说过的每一句话；从不打听任务细节\n规矩:\n  - 茶馆里禁止动武，违者会被铜铃声“请”出门\n  - 可以用故事付账：讲一个任务世界里的见闻，抵一壶茶\n</回声茶馆>', ['回声茶馆', '阿篱', '茶馆'], { order: 101 }),
    stEntry(990003, '示例·按深度插入·茶馆告示格式', '当剧情发生在回声茶馆时，可以在正文末尾附一段茶馆告示，格式：\n<茶馆告示>今日特供或茶馆里的新鲜事，一两句</茶馆告示>\n它会被“茶馆告示美化”正则显示成告示卡片。', ['回声茶馆', '茶馆'], { position: 4, depth: 2, role: 0, order: 10 }),
    stEntry(990004, '示例·EJS读取变量', "<%_\n;(() => {\n  const sd = getMessageVar('stat_data', { defaults: {} }) || {};\n  if (String(_.get(sd, '世界.名称', '')) !== '主神空间') return;\n_%>\n主角此刻在主神空间休整，可以顺路去回声茶馆坐坐。\n<%_\n})();\n_%>", [], { constant: true, order: 102 }),
    stEntry(990005, '示例·已停用条目', '这条设置了 "disable": true，不会发送给 AI。写到一半的草稿可以先这样停用。', ['回声茶馆'], { disable: true, order: 103 }),
  ];
  entries.forEach((e, i) => { e.displayIndex = i; e.extensions.display_index = i; });
  const regexBase = { trimStrings: [], placement: [2], substituteRegex: 0, minDepth: null, maxDepth: null };
  const artifacts = [
    { kind: 'worldbook', format: 'json', name: '示例世界书.json', content: { entries: Object.fromEntries(entries.map(e => [String(e.uid), e])) } },
    {
      kind: 'script', format: 'json', name: '示例脚本.json', scope: 'character',
      content: { type: 'script', enabled: true, name: '示例脚本', id: uuid(), button: { enabled: true, buttons: [{ name: '回声茶馆', visible: true }] }, data: {}, export_with: { data: true, button: true }, content: EXAMPLE_SCRIPT, info: '示例脚本：在输入框上方加“回声茶馆”按钮，点击后插入茶单页面。' },
    },
    {
      kind: 'regex', format: 'json', name: '茶馆茶单页面.json',
      content: { id: uuid(), scriptName: '茶馆茶单页面', disabled: false, runOnEdit: false, findRegex: '【回声茶馆】', ...regexBase, replaceString: '```html\n' + EXAMPLE_PAGE + '\n```', markdownOnly: true, promptOnly: false },
    },
    {
      kind: 'regex', format: 'json', name: '茶馆正则组.json',
      content: [
        { id: uuid(), scriptName: '茶馆告示美化', disabled: false, runOnEdit: false, findRegex: '/<茶馆告示>([\\s\\S]*?)<\\/茶馆告示>/g', ...regexBase, replaceString: "<div style='border:1px dashed #b08a5a;border-radius:8px;padding:8px 12px;margin:6px 0;background:rgba(176,138,90,.08)'><b>茶馆告示</b><br>$1</div>", markdownOnly: true, promptOnly: false },
        { id: uuid(), scriptName: '茶单标记不发给AI', disabled: false, runOnEdit: false, findRegex: '【回声茶馆】', ...regexBase, replaceString: '', markdownOnly: false, promptOnly: true },
      ],
    },
  ];
  const pack = {
    format: OFFLINE_FORMAT, version: OFFLINE_VERSION, exported_at: Date.now(),
    project: {
      id: uuid(), name: '示例扩展', category: 'extension', version: 1, dependencies: [],
      summary: '轮回战场创意工坊的示例扩展：主神空间街角的“回声茶馆”。演示世界书（常驻、关键词、按深度插入、EJS 读取变量、停用条目）、正则（聊天里的 HTML 页面、文字美化、只改发给 AI 的内容）与酒馆助手脚本按钮。用 rwkit 解包就能看到每个文件怎么写。',
      tags: ['示例', '模板', '回声茶馆'], has_cover: true, cover_url: 'data:image/png;base64,' + exampleCover().toString('base64'),
    },
    manifest: { schema_version: 1 },
    bundle: { schema_version: 1, artifacts, resource_overrides: [] },
  };
  rebuildManifest(pack, []);
  return pack;
}
function makeExample(dest, opts) {
  const pack = examplePack(), dir = freeDir(path.join(path.resolve(dest), '示例扩展'), false);
  Writer.count = 0;
  writeSource(pack, dir);
  fs.writeFileSync(path.join(dir, '_更多写法参考.txt'), MORE_REFERENCE);
  const r = packDir(dir, { backup: opts.backup !== false });
  return { dir, ...r };
}

// ---------- 说明文字 ----------
const SOURCE_README = `这是 rwkit 解包得到的工坊项目文件夹。改完后把整个文件夹拖到“打包.cmd”上，就会重新生成 .rwpack。

文件夹结构
  project.json            项目资料：名称、分类、版本、简介、标签、封面、依赖、原版资源规则
  cover.jpg / cover.png   封面图（project.json 里 "cover_url": {"$image": "cover.jpg"} 指向它，换图直接替换文件）
  01 世界书 · 名称/       每个 artifact 一个文件夹；开头的编号决定它在包里的顺序
    artifact.json         这个 artifact 的设置：kind 类型、format、name，脚本还有 scope 作用域
    entries/              世界书条目，一条一个 .txt 文件
  02 脚本 · 名称/
    artifact.json
    content.js            脚本正文
  03 正则 · 名称/
    artifact.json
    replaceString.html    正则的替换内容（较长或多行的文字都会拆成单独文件）
  新增 artifact：复制一个同类文件夹，改编号和 artifact.json 里的 name；删除 artifact：删掉文件夹。

世界书条目文件（entries/*.txt）
  两条 --- 之间是条目设置（JSON），第二条 --- 之后全部是正文，原样写进世界书。
  常改的设置：
    "uid"        条目编号，同一世界书里不能重复；复制文件新建条目时一定要改
    "comment"    条目名称（工坊安装时必须有）
    "key"        触发关键词，例如 ["茶馆", "老板"]
    "constant"   true = 常驻，每次都发送；false = 出现关键词才发送
    "disable"    true = 停用
    "order"      排序，越小越靠前
    "position"   插入位置：0 角色定义之前，1 角色定义之后，4 按深度插入（配合 "depth" 与 "role"）
    "depth"      position 为 4 时，插在倒数第几条消息处
    "role"       position 为 4 时以什么身份插入：0 系统，1 用户，2 AI
  新增条目：复制一个条目文件，改 uid 与 comment，再改正文。删除条目：删掉文件。
  文件名只是方便辨认，打包时以设置里的 uid 为准。

引用标记（打包时自动换回原内容，不要手动展开）
  {"$file": "文件名"}          用该文件的全部文字
  {"$image": "cover.jpg"}      用该图片生成封面
  {"$entries": "entries"}      用该文件夹里的条目文件组成世界书
  {"$artifacts": "…"}          按编号顺序读取各 artifact 文件夹
  {"$literal": …}              原样保留（数据里本来就有以 $ 开头的键时才会出现）

自动维护的部分
  project.json 里 "manifest" 的大小、SHA-256、数量等打包时自动重新计算，不用改。
  改版本号只改 "project" 里的 "version"；“打包并升版本号.cmd”会自动 +1 并写回 project.json。

打包时会检查
  · 与工坊导入、工坊安装一致的检查（条目要有名称、正则要有 findRegex、脚本不能为空等）；不通过不会生成文件
  · 常见的坑只提示（⚠）：uid 不一致、条目永不触发、EJS 标签不配对、脚本语法错误、
    正则里的 HTML 页面会被酒馆显示流程改写（直接写 HTML 实体、某行 " 或 * 个数为奇数、$1、{{、<user>、
    页面文字会被原版或本包其他正则匹配）
`;
const MORE_REFERENCE = `更多写法参考（示例里没有直接用到的部分）

项目资料（project.json → "project"）
  "category"      "extension" 扩展，或 "character" 角色包
  "version"       不小于 1 的整数；工坊靠它识别新版本，已安装同一版本时不能直接导入覆盖
  "dependencies"  依赖的其他工坊项目，最多 12 个：
                    [{"project_id": "另一个项目的 id", "min_version": 3}]
  "summary" / "tags" / "has_cover" / "cover_url"   离线导入时显示在工坊“本地”页的作品卡片上

原版资源规则（project.json → "bundle" → "resource_overrides"，最多 300 条）
  安装后停用或启用原版角色卡里的资源，卸载时恢复：
    {"kind": "worldbook", "state": "disabled", "target": {"worldbook": "轮回战场V3.7", "uid": "965161", "name": "阵营-守护者"}}
    {"kind": "regex",     "state": "disabled", "target": {"scope": "character", "name": "某条原版正则"}}
    {"kind": "script",    "state": "disabled", "target": {"scope": "character", "name": "某个原版脚本"}}
  state 为 "enabled" 或 "disabled"；世界书目标至少给 uid 或 name，正则与脚本目标至少给 id 或 name。

原版冲突声明（世界书或脚本 artifact.json → "original_conflicts"）
  [{"action": "disable", "target": {"uid": "123", "name": "原版条目名"}}]
  action 为 "disable" 或 "replace"；脚本的 target 还要写 "scope"（character / preset / global）与 id 或 name。

脚本 artifact
  "scope"   "character" 角色脚本（默认）、"preset" 预设脚本、"global" 全局脚本
  content 可以是一个脚本，也可以是数组，里面放多个脚本或文件夹：
    {"type": "folder", "name": "文件夹名", "icon": "fa-solid fa-folder", "color": "", "scripts": [ 脚本, 脚本 ]}
  脚本的 "button": {"enabled": true, "buttons": [{"name": "按钮名", "visible": true}]}，
  脚本里用 eventOn(getButtonEvent('按钮名'), 回调) 响应点击。
  format 也可以是 "text"：content 直接是 JS 文字（解包后是 content.js）。

正则 artifact
  content 可以是一个正则，也可以是数组（示例里的“茶馆正则组”）。常用字段：
    "findRegex"      查找；写成 /…/g 带标志，或直接写文字
    "replaceString"  替换；$1 是第一个捕获组。整段写成 \`\`\`html … \`\`\` 时，酒馆助手会把它渲染成页面
    "placement"      作用于：1 用户输入，2 AI 输出，3 斜杠命令，5 世界书，6 推理
    "markdownOnly"   true = 只改显示，不改发给 AI 的内容
    "promptOnly"     true = 只改发给 AI 的内容，不改显示
    "minDepth" / "maxDepth"   只作用于倒数第几层到第几层（null 为不限）
  HTML 页面的写法要点：
    · 不要直接写 &amp; &#39; 这类 HTML 实体；脚本里需要时写成 '\\x26amp;'
    · 每一行的 " 与 * 个数要成对（属性值可以全用单引号）
    · 不要出现 $数字、$<、{{、\`\`\`、<user> 这类会被酒馆替换的写法
    · 页面文字不要被原版正则匹配，例如不要出现“【开局】”“【封面】”
    · iframe 高度按页面内容量取，不要用 scrollHeight 反复撑大（示例页面里的 fit 函数）

预设 artifact
  kind 为 "preset"、format 为 "json"，content 是酒馆导出的预设 JSON 对象；安装后出现在预设列表里。

数据 artifact
  kind 为 "data"：交给轮回战场本体读取的数据。角色包里含 kind 为 world_character 或 opening_partner 的数据时，
  该包的世界书条目会统一放在角色定义之后。一般扩展用不到。

限制
  离线包不超过 6 MB；artifact 最多 32 个；单个世界书最多 500 条；依赖最多 12 个；原版资源规则最多 300 条。
`;

// ---------- 命令行 ----------
function usage() {
  console.log(`rwkit · 轮回战场创意工坊离线包工具包

用法:
  node rwkit.mjs <命令> [选项] <文件或文件夹> ...

命令:
  fix       修复：重算大小与 SHA-256、同步清单、去 BOM 与多余逗号，并做导入与安装检查
  check     只检查，不写文件（等于 fix --check）
  unpack    解包：把 .rwpack 拆成可编辑的项目文件夹（世界书一条一个文件，脚本、页面单独成文件）
  pack      打包：把项目文件夹重新打成 .rwpack，自动生成清单并检查
  example   生成示例：在指定文件夹（默认当前文件夹）里生成“示例扩展”项目文件夹和打好的 .rwpack

选项:
  --bump        版本号 +1（fix 与 pack；pack 会写回 project.json）
  --out <路径>  输出到指定文件或文件夹（只能配合单个输入）
  --no-backup   覆盖已有 .rwpack 时不保留 .bak 备份
  --strict      有 ⚠ 提示也算失败（退出码 1）
  --check       fix 只检查不写文件

也可以把文件或文件夹拖到同目录的 .cmd 上：修复离线包、只检查不修改、修复并升版本号、解包、打包、打包并升版本号、生成示例。`);
}
function parseArgs(argv) {
  const opts = { check: false, bump: false, out: null, backup: true, strict: false }, inputs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--bump') opts.bump = true;
    else if (a === '--no-backup') opts.backup = false;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--out') opts.out = argv[++i];
    else inputs.push(a);
  }
  return { opts, inputs };
}
function packFiles(inputs) {
  const files = [];
  for (const p of inputs) {
    if (!fs.existsSync(p)) { console.log('✗ 找不到：' + p); continue; }
    if (fs.statSync(p).isDirectory()) files.push(...fs.readdirSync(p).filter(f => f.toLowerCase().endsWith('.rwpack')).sort(collate).map(f => path.join(p, f)));
    else files.push(p);
  }
  return files;
}
const errText = e => (e instanceof PackError ? e.message : (e.stack || e.message));
function cmdFix(opts, inputs) {
  const files = packFiles(inputs);
  if (!files.length) { console.log('没有要处理的 .rwpack 文件'); return 1; }
  if (opts.out && files.length !== 1) { console.log('✗ --out 只能配合单个输入文件'); return 1; }
  let bad = 0;
  for (const f of files) {
    console.log('\n■ ' + f);
    try {
      const r = fixFile(f, opts);
      console.log('  项目：' + r.project.name + ' v' + r.project.version + ' · ' + r.artifacts + ' 个 artifact · ' + (r.bytes / 1024).toFixed(1) + ' KB');
      for (const n of r.notes) console.log('  · ' + n);
      if (!r.needWrite) console.log('  ✓ 校验通过，无需修复');
      else if (opts.check) console.log('  △ 需要修复（--check 模式未写入）');
      else console.log('  ✓ 已修复并通过校验 → ' + r.target + (r.backup ? '（原文件备份为 ' + path.basename(r.backup) + '）' : ''));
      for (const e of r.errors) console.log('  ✗ 工坊安装时会失败：' + e);
      for (const w of r.warns) console.log('  ⚠ ' + w);
      if (r.errors.length || (r.warns.length && opts.strict) || (r.needWrite && opts.check)) bad++;
    } catch (e) { bad++; console.log('  ✗ ' + errText(e)); }
  }
  console.log('\n完成：' + files.length + ' 个文件，' + (files.length - bad) + ' 个正常' + (bad ? '，' + bad + ' 个有问题' : ''));
  return bad ? 1 : 0;
}
function cmdUnpack(opts, inputs) {
  const files = packFiles(inputs);
  if (!files.length) { console.log('没有要解包的 .rwpack 文件'); return 1; }
  if (opts.out && files.length !== 1) { console.log('✗ --out 只能配合单个输入文件'); return 1; }
  let bad = 0;
  for (const f of files) {
    console.log('\n■ ' + f);
    try {
      const r = unpackFile(f, opts);
      console.log('  项目：' + r.pack.project.name + ' v' + r.pack.project.version + ' · ' + r.pack.bundle.artifacts.length + ' 个 artifact');
      for (const n of r.notes) console.log('  · ' + n);
      console.log('  ✓ 已解包到 ' + r.dir + '（' + r.files + ' 个文件）');
    } catch (e) { bad++; console.log('  ✗ ' + errText(e)); }
  }
  console.log('\n完成：' + files.length + ' 个文件，' + (files.length - bad) + ' 个成功' + (bad ? '，' + bad + ' 个失败' : ''));
  return bad ? 1 : 0;
}
function reportPack(r, opts) {
  console.log('  项目：' + r.pack.project.name + ' v' + r.pack.project.version + ' · ' + r.folders.length + ' 个 artifact · ' + (r.size / 1024).toFixed(1) + ' KB');
  for (const n of r.notes) console.log('  · ' + n);
  console.log('  ✓ ' + (r.same ? '内容与已有文件相同，未改写 → ' : '已打包并通过校验 → ') + r.target + (r.bak ? '（原文件备份为 ' + path.basename(r.bak) + '）' : ''));
  for (const w of r.warns) console.log('  ⚠ ' + w);
  return r.warns.length && opts.strict ? 1 : 0;
}
function cmdPack(opts, inputs) {
  if (!inputs.length) { console.log('没有要打包的文件夹'); return 1; }
  const dirs = [];
  for (const p of inputs) {
    if (!fs.existsSync(p)) { console.log('✗ 找不到：' + p); continue; }
    try { dirs.push(...projectDirs(p)); } catch (e) { console.log('✗ ' + errText(e)); }
  }
  if (opts.out && dirs.length !== 1) { console.log('✗ --out 只能配合单个项目文件夹'); return 1; }
  let bad = dirs.length ? 0 : 1;
  for (const d of dirs) {
    console.log('\n■ ' + d);
    try { bad += reportPack(packDir(d, opts), opts); } catch (e) { bad++; console.log('  ✗ ' + errText(e)); }
  }
  console.log('\n完成：' + dirs.length + ' 个项目，' + (dirs.length - Math.min(bad, dirs.length)) + ' 个成功' + (bad ? '，' + bad + ' 个有问题' : ''));
  return bad ? 1 : 0;
}
function cmdExample(opts, inputs) {
  const dest = inputs[0] || process.cwd();
  if (!fs.existsSync(dest) || !fs.statSync(dest).isDirectory()) { console.log('✗ 找不到文件夹：' + dest); return 1; }
  try {
    const r = makeExample(dest, opts);
    console.log('\n■ 示例项目文件夹：' + r.dir);
    console.log('  内容：世界书 5 条（常驻、关键词、按深度插入、EJS 读取变量、停用）· 酒馆助手脚本按钮 · 3 条正则（聊天页面、文字美化、只改发给 AI 的内容）· 封面');
    console.log('  先看 _说明.txt 与 _更多写法参考.txt；改完把文件夹拖到“打包.cmd”上即可重新打包。');
    return reportPack(r, opts);
  } catch (e) { console.log('  ✗ ' + errText(e)); return 1; }
}
function main(argv) {
  const [cmd, ...rest] = argv;
  const { opts, inputs } = parseArgs(rest);
  switch (cmd) {
    case 'fix': return cmdFix(opts, inputs);
    case 'check': return cmdFix({ ...opts, check: true }, inputs);
    case 'unpack': return cmdUnpack(opts, inputs);
    case 'pack': return cmdPack(opts, inputs);
    case 'example': return cmdExample(opts, inputs);
    case undefined: case 'help': case '-h': case '--help': usage(); return cmd ? 0 : 1;
    default: console.log('不认识的命令：' + cmd + '\n'); usage(); return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
