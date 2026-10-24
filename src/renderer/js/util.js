// 界面通用工具：转义、图标、格式化、提示、弹窗、下拉菜单

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
export function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v) ?? 'null';
}
export const samePath = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const baseName = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export const KIND = { worldbook: '世界书', regex: '正则', script: '脚本', preset: '预设', data: '数据' };
export const KIND_ICON = { worldbook: 'book', regex: 'regex', script: 'fileCode', preset: 'sliders', data: 'database' };
export const CAT = { extension: '扩展', character: '角色', store_catalog: '开局商店', scenario: '副本' };
// 工坊的四种分类（扩展 / 角色 / 开局商店 / 副本）与角色的用途；开局商店与副本在服务器上属于 extension，由内容里的数据决定（副本优先）
export const KIND_LABEL = { extension: '扩展', store_catalog: '开局商店', scenario: '副本', world_character: '世界书角色', opening_character: '开局角色', opening_partner: '开局伙伴', heretic: '异端' };
export const displayCat = (category, kind) => (category === 'character' ? 'character' : kind === 'scenario' ? 'scenario' : kind === 'store_catalog' ? 'store_catalog' : 'extension');
export function catLabel(category, kind) {
  const d = displayCat(category, kind);
  return d === 'character' ? '角色' + (kind && kind !== 'world_character' && KIND_LABEL[kind] ? ' · ' + KIND_LABEL[kind] : '') : CAT[d];
}
// 字数上限：输入框带 data-max，旁边的计数随输入更新（见 app.js）
export const counter = (v, max) => { const n = String(v ?? '').trim().length; return `<span class="cnt${n > max ? ' over' : ''}" data-cnt data-max-of="${max}">${n} / ${max}</span>`; };
export const LV = { ok: { t: '正常', i: 'checkCircle' }, warn: { t: '有提示', i: 'alert' }, fix: { t: '需修复', i: 'wrench' }, error: { t: '有错误', i: 'xCircle' } };
export const POS = { 0: '角色定义之前', 1: '角色定义之后', 2: '作者注释之前', 3: '作者注释之后', 4: '按深度插入', 5: '示例消息之前', 6: '示例消息之后', 7: '出口（outlet）' };
export const ROLE = { 0: '系统', 1: '用户', 2: 'AI' };
export const PLACE = { 1: '用户输入', 2: 'AI 输出', 3: '斜杠命令', 5: '世界书', 6: '推理' };
export const LOGIC = { 0: '与任一（AND ANY）', 1: '非全部（NOT ALL）', 2: '非任一（NOT ANY）', 3: '与全部（AND ALL）' };
export const SCOPE = { character: '角色脚本', preset: '预设脚本', global: '全局脚本' };
export const MAX_BYTES = 6 * 1024 * 1024;

export function fmtSize(n) { if (n == null) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB'; return (n / 1048576).toFixed(2) + ' MB'; }
export function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date(), pad = x => String(x).padStart(2, '0'), hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 864e5);
  if (diff === 0) return '今天 ' + hm;
  if (diff === 1) return '昨天 ' + hm;
  if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}
export function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) % 360; return h; }

