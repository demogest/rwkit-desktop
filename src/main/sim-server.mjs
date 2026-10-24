// 模拟酒馆的“服务器”：为官方 SillyTavern 前端提供它需要的接口与文件，数据放在与 SillyTavern 相同结构的文件夹里。
// 只实现预览需要的部分（设置、角色、聊天、世界书、扩展清单等），不需要 Node 服务器与 npm 依赖。
// 输入输出都是标准的 Request / Response，与 Electron 无关，可单独测试。
import fs from 'node:fs';
import path from 'node:path';
import { itemsOf } from './core.mjs';

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webm': 'video/webm', '.mp4': 'video/mp4',
};
// 与 SillyTavern 的用户文件夹结构相同（default-user）
const DIRS = {
  worlds: 'worlds', avatars: 'User Avatars', characters: 'characters', chats: 'chats', groups: 'groups', groupChats: 'group chats', backgrounds: 'backgrounds',
  openAI_Settings: 'OpenAI Settings', themes: 'themes', movingUI: 'movingUI', instruct: 'instruct', context: 'context', sysprompt: 'sysprompt', reasoning: 'reasoning',
  quickreplies: 'QuickReplies', userImages: 'user/images', files: 'user/files',
};
const CONTENT_DIR = { settings: '', theme: 'themes', openai_preset: 'OpenAI Settings', context: 'context', instruct: 'instruct', sysprompt: 'sysprompt', reasoning: 'reasoning', avatar: 'User Avatars', moving_ui: 'movingUI', quick_replies: 'QuickReplies' };
export const TH_DIR = 'JS-Slash-Runner';
// 随附的第三方扩展（放在用户扩展的位置）：酒馆助手、提示词模板（执行世界书与提示词里的 EJS）→ 运行文件夹里的子文件夹
const EXTENSIONS = { [TH_DIR]: 'th', 'ST-Prompt-Template': 'pt' };
// 与预览无关的内置扩展：生图、语音、翻译、向量、表情、图库、总结、资源下载、附件
const OFF_EXTENSIONS = ['stable-diffusion', 'tts', 'translate', 'vectors', 'caption', 'expressions', 'gallery', 'memory', 'assets', 'attachments'];

