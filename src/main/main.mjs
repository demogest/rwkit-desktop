// rwkit 桌面版主进程：窗口、IPC、系统对话框、单实例与 .rwpack 文件关联
import { app, BrowserWindow, ipcMain, dialog, shell, protocol, nativeTheme, Menu, screen, session, safeStorage, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from './core.mjs';
import * as workshop from './workshop.mjs';
import * as tavern from './tavern.mjs';
import * as updater from './updater.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const RENDERER = path.join(HERE, '..', 'renderer');
const APP_TITLE = 'rwkit 离线包工具';

app.setPath('userData', path.join(app.getPath('appData'), 'rwkit-desktop'));
// 开发自测：独立的数据文件夹、脚本化操作与截图
const AUTOTEST = !app.isPackaged && process.env.RWKIT_AUTOTEST;
if (!app.isPackaged && process.env.RWKIT_USERDATA) app.setPath('userData', process.env.RWKIT_USERDATA);
if (AUTOTEST) for (const s of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(s);
app.setAppUserModelId('com.rwkit.desktop');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

const LOG_FILE = path.join(app.getPath('userData'), 'main.log');
// 开发时同时输出到控制台；控制台管道关闭后（EPIPE）不再写，避免“写失败 → 记录异常 → 再写失败”的循环
let stdoutOk = !app.isPackaged;
process.stdout.on?.('error', () => { stdoutOk = false; });
function log(msg) {
  const line = new Date().toISOString() + ' ' + msg + '\n';
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line); } catch {}
  if (stdoutOk) { try { process.stdout.write(line); } catch { stdoutOk = false; } }
}
process.on('uncaughtException', e => { if (e?.code === 'EPIPE') { stdoutOk = false; return; } log('未处理的异常：' + (e.stack || e)); });
process.on('unhandledRejection', e => log('未处理的异常：' + (e?.stack || e)));

// 命令行或双击 .rwpack 传进来的路径
function argPaths(argv) {
  return argv.slice(app.isPackaged ? 1 : 2)
    .filter(a => a && !a.startsWith('-'))
    .map(a => path.resolve(a))
    .filter(a => { try { fs.statSync(a); return true; } catch { return false; } });
}

// rwkit.mjs 的位置：自定义 > 程序旁边 > 内置
const BUNDLED_RWKIT = app.isPackaged ? path.join(process.resourcesPath, 'rwkit.mjs') : path.join(ROOT, 'resources', 'rwkit.mjs');
function rwkitCandidates() {
  const s = core.getState().settings, list = [];
  if (s.rwkitPath) list.push({ file: s.rwkitPath, label: '自定义' });
  if (app.isPackaged) list.push({ file: path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath), 'rwkit.mjs'), label: '程序旁边' });
  list.push({ file: BUNDLED_RWKIT, bundled: true, label: '内置' });
  return list;
}

let win = null, quitting = false, closeAckTimer = null, pending = null;
const previews = new Map();
const send = (type, data) => { if (win && !win.isDestroyed()) win.webContents.send('evt', type, data); };

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    const paths = argPaths(argv);
    if (paths.length) openFromOutside(paths);
  });
  app.whenReady().then(start);
}

function openFromOutside(paths) {
  core.ensureRwkit().then(() => {
    const r = core.openPaths(paths);
    core.syncWatchers();
    send('opened', { select: r.opened.find(x => x.id)?.id || null, path: r.opened[0]?.path || null, errors: r.errors });
  });
}

const OVERLAY = { light: { color: '#ffffff', symbolColor: '#454b5c', height: 46 }, dark: { color: '#1a1d24', symbolColor: '#d6dae3', height: 46 } };
const overlay = () => OVERLAY[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
function applyTheme() {
  const t = core.getState().settings.theme;
  nativeTheme.themeSource = t === 'light' || t === 'dark' ? t : 'system';
}

function visibleBounds(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
  const ok = screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80;
  });
  return ok ? b : null;
}