// ---------- 图标（线框风格，24×24） ----------
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  folderOpen: '<path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>',
  folderPlus: '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  package: '<path d="M16.5 9.4 7.55 4.24"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  xCircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  compare: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>',
  unpack: '<path d="M2 7.5V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"/><path d="M2 13h10"/><path d="m9 10 3 3-3 3"/>',
  pack: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  duplicate: '<path d="M15 12v6"/><path d="M12 15h6"/><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  chevRight: '<path d="m9 18 6-6-6-6"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/>',
  filePlus: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/>',
  fileCode: '<path d="M10 12.5 8 15l2 2.5"/><path d="m14 12.5 2 2.5-2 2.5"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  regex: '<path d="M17 3v10"/><path d="m12.67 5.5 8.66 5"/><path d="m12.67 10.5 8.66-5"/><path d="M9 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2z"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  panel: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  flask: '<path d="M10 2v7.31"/><path d="M14 9.3V1.99"/><path d="M8.5 2h7"/><path d="M14 9.3a6.5 6.5 0 1 1-4 0"/><path d="M5.52 16h12.96"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor"/>',
  tavern: '<path d="M17 11h1a3 3 0 0 1 0 6h-1"/><path d="M9 12v6"/><path d="M13 12v6"/><path d="M14 7.5c-1 0-1.44.5-3 .5s-2-.5-3-.5-1.72.5-2.5.5a2.5 2.5 0 0 1 0-5c.78 0 1.57.5 2.5.5S9.44 2 11 2s2 1.5 3 1.5 1.72-.5 2.5-.5a2.5 2.5 0 0 1 0 5c-.78 0-1.5-.5-2.5-.5Z"/><path d="M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  star: '<path d="M11.52 2.3a.53.53 0 0 1 .95 0l2.31 4.68a2.12 2.12 0 0 0 1.6 1.16l5.16.76a.53.53 0 0 1 .3.9l-3.74 3.64a2.12 2.12 0 0 0-.61 1.88l.88 5.14a.53.53 0 0 1-.77.56l-4.62-2.43a2.12 2.12 0 0 0-1.97 0L6.4 21.01a.53.53 0 0 1-.77-.56l.88-5.13a2.12 2.12 0 0 0-.61-1.88L2.16 9.8a.53.53 0 0 1 .29-.9l5.17-.76a2.12 2.12 0 0 0 1.6-1.16z"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  logOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  cloudUp: '<path d="M12 13v8"/><path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="m8 17 4-4 4 4"/>',
  eyeOff: '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="m2 2 20 20"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  unlink: '<path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/><path d="M8 2v3M2 8h3M16 22v-3M22 16h-3"/>',
  discord: '<path fill="currentColor" stroke="none" d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.87-.61 1.25a18.27 18.27 0 0 0-5.49 0 12.64 12.64 0 0 0-.62-1.25.08.08 0 0 0-.08-.04 19.74 19.74 0 0 0-4.88 1.52.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.05 19.9 19.9 0 0 0 6 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.23-1.99a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.89.08.08 0 0 1-.01-.13c.13-.09.25-.19.37-.29a.07.07 0 0 1 .08-.01c3.93 1.79 8.18 1.79 12.06 0a.07.07 0 0 1 .08.01c.12.1.25.2.37.29a.08.08 0 0 1-.01.13c-.6.35-1.22.65-1.87.89a.08.08 0 0 0-.04.11c.36.7.77 1.36 1.22 1.99a.08.08 0 0 0 .09.03 19.84 19.84 0 0 0 6-3.03.08.08 0 0 0 .03-.06c.5-5.18-.84-9.67-3.55-13.66a.06.06 0 0 0-.03-.03ZM8.02 15.33c-1.18 0-2.16-1.09-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.33-.96 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.09-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.33-.95 2.42-2.16 2.42Z"/>',
};
export const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;
export function pill(level, text) { return `<span class="pill ${level}">${icon(LV[level]?.i || 'info')}${esc(text ?? LV[level]?.t)}</span>`; }
export function srcPill(s) {
  if (s.draft) return `<span class="pill draft">${icon('pencil')}未保存 ${s.draft.count}</span>`;
  if (s.level === 'error') return pill('error', s.fatal ? '错误' : s.errors.length + ' 个错误');
  if (s.level === 'fix') return pill('fix', '需修复');
  if (s.level === 'warn') return pill('warn', s.warns.length + ' 条提示');
  return pill('ok', '正常');
}