// 作品里的正则：能直接写出来的触发文字（例如【魅魔开局】、<天关执法>…</天关执法>），用来一键插入消息查看页面
export function triggersOf(pack) {
  const out = [];
  for (const a of pack?.bundle?.artifacts || []) {
    if (a?.kind !== 'regex') continue;
    // 正则的各种保存格式由 itemsOf 统一读取（与编辑页相同）
    for (const it of itemsOf(a)) {
      const find = String(it.sum?.find || '');
      if (!find || it.sum?.disabled) continue;
      const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(find);
      let text = null;
      if (!m) text = find;
      else {
        const src = m[1];
        if (!/[\\[\](){}*+?.|^$]/.test(src.replace(/\\\//g, ''))) text = src.replace(/\\\//g, '/');
        else { const t = /^<([^<>\s/]+)>\(\[\\s\\S\]\*\?\)<\\?\/\1>$/.exec(src); if (t) text = `<${t[1]}>\n\n</${t[1]}>`; }
      }
      if (text) out.push({ name: it.label, text, page: !!it.sum?.page });
    }
  }
  return out;
}

// ---------- PNG 角色卡 ----------
export function readCardPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 图片');
  const text = {};
  for (let off = 8; off + 8 <= buf.length;) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'tEXt') { const d = buf.subarray(off + 8, off + 8 + len), z = d.indexOf(0); text[d.toString('latin1', 0, z).toLowerCase()] = d.toString('latin1', z + 1); }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = text.ccv3 || text.chara;
  if (!raw) throw new Error('这张图片里没有角色卡数据');
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}
// 与 SillyTavern 导入角色卡时相同：V2/V3 的 data 字段同时放到顶层
function normalizeCard(card) {
  const d = isObj(card.data) ? card.data : card;
  const out = { ...card, data: { ...d } };
  for (const k of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'tags']) if (d[k] !== undefined) out[k] = d[k];
  out.creatorcomment = d.creator_notes ?? card.creatorcomment ?? '';
  out.talkativeness = d.extensions?.talkativeness ?? card.talkativeness ?? 0.5;
  out.fav = d.extensions?.fav ?? card.fav ?? false;
  out.spec = card.spec || 'chara_card_v2';
  out.spec_version = card.spec_version || '2.0';
  out.data.extensions = isObj(d.extensions) ? { ...d.extensions } : {};
  return out;
}
const stamp = (d = new Date()) => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}@${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}s`;
};
// 文件名：酒馆页面里运行的是角色卡与作品的脚本，传来的名字一律当作不可信，不能带路径
const safeName = s => { const n = String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim().slice(0, 100); return !n || /^\.+$/.test(n) ? '_' : n; };
const avatarName = a => safeName(path.basename(String(a || '').replace(/\\/g, '/')).replace(/\.png$/i, '')) + '.png';

export function createServer({ vendorDir, dataDir, log = () => {}, version = {}, hooks = {} }) {
  const pub = path.join(vendorDir, 'st', 'public');
  const user = path.join(dataDir, 'default-user');
  const dir = k => path.join(user, DIRS[k]);
  const unknown = new Set();

  // ---------- 数据文件夹 ----------
  function seed() {
    if (fs.existsSync(path.join(user, 'settings.json'))) return;
    for (const k of Object.keys(DIRS)) fs.mkdirSync(dir(k), { recursive: true });
    const index = JSON.parse(fs.readFileSync(path.join(vendorDir, 'st', 'default', 'index.json'), 'utf8'));
    for (const x of index) {
      const to = CONTENT_DIR[x.type];
      if (to == null) continue;
      const target = path.join(user, to, to ? path.basename(x.filename) : 'settings.json');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(vendorDir, 'st', 'default', x.filename), target);
    }
    const s = readSettings();
    // 不显示首次运行的欢迎向导（语言默认简体中文，见 index()）
    s.firstRun = false;
    s.username = s.username || 'User';
    s.user_avatar = 'user-default.png';
    s.main_api = 'openai';
    s.power_user = { ...(s.power_user || {}), auto_load_chat: true, auto_connect: true };
    // 回复由 rwkit 生成（右侧面板里选择 AI 接口）：使用“自定义（兼容 OpenAI）”来源，地址只是占位
    s.oai_settings = { ...(s.oai_settings || {}), chat_completion_source: 'custom', custom_url: 'http://rwkit.sim/v1', custom_model: 'rwkit', stream_openai: true };
    // 与预览无关、启动时会请求未模拟接口的内置扩展默认关闭（可以在酒馆的扩展页里打开）
    const ext = s.extension_settings ||= {};
    ext.disabledExtensions = [...new Set([...(ext.disabledExtensions || []), ...OFF_EXTENSIONS])];
    writeSettings(s);
  }
  const readSettings = () => JSON.parse(fs.readFileSync(path.join(user, 'settings.json'), 'utf8'));
  const writeSettings = s => fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify(s, null, 4));
  const readJsonDir = d => { try { return fs.readdirSync(d).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))); } catch { return []; } };
  const presetDir = d => { const files = (() => { try { return fs.readdirSync(d).filter(f => f.endsWith('.json')).sort(); } catch { return []; } })(); return { fileContents: files.map(f => fs.readFileSync(path.join(d, f), 'utf8')), fileNames: files.map(f => f.replace(/\.json$/, '')) }; };

  // 角色：图片在 characters/名称.png，卡片数据另存在同名 .json（编辑时只改 JSON）
  const cardFile = avatar => path.join(dir('characters'), avatarName(avatar).slice(0, -4) + '.json');
  function characters() {
    let files = [];
    try { files = fs.readdirSync(dir('characters')).filter(f => f.endsWith('.png') && fs.existsSync(cardFile(f))); } catch {}
    return files.map(f => character(f)).filter(Boolean);
  }
  function character(avatar) {
    avatar = avatarName(avatar);
    let card;
    try { card = JSON.parse(fs.readFileSync(cardFile(avatar), 'utf8')); } catch { return null; }
    const st = fs.statSync(path.join(dir('characters'), avatar));
    const chats = chatList(avatar);
    return { ...card, avatar, json_data: JSON.stringify(card), date_added: st.ctimeMs, create_date: card.create_date || new Date(st.ctimeMs).toISOString(), chat_size: chats.reduce((n, c) => n + c.size, 0), date_last_chat: chats.reduce((n, c) => Math.max(n, c.mtime), 0), data_size: 0 };
  }
  const saveCard = (avatar, card) => { const { avatar: _a, json_data: _j, date_added: _d, chat_size: _c, date_last_chat: _l, data_size: _s, ...rest } = card; fs.writeFileSync(cardFile(avatar), JSON.stringify(rest)); };
  // 导入角色卡（在酒馆里点“导入角色”）：PNG 或 JSON；重新导入同一张卡时 preserved_name 指定要覆盖的文件
  async function importCard(f) {
    seed();
    const up = f.get('avatar'), type = String(f.get('file_type') || 'png').toLowerCase();
    if (!up || typeof up.arrayBuffer !== 'function') throw new Error('没有收到文件');
    const buf = Buffer.from(await up.arrayBuffer());
    let card, png;
    if (type === 'png') { card = readCardPng(buf); png = buf; }
    else if (type === 'json') { card = JSON.parse(buf.toString('utf8')); png = fs.readFileSync(path.join(pub, 'img', 'ai4.png')); }
    else throw new Error('模拟酒馆只支持导入 PNG 与 JSON 角色卡');
    card = normalizeCard(card);
    if (!card.name) throw new Error('角色卡没有名称');
    const keep = safeName(String(f.get('preserved_name') || '').replace(/\.png$/i, ''));
    let base = f.get('preserved_name') ? keep : safeName(card.name);
    if (!f.get('preserved_name')) for (let i = 1; fs.existsSync(path.join(dir('characters'), base + '.png')); i++) base = safeName(card.name) + i;
    const avatar = base + '.png';
    const prev = fs.existsSync(cardFile(avatar)) ? JSON.parse(fs.readFileSync(cardFile(avatar), 'utf8')) : null;
    card.chat = prev?.chat || `${card.name} - ${stamp()}`;
    card.create_date = prev?.create_date || new Date().toISOString();
    fs.writeFileSync(path.join(dir('characters'), avatar), png);
    saveCard(avatar, card);
    return base;
  }

  // ---------- 聊天（jsonl：第一行是聊天信息，之后每行一条消息） ----------
  const chatDir = avatar => path.join(dir('chats'), avatarName(avatar).slice(0, -4));
  function chatList(avatar) {
    const d = chatDir(avatar);
    try { return fs.readdirSync(d).filter(f => f.endsWith('.jsonl')).map(f => { const st = fs.statSync(path.join(d, f)); return { file: f, size: st.size, mtime: st.mtimeMs }; }); } catch { return []; }
  }
  const readChat = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return null; } };

  // ---------- 文件 ----------
  const inside = (root, p) => { const r = path.resolve(root, '.' + path.sep + p); return r === root || r.startsWith(root + path.sep) ? r : null; };
  async function file(p, extra = {}) {
    try {
      const st = await fs.promises.stat(p);
      if (!st.isFile()) return null;
      return new Response(await fs.promises.readFile(p), { headers: { 'content-type': TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache', ...extra } });
    } catch { return null; }
  }
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  const ok = () => json({ ok: true });
  // 首页：第一次打开时默认用简体中文
  async function index() {
    let html = await fs.promises.readFile(path.join(pub, 'index.html'), 'utf8');
    const boot = `<script>try{if(!localStorage.getItem('language'))localStorage.setItem('language','zh-cn')}catch(e){}</script>`;
    html = html.replace(/<head>/i, m => m + boot);
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
  }
  function systemExtensions() {
    try { return fs.readdirSync(path.join(pub, 'scripts', 'extensions'), { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== 'third-party').map(e => ({ type: 'system', name: e.name })); } catch { return []; }
  }

  // ---------- 接口 ----------
  const api = {
    'GET /csrf-token': () => json({ token: 'rwkit-sim' }),
    'GET /version': () => json({ agent: `SillyTavern:${version.sillytavern}:rwkit`, pkgVersion: version.sillytavern, gitRevision: 'rwkit-sim', gitBranch: 'release', commitDate: null, isLatest: true }),
    'GET /api/ping': () => new Response(null, { status: 204 }),
    'POST /api/ping': () => new Response(null, { status: 204 }),
    'POST /api/users/me': () => json({ handle: 'default-user', name: 'User', avatar: '/img/default-user.png', admin: true, password: false, created: 0 }),
    'GET /api/extensions/discover': () => json([...systemExtensions(), ...Object.keys(EXTENSIONS).filter(n => fs.existsSync(path.join(vendorDir, EXTENSIONS[n], 'manifest.json'))).map(n => ({ type: 'local', name: 'third-party/' + n }))]),
    'POST /api/extensions/version': () => json({ currentBranchName: 'release', currentCommitHash: '', isUpToDate: true, remoteUrl: '' }),
    'POST /api/secrets/read': () => json({}),
    'POST /api/secrets/settings': () => json({ allowKeysExposure: false }),
    'POST /api/settings/get': () => {
      seed();
      const oai = presetDir(dir('openAI_Settings'));
      return json({
        settings: fs.readFileSync(path.join(user, 'settings.json'), 'utf8'),
        koboldai_settings: [], koboldai_setting_names: [], novelai_settings: [], novelai_setting_names: [], textgenerationwebui_presets: [], textgenerationwebui_preset_names: [],
        openai_settings: oai.fileContents, openai_setting_names: oai.fileNames,
        world_names: (() => { try { return fs.readdirSync(dir('worlds')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort(); } catch { return []; } })(),
        themes: readJsonDir(dir('themes')), movingUIPresets: readJsonDir(dir('movingUI')), quickReplyPresets: readJsonDir(dir('quickreplies')),
        instruct: readJsonDir(dir('instruct')), context: readJsonDir(dir('context')), sysprompt: readJsonDir(dir('sysprompt')), reasoning: readJsonDir(dir('reasoning')),
        enable_extensions: true, enable_extensions_auto_update: false, enable_accounts: false, request_compression: { enabled: false, minPayloadSize: 0, maxPayloadSize: 0, timeout: 0 },
      });
    },
    'POST /api/settings/save': async req => { const s = await req.json(); writeSettings(s); hooks.settingsSaved?.(s); return ok(); },
    'POST /api/settings/get-snapshots': () => json([]),
    'POST /api/characters/all': () => json(characters()),
    'POST /api/characters/import': async req => { try { return json({ file_name: await importCard(await req.formData()) }); } catch (e) { log('模拟酒馆：导入角色卡失败：' + e.message); return json({ error: true, message: e.message }); } },
    'POST /api/characters/delete': async req => {
      const b = await req.json();
      const avatar = avatarName(b.avatar_url);
      fs.rmSync(path.join(dir('characters'), avatar), { force: true });
      fs.rmSync(cardFile(avatar), { force: true });
      if (b.delete_chats == true) fs.rmSync(chatDir(avatar), { recursive: true, force: true });
      return ok();
    },
    'POST /api/characters/get': async req => { const b = await req.json(); const c = character(String(b.avatar_url || '')); return c ? json(c) : new Response(null, { status: 404 }); },
    'POST /api/characters/chats': async req => {
      const b = await req.json();
      const list = chatList(b.avatar_url).map(c => {
        const rows = b.simple ? null : readChat(path.join(chatDir(b.avatar_url), c.file)) || [];
        const last = rows?.at(-1);
        return { file_name: c.file, file_size: `${(c.size / 1024).toFixed(2)}kb`, chat_items: rows ? Math.max(0, rows.length - 1) : 0, mes: last?.mes || '', last_mes: c.mtime };
      });
      return json(list);
    },
    // 只改卡片数据里给出的字段（酒馆助手保存脚本与角色变量时用）
    'POST /api/characters/merge-attributes': async req => {
      const b = await req.json();
      const avatar = avatarName(b.avatar);
      const c = character(avatar);
      if (!c) return json({ error: 'not found' }, 404);
      const merge = (t, s) => { for (const [k, v] of Object.entries(s)) { if (isObj(v) && isObj(t[k])) merge(t[k], v); else t[k] = v; } return t; };
      const { avatar: _a, json_data: _j, ...patch } = b;
      merge(c, patch);
      if (isObj(patch.data)) for (const k of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example']) if (patch.data[k] !== undefined) c[k] = patch.data[k];
      saveCard(avatar, c);
      return ok();
    },
    // 角色编辑表单：只处理预览会用到的字段
    'POST /api/characters/edit': async req => {
      const f = await req.formData();
      const avatar = avatarName(f.get('avatar_url'));
      const c = character(avatar);
      if (!c) return json({ error: 'not found' }, 404);
      const map = { ch_name: 'name', description: 'description', personality: 'personality', scenario: 'scenario', first_mes: 'first_mes', mes_example: 'mes_example', chat: 'chat', create_date: 'create_date' };
      for (const [k, to] of Object.entries(map)) if (f.has(k)) { c[to] = String(f.get(k)); if (to !== 'chat' && to !== 'create_date') c.data[to === 'name' ? 'name' : to] = c[to]; }
      if (f.has('world')) c.data.extensions.world = String(f.get('world'));
      if (f.has('extensions')) try { c.data.extensions = { ...c.data.extensions, ...JSON.parse(String(f.get('extensions'))) }; } catch {}
      saveCard(avatar, c);
      return new Response('ok');
    },
    'POST /api/chats/get': async req => {
      const b = await req.json();
      const d = chatDir(b.avatar_url);
      fs.mkdirSync(d, { recursive: true });
      if (!b.file_name) return json({});
      return json(readChat(path.join(d, safeName(b.file_name) + '.jsonl')) || {});
    },
    'POST /api/chats/save': async req => {
      const b = await req.json();
      if (!Array.isArray(b.chat)) return json({ error: 'The request\'s body.chat is not an array.' }, 400);
      const d = chatDir(b.avatar_url);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, safeName(b.file_name) + '.jsonl'), b.chat.map(x => JSON.stringify(x)).join('\n'));
      hooks.chatSaved?.(b);
      return ok();
    },
    'POST /api/chats/delete': async req => { const b = await req.json(); fs.rmSync(path.join(chatDir(b.avatar_url), safeName(String(b.chatfile || '').replace(/\.jsonl$/, '')) + '.jsonl'), { force: true }); return ok(); },
    'POST /api/chats/rename': async req => {
      const b = await req.json();
      const d = chatDir(b.avatar_url), from = path.join(d, safeName(String(b.original_file).replace(/\.jsonl$/, '')) + '.jsonl'), to = safeName(String(b.renamed_file).replace(/\.jsonl$/, ''));
      fs.renameSync(from, path.join(d, to + '.jsonl'));
      return json({ ok: true, sanitizedFileName: to });
    },
    'POST /api/chats/search': () => json([]),
    'POST /api/chats/recent': () => json([]),
    // 不存在的世界书返回空的世界书（与 SillyTavern 相同）
    'POST /api/worldinfo/get': async req => { const b = await req.json(); if (!b.name) return new Response(null, { status: 400 }); try { return json(JSON.parse(fs.readFileSync(path.join(dir('worlds'), safeName(b.name) + '.json'), 'utf8'))); } catch { return json({ entries: {} }); } },
    'POST /api/worldinfo/list': () => {
      let files = [];
      try { files = fs.readdirSync(dir('worlds')).filter(f => f.toLowerCase().endsWith('.json')).sort((a, b) => a.localeCompare(b)); } catch {}
      return json(files.map(f => { let d = {}; try { d = JSON.parse(fs.readFileSync(path.join(dir('worlds'), f), 'utf8')) || {}; } catch {} const id = f.slice(0, -5); return { file_id: id, name: d.name || id, extensions: isObj(d.extensions) ? d.extensions : {} }; }));
    },
    'POST /api/worldinfo/edit': async req => { const b = await req.json(); if (!b.name || !isObj(b.data)) return json({ error: 'bad request' }, 400); fs.writeFileSync(path.join(dir('worlds'), safeName(b.name) + '.json'), JSON.stringify(b.data)); return ok(); },
    'POST /api/worldinfo/import': async req => {
      const f = await req.formData(), up = f.get('avatar');
      const text = f.get('convertedData') ? String(f.get('convertedData')) : Buffer.from(await up.arrayBuffer()).toString('utf8');
      const data = JSON.parse(text);
      if (!isObj(data.entries)) return new Response('Is not a valid world info file', { status: 400 });
      const name = safeName(path.parse(String(up?.name || 'world')).name);
      fs.writeFileSync(path.join(dir('worlds'), name + '.json'), JSON.stringify(data));
      return json({ name });
    },
    'POST /api/worldinfo/delete': async req => { const b = await req.json(); fs.rmSync(path.join(dir('worlds'), safeName(b.name) + '.json'), { force: true }); return ok(); },
    'POST /api/groups/all': () => json([]),
    'POST /api/avatars/get': () => json((() => { try { return fs.readdirSync(dir('avatars')).filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f)); } catch { return []; } })()),
    'POST /api/backgrounds/all': () => json({ images: [], config: { width: 160, height: 90 } }),
    'POST /api/backgrounds/folders': () => json({ folders: [] }),
    'POST /api/themes/save': () => ok(),
    'POST /api/moving-ui/save': () => ok(),
    'POST /api/quick-replies/save': () => ok(),
    'POST /api/presets/save': async req => { const b = await req.json().catch(() => ({})); return json({ name: b.name }); },
    'POST /api/presets/restore': () => json({ isDefault: false, preset: {} }),
    'POST /api/sprites/get': () => json([]),
    'POST /api/files/sanitize-filename': async req => { const b = await req.json(); return json({ fileName: safeName(b.fileName) }); },
    'POST /api/assets/get': () => json({}),
    'POST /api/stats/get': () => json({}),
    'POST /api/stats/update': () => ok(),
    'POST /api/image-metadata/all': () => json({}),
    'POST /api/backends/chat-completions/status': () => json({ data: [{ id: 'rwkit' }] }),
    // 生成回复：交给 rwkit（hooks.generate）用你在面板里选择的 AI 接口生成
    'POST /api/backends/chat-completions/generate': async req => (hooks.generate ? hooks.generate(await req.json(), req.signal) : json({ error: { message: '模拟酒馆没有连接 AI 接口' } }, 400)),
  };
  // 统计 token 的接口：粗略按字数估算（只影响上下文长度提示）
  const tokenCount = async req => { const b = await req.json().catch(() => null); const text = JSON.stringify(b ?? ''); return json({ token_count: Math.ceil(text.length / 2), count: Math.ceil(text.length / 2), ids: [], chunks: [] }); };

  async function handle(req) {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname);
    const key = `${req.method} ${p}`;
    try {
      if (hooks.route) { const r = await hooks.route(req, p); if (r) return r; }
      if (api[key]) return await api[key](req);
      if (/^\/api\/tokenizers\//.test(p)) return await tokenCount(req);
      if (p === '/' || p === '/index.html') return await index();
      if (p === '/lib.js' || p === '/lib.js.LICENSE.txt') return await file(path.join(vendorDir, 'st', p.slice(1))) || new Response(null, { status: 404 });
      if (p === '/css/user.css') return new Response('', { headers: { 'content-type': 'text/css' } });
      if (p === '/thumbnail') {
        const type = u.searchParams.get('type'), f = u.searchParams.get('file') || '';
        const base = type === 'bg' ? dir('backgrounds') : type === 'persona' ? dir('avatars') : dir('characters');
        const target = inside(base, f);
        return (target && await file(target)) || await file(path.join(pub, 'img', 'ai4.png')) || new Response(null, { status: 404 });
      }
      // 随附的第三方扩展
      const ext = /^\/scripts\/extensions\/third-party\/([^/]+)(\/.*)$/.exec(p);
      if (ext && Object.hasOwn(EXTENSIONS, ext[1])) { const t = inside(path.join(vendorDir, EXTENSIONS[ext[1]]), ext[2]); return (t && await file(t)) || new Response(null, { status: 404 }); }
      // 用户数据里的图片
      for (const [prefix, k] of [['/characters/', 'characters'], ['/User Avatars/', 'avatars'], ['/backgrounds/', 'backgrounds'], ['/user/images/', 'userImages'], ['/user/files/', 'files']]) {
        if (p.startsWith(prefix)) { const t = inside(dir(k), p.slice(prefix.length)); return (t && await file(t)) || new Response(null, { status: 404 }); }
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const t = inside(pub, p);
        const r = t && await file(t);
        if (r) return r;
        return new Response(null, { status: 404 });
      }
      if (!unknown.has(key)) { unknown.add(key); log('模拟酒馆：未实现的接口 ' + key); }
      return json({});
    } catch (e) {
      log('模拟酒馆：处理 ' + key + ' 出错：' + (e.stack || e));
      return json({ error: String(e.message || e) }, 500);
    }
  }
  return { handle, seed, readSettings, writeSettings, character, characters, chatDir, readChat, user, unknown };
}