async function start() {
  core.init({
    dataDir: app.getPath('userData'),
    rwkitCandidates,
    trash: p => shell.trashItem(p),
    emit: send,
    log,
  });
  // 创意工坊：登录凭据用系统加密（Windows 为 DPAPI）保存
  const canSeal = safeStorage.isEncryptionAvailable();
  workshop.init({
    dataDir: app.getPath('userData'),
    defaultDownloads: app.getPath('downloads'),
    appVersion: app.getVersion(),
    openExternal: url => (AUTOTEST && process.env.RWKIT_NO_EXTERNAL ? Promise.resolve(log('打开外部链接（自测时跳过）：' + url)) : shell.openExternal(url)),
    encrypt: canSeal ? t => safeStorage.encryptString(t).toString('base64') : null,
    decrypt: canSeal ? b => safeStorage.decryptString(Buffer.from(b, 'base64')) : null,
    // 发现页的封面原图常有几 MB，缩成卡片大小的 JPEG 再显示
    cacheDir: path.join(app.getPath('userData'), 'cache', 'covers'),
    thumb: (c, width) => {
      const img = nativeImage.createFromBuffer(c.buf);
      if (img.isEmpty() || img.getSize().width <= width) return c;
      return { type: 'image/jpeg', buf: img.resize({ width, quality: 'good' }).toJPEG(84) };
    },
    log,
    emit: send,
  });
  // 安装到 SillyTavern 的本机桥接服务（启用后才监听 127.0.0.1）
  tavern.init({ dataDir: app.getPath('userData'), log, emit: send });
  // 检查更新：安装版下载到临时文件夹后运行安装程序；免安装版把新版本放在当前 exe 旁边
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  updater.init({
    version: app.getVersion(),
    kind: !app.isPackaged ? (process.env.RWKIT_UPDATE_KIND || 'dev') : portableDir ? 'portable' : 'setup',
    dataDir: app.getPath('userData'),
    downloadDir: portableDir || path.join(app.getPath('temp'), 'rwkit-desktop-update'),
    ...(!app.isPackaged && process.env.RWKIT_UPDATE_API ? { api: process.env.RWKIT_UPDATE_API } : {}),
    log, emit: send,
  });
  applyTheme();
  await core.ensureRwkit();
  const initial = argPaths(process.argv);
  if (initial.length) {
    const r = core.openPaths(initial);
    pending = { select: r.opened.find(x => x.id)?.id || null, path: r.opened[0]?.path || null, errors: r.errors };
  }
  core.syncWatchers();
  core.startPolling(() => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());

  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'clipboard-sanitized-write'));

  protocol.handle('app', async req => {
    const u = new URL(req.url);
    try {
      if (u.host === 'ui') {
        const f = path.resolve(RENDERER, decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html');
        if (!f.startsWith(RENDERER + path.sep)) return new Response('forbidden', { status: 403 });
        const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8' }[path.extname(f)] || 'application/octet-stream';
        return new Response(await fs.promises.readFile(f), { headers: { 'content-type': type } });
      }
      if (u.host === 'cover') {
        await core.ensureRwkit();
        const c = core.coverOf(path.resolve(u.searchParams.get('p') || ''));
        if (!c) return new Response('', { status: 404 });
        return new Response(c.buf, { headers: { 'content-type': c.type, 'cache-control': 'max-age=86400' } });
      }
      if (u.host === 'wscover') {
        const c = await workshop.cover(decodeURIComponent(u.pathname.slice(1)), u.searchParams.get('own') === '1', u.searchParams.get('v') || '', Math.min(1600, Number(u.searchParams.get('w')) || 0));
        return new Response(c.buf, { headers: { 'content-type': c.type, 'cache-control': 'max-age=3600' } });
      }
      if (u.host === 'preview') {
        const html = previews.get(u.pathname.slice(1));
        if (html == null) return new Response('', { status: 404 });
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
    } catch (e) {
      // 工坊封面读不到（离线、没有封面）很常见，不逐条写日志
      if (u.host !== 'wscover') log('资源读取失败 ' + req.url + '：' + e.message);
    }
    return new Response('', { status: 404 });
  });

  ipcMain.handle('api', async (e, route, body = {}) => {
    if (!win || e.sender !== win.webContents) return { ok: false, error: '拒绝访问' };
    try { return await hostRoute(route, body); } catch (err) { log(err.stack || String(err)); return { ok: false, error: String(err.message || err) }; }
  });

  createWindow();
  nativeTheme.on('updated', () => { if (win && !win.isDestroyed()) { win.setTitleBarOverlay(overlay()); win.setBackgroundColor(overlay().color); } send('theme', { dark: nativeTheme.shouldUseDarkColors }); });
}

async function hostRoute(route, body) {
  switch (route) {
    case 'pick': {
      const k = body.kind;
      const opts = {
        packs: { title: '打开离线包', properties: ['openFile', 'multiSelections'], filters: [{ name: '轮回战场工坊离线包', extensions: ['rwpack'] }, { name: '所有文件', extensions: ['*'] }] },
        folders: { title: '打开项目文件夹（或装着离线包的文件夹）', properties: ['openDirectory', 'multiSelections'] },
        folder: { title: body.title || '选择文件夹', properties: ['openDirectory', 'createDirectory', 'promptToCreate'] },
        image: { title: '选择封面图', properties: ['openFile'], filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'svg'] }] },
        wsCover: { title: '选择工坊封面（PNG / JPEG / WebP，不超过 3 MB）', properties: ['openFile'], filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] },
        rwkit: { title: '选择 rwkit.mjs', properties: ['openFile'], filters: [{ name: 'rwkit.mjs', extensions: ['mjs', 'js'] }] },
      }[k];
      if (!opts) return { paths: [] };
      const r = await dialog.showOpenDialog(win, { ...opts, defaultPath: body.defaultPath || core.getState().lastDir || app.getPath('downloads') });
      return { paths: r.canceled ? [] : r.filePaths };
    }
    case 'reveal': shell.showItemInFolder(path.resolve(body.path)); return { ok: true };
    case 'openPath': { const err = await shell.openPath(path.resolve(body.path)); return err ? { ok: false, error: err } : { ok: true }; }
    case 'preview': {
      const id = crypto.randomUUID();
      previews.set(id, String(body.html || ''));
      while (previews.size > 8) previews.delete(previews.keys().next().value);
      return { url: 'app://preview/' + id };
    }
    case 'pending': { const p = pending; pending = null; return p || {}; }
    case 'appInfo': return { version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, userData: app.getPath('userData'), documents: app.getPath('documents'), packaged: app.isPackaged, portable: !!process.env.PORTABLE_EXECUTABLE_DIR, bundledRwkit: BUNDLED_RWKIT, dark: nativeTheme.shouldUseDarkColors };
    case 'closeAck': clearTimeout(closeAckTimer); return { ok: true };
    case 'quit': quitting = true; clearTimeout(closeAckTimer); setImmediate(() => win?.close()); return { ok: true };
    case 'devtools': win?.webContents.toggleDevTools(); return { ok: true };
    case 'settings': { const r = await core.handle('settings', body); applyTheme(); return r; }
    case 'ws.download': case 'ws.downloadOwn': {
      // 下载完成后按需直接在程序里打开
      await core.ensureRwkit();
      const r = await workshop.handle(route, body);
      if (!r.ok || !r.target || !body.open) return r;
      const o = core.openPaths([r.target]);
      core.syncWatchers();
      return { ...r, opened: o.opened, ...core.view() };
    }
    case 'up.install': {
      // 运行下载好的安装程序 / 新的免安装版，然后退出
      const file = updater.downloadedFile();
      if (!file || !fs.existsSync(file)) return { ok: false, error: '还没有下载新版本' };
      if (core.hasDrafts().length) return { ok: false, error: '还有未保存的修改，请先保存或放弃后再更新' };
      if (!app.isPackaged) { shell.showItemInFolder(file); return { ok: true, dev: true }; }
      // 先放开单实例锁：新的免安装版启动时本程序可能还没退出完
      app.releaseSingleInstanceLock();
      spawn(file, [], { detached: true, stdio: 'ignore', cwd: path.dirname(file) }).unref();
      quitting = true; clearTimeout(closeAckTimer);
      setTimeout(() => app.quit(), 300);
      return { ok: true };
    }
    case 'up.reveal': { const file = updater.downloadedFile(); if (file) shell.showItemInFolder(file); return { ok: !!file }; }
    case 'st.saveScript': {
      const r = await dialog.showSaveDialog(win, { title: '保存安装桥脚本', defaultPath: path.join(app.getPath('downloads'), '酒馆助手脚本-rwkit安装桥.json'), filters: [{ name: '酒馆助手脚本', extensions: ['json'] }] });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(r.filePath, JSON.stringify(tavern.bridgeScript().json, null, 2), 'utf8');
      return { ok: true, path: r.filePath };
    }
    default:
      if (route.startsWith('up.')) return updater.handle(route, body);
      if (route.startsWith('st.')) { await core.ensureRwkit(); return tavern.handle(route, body); }
      if (route.startsWith('ws.')) { await core.ensureRwkit(); return workshop.handle(route, body); }
      return core.handle(route, body);
  }
}