// ---------- 提示 ----------
export function toast(text, kind = 'info', ms = 3600) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = icon({ ok: 'checkCircle', warn: 'alert', error: 'xCircle', info: 'info' }[kind] || 'info') + `<div>${esc(text)}</div>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, ms);
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
  toast('已复制', 'ok', 1300);
}

// ---------- 弹窗 ----------
export const layers = [];
export function modal({ title, body = '', foot = '', cls = '', onClose, closable = true }) {
  const el = document.createElement('div');
  el.className = 'backdrop';
  el.innerHTML = `<div class="modal ${cls}" role="dialog" aria-modal="true">${title != null ? `<div class="modal-h"><div class="modal-t">${title}</div>${closable ? `<button class="btn ghost sm icon" data-m="close" title="关闭（Esc）">${icon('x')}</button>` : ''}</div>` : ''}<div class="modal-b">${body}</div>${foot ? `<div class="modal-f">${foot}</div>` : ''}</div>`;
  $('#layer').appendChild(el);
  const m = {
    el, box: el.firstElementChild, body: $('.modal-b', el), foot: $('.modal-f', el), closed: false, closable,
    close(v) { if (m.closed) return; m.closed = true; el.classList.add('out'); setTimeout(() => el.remove(), 120); layers.splice(layers.indexOf(m), 1); onClose && onClose(v); },
  };
  layers.push(m);
  el.addEventListener('mousedown', e => { if (e.target === el && closable) m.close(null); });
  el.addEventListener('click', e => { if (e.target.closest('[data-m="close"]')) m.close(null); });
  setTimeout(() => (m.box.querySelector('[autofocus]') || m.foot?.querySelector('.btn.primary') || m.box)?.focus?.(), 30);
  return m;
}
export function ask({ title, html, buttons, cls = '' }) {
  return new Promise(res => {
    const m = modal({ title: esc(title), body: html, cls, foot: `<div class="spacer"></div>` + buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}" data-b="${i}">${b.icon ? icon(b.icon) : ''}${esc(b.label)}</button>`).join(''), onClose: v => res(v) });
    m.foot.addEventListener('click', e => { const b = e.target.closest('[data-b]'); if (b) m.close(buttons[Number(b.dataset.b)].value); });
    m.body.addEventListener('click', e => { const c = e.target.closest('[data-pick]'); if (c) m.close(c.dataset.pick); });
  });
}
// 带输入框的弹窗：fields = [{ key, label, type: 'text'|'select'|'folder', value, options, hint }]
export function form({ title, intro = '', fields, okLabel = '确定', pickFolder, validate }) {
  return new Promise(res => {
    const vals = Object.fromEntries(fields.map(f => [f.key, f.value ?? '']));
    const fieldHtml = f => {
      if (f.type === 'select') return `<select class="input" data-k="${f.key}">${f.options.map(([v, t]) => `<option value="${esc(v)}" ${String(vals[f.key]) === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
      if (f.type === 'seg') return `<div class="seg" data-seg="${f.key}">${f.options.map(([v, t]) => `<button type="button" class="${String(vals[f.key]) === String(v) ? 'on' : ''}" data-v="${esc(v)}">${esc(t)}</button>`).join('')}</div>`;
      if (f.type === 'folder') return `<div class="row-input"><input class="input mono" data-k="${f.key}" value="${esc(vals[f.key])}" spellcheck="false"><button class="btn" type="button" data-pickf="${f.key}">${icon('folderOpen')}选择…</button></div>`;
      return `<input class="input" data-k="${f.key}" value="${esc(vals[f.key])}" ${f.autofocus ? 'autofocus' : ''} placeholder="${esc(f.placeholder || '')}" spellcheck="false">`;
    };
    const m = modal({
      title: esc(title),
      body: `${intro ? `<p class="lead">${intro}</p>` : ''}<div class="fgrid">${fields.map(f => `<label class="flabel">${esc(f.label)}</label><div class="fval">${fieldHtml(f)}${f.hint ? `<div class="fhint">${f.hint}</div>` : ''}</div>`).join('')}</div><div class="ferr" hidden></div>`,
      foot: `<div class="spacer"></div><button class="btn" data-m="close">取消</button><button class="btn primary" data-ok>${esc(okLabel)}</button>`,
      onClose: v => res(v),
    });
    const err = $('.ferr', m.el);
    m.el.addEventListener('input', e => { const k = e.target.dataset.k; if (k) vals[k] = e.target.value; });
    m.el.addEventListener('change', e => { const k = e.target.dataset.k; if (k) vals[k] = e.target.value; });
    m.el.addEventListener('click', async e => {
      const s = e.target.closest('[data-seg] button');
      if (s) { const k = s.parentElement.dataset.seg; vals[k] = s.dataset.v; $$('button', s.parentElement).forEach(b => b.classList.toggle('on', b === s)); return; }
      const pf = e.target.closest('[data-pickf]');
      if (pf && pickFolder) { const p = await pickFolder(vals[pf.dataset.pickf]); if (p) { vals[pf.dataset.pickf] = p; $(`[data-k="${pf.dataset.pickf}"]`, m.el).value = p; } return; }
      if (e.target.closest('[data-ok]')) {
        const msg = validate ? validate(vals) : null;
        if (msg) { err.hidden = false; err.textContent = msg; return; }
        m.close({ ...vals });
      }
    });
    m.el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); $('[data-ok]', m.el).click(); } });
  });
}

// ---------- 下拉菜单 ----------
let openMenu = null;
export function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
// items: [{ label, icon, onClick, danger, disabled, hint }] 或 '-' 分隔线、{ header }
export function menu(anchor, items, { align = 'left', width } = {}) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu';
  if (width) el.style.minWidth = width + 'px';
  el.innerHTML = items.map((it, i) => it === '-' ? '<div class="menu-sep"></div>' : it.header ? `<div class="menu-h">${esc(it.header)}</div>`
    : `<button class="menu-i ${it.danger ? 'danger' : ''} ${it.checked ? 'checked' : ''}" data-i="${i}" ${it.disabled ? 'disabled' : ''}>${it.icon ? icon(it.icon) : '<span class="i"></span>'}<span class="mt">${esc(it.label)}${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</span>${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}</button>`).join('');
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect(), mw = el.offsetWidth, mh = el.offsetHeight;
  let x = align === 'right' ? r.right - mw : r.left, y = r.bottom + 4;
  if (x + mw > innerWidth - 8) x = innerWidth - mw - 8;
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 4);
  el.style.left = Math.max(8, x) + 'px'; el.style.top = y + 'px';
  el.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (!b || b.disabled) return; const it = items[Number(b.dataset.i)]; closeMenu(); it.onClick?.(); });
  openMenu = el;
  return el;
}
document.addEventListener('mousedown', e => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