function createWindow() {
  const st = core.getState();
  const b = st.window || {};
  const vb = visibleBounds(b);
  const devIcon = path.join(ROOT, 'build', 'icon.png');
  const offscreen = AUTOTEST && process.env.RWKIT_OFFSCREEN;
  win = new BrowserWindow({
    width: b.width || 1440, height: b.height || 900, ...(offscreen ? { x: -4200, y: 40 } : vb ? { x: vb.x, y: vb.y } : {}),
    minWidth: 1040, minHeight: 640, show: false, title: APP_TITLE,
    backgroundColor: overlay().color,
    titleBarStyle: 'hidden', titleBarOverlay: overlay(),
    ...(!app.isPackaged && fs.existsSync(devIcon) ? { icon: devIcon } : {}),
    webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  if (b.maximized && !AUTOTEST) win.maximize();
  win.loadURL('app://ui/index.html');
  win.once('ready-to-show', () => { if (!AUTOTEST || process.env.RWKIT_SHOW || offscreen) win.showInactive(); });
  if (AUTOTEST) win.webContents.once('did-finish-load', () => import('./autotest.mjs').then(m => m.run(win, AUTOTEST)));

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    const n = win.getNormalBounds();
    core.getState().window = { x: n.x, y: n.y, width: n.width, height: n.height, maximized: win.isMaximized() };
    core.saveState();
  };
  let bt = null;
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, () => { clearTimeout(bt); bt = setTimeout(saveBounds, 400); });

  // 关闭前先问界面：有未保存的修改时由界面弹出确认；界面没有响应时直接关闭
  win.on('close', e => {
    saveBounds();
    if (quitting) return;
    e.preventDefault();
    send('close-request', { drafts: core.hasDrafts() });
    clearTimeout(closeAckTimer);
    closeAckTimer = setTimeout(() => { quitting = true; win?.close(); }, 2500);
  });
  win.on('closed', () => { win = null; core.saveState(true); });

  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://ui/')) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  win.webContents.on('context-menu', (e, p) => {
    const items = [];
    if (p.isEditable) items.push({ role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { type: 'separator' }, { role: 'selectAll', label: '全选' });
    else if (p.selectionText) items.push({ role: 'copy', label: '复制' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  win.webContents.on('render-process-gone', (e, d) => log('界面进程退出：' + d.reason));
}

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
