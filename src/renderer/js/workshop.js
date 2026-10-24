// 创意工坊页：Discord 登录、发现与下载、我的作品、发布与上传新版本
import { $, $$, esc, samePath, debounce, fmtSize, fmtTime, hue, icon, toast, copyText, modal, ask, menu, counter, catLabel } from './util.js';
import { installFlow } from './tavern.js';
import { aiIn } from './ai.js';

const KIND_LABEL = { extension: '扩展', store_catalog: '开局商店', world_character: '世界书角色', opening_character: '开局角色', opening_partner: '开局伙伴', heretic: '异端' };
const CAT_LABEL = { extension: '扩展', character: '角色' };
// 工坊的三种分类：扩展 / 角色 / 开局商店（开局商店在服务器上是 extension + kind=store_catalog）；只有角色再分用途
const KINDS_OF = { '': [], extension: [], store_catalog: [], character: ['world_character', 'opening_character', 'opening_partner', 'heretic'] };
const CATS = [['', '全部'], ['extension', '扩展'], ['character', '角色'], ['store_catalog', '开局商店']];
// 与创意工坊服务器相同的上限
const LIMIT = { name: 80, summary: 2000, changelog: 2000, tags: 12, tag: 24 };
const normTags = list => [...new Set(list.map(t => String(t).normalize('NFKC').trim().toLocaleLowerCase()).filter(Boolean))];
function metaProblems(meta) {
  const tags = normTags(meta.tags || []);
  if (!meta.name) return '作品名称不能为空';
  if (meta.name.length > LIMIT.name) return `作品名称不能超过 ${LIMIT.name} 个字`;
  if (String(meta.summary || '').trim().length > LIMIT.summary) return `简介不能超过 ${LIMIT.summary} 个字`;
  if (tags.length > LIMIT.tags) return `标签最多 ${LIMIT.tags} 个`;
  const long = tags.find(t => t.length > LIMIT.tag);
  return long ? `标签「${long}」超过 ${LIMIT.tag} 个字` : '';
}
const catSeg = cur => `<div class="seg" data-m-seg="category">${CATS.slice(1).map(([v, t]) => `<button type="button" data-v="${v}" class="${cur === v ? 'on' : ''}">${t}</button>`).join('')}</div>`;
function catHint(cat, kind) {
  if (cat === 'character') return `角色用途：<b>${esc(KIND_LABEL[kind] || KIND_LABEL.world_character)}</b>（由内容里的数据决定）。首次发布后不能再修改分类。`;
  if (cat === 'store_catalog') return kind === 'store_catalog' ? '项目里有开局商店目录。首次发布后不能再修改分类。' : '<span class="warn-text">项目里还没有开局商店目录：可以在项目概览的“分类”里添加。</span>';
  return kind === 'store_catalog' ? '<span class="warn-text">项目里有开局商店目录，工坊会归为“开局商店”。</span>' : '通用扩展。首次发布后不能再修改分类。';
}
const issuesBanner = (list, title) => (list?.length ? `<div class="banner error" style="margin-bottom:10px">${icon('xCircle')}<div class="bb"><div class="bt">${esc(title)}（创意工坊的限制）</div><div class="bs">${list.map(x => '· ' + esc(x)).join('<br>')}</div></div></div>` : '');
const SORTS = [['latest', '最新'], ['popular', '热门'], ['downloads', '下载最多'], ['likes', '点赞最多'], ['favorites', '收藏最多']];
const STATUS = { draft: ['草稿', 'plain'], pending: ['审核中', 'info'], published: ['已发布', 'ok'], rejected: ['被驳回', 'error'], archived: ['被管理员下架', 'error'] };
const ART_ICON = { worldbook: 'book', regex: 'regex', script: 'fileCode', preset: 'sliders', data: 'database' };
const ART_LABEL = { worldbook: '世界书', regex: '正则', script: '脚本', preset: '预设', data: '数据' };

let X = null; // app.js 传进来的上下文
const W = {
  st: null, tab: 'discover',
  q: { query: '', category: '', kind: '', sort: 'latest' },
  list: { key: null, items: [], next: null, loading: false, error: null },
  detail: null,
  mine: { items: null, loading: false, error: null },
  remote: {}, remoteKey: '', remoteAt: 0,
};
const api = (r, b) => X.api(r, b);
async function wsOk(route, body) { const r = await api(route, body); if (r && r.ok === false) { const e = new Error(r.error || '操作失败'); e.code = r.code; e.status = r.status; throw e; } return r; }
const user = () => W.st?.user || null;
const n = v => Number(v || 0).toLocaleString('zh-CN');
const ts = s => (s ? fmtTime(Number(s) * 1000) : '');
const coverSrc = (id, v, w, own) => `app://wscover/${encodeURIComponent(id)}?v=${encodeURIComponent(v ?? '')}&w=${w}${own ? '&own=1' : ''}`;
function cover(p, w, cls = '', own = false) {
  const ph = [...String(p.name || '?')][0] || '?';
  return `<div class="wsc ${cls}" data-ph="${esc(ph)}" style="--h:${hue(p.id)}">${p.has_cover ? `<img src="${coverSrc(p.id, p.updated_at, w, own)}" alt="" loading="lazy">` : ''}</div>`;
}
const serverLabel = () => W.st?.servers?.find(s => s.base === W.st.base)?.label || '自定义服务器';
const linkOf = localId => W.st?.links?.[localId] || null;
export const remoteIdOf = p => linkOf(p.id) || p.id;
const localMax = p => Math.max(0, ...X.allSrc(p).map(s => Number(s.version) || 0));
function localFor(remoteId) { return X.S.projects.find(p => p.id === remoteId || linkOf(p.id) === remoteId) || null; }
const isMine = id => !!W.mine.items?.some(m => m.id === id);
function uploadSource(p) {
  const cur = X.curSrc(p);
  const ok = s => s && !s.draft && !s.fatal && s.level !== 'error';
  return [cur, ...p.folders, ...p.packs].find(ok) || null;
}

// ---------- 初始化与事件 ----------
export async function initWorkshop(ctx) {
  X = ctx;
  try { W.st = await api('ws.state'); } catch { W.st = null; }
  if (user()) loadMine(true);
  checkRemote(true);
}
export function onWorkshopEvent(data) {
  if (data?.type === 'auth') {
    if (W.st) W.st.user = data.user;
    if (!data.user) { W.mine.items = null; if (W.tab === 'mine') W.tab = 'discover'; }
    X.render();
  }
}
// 项目列表变化时，查一下工坊上有没有新版本（同一批项目 10 分钟内不重复查）
export const projectsChanged = debounce(() => checkRemote(false), 800);
async function checkRemote(force) {
  if (!X?.S.projects.length || W.st?.checkUpdates === false) return;
  const ids = [...new Set(X.S.projects.map(remoteIdOf))].slice(0, 100);
  const key = ids.join(',');
  if (!force && key === W.remoteKey && Date.now() - W.remoteAt < 600000) return;
  W.remoteKey = key; W.remoteAt = Date.now();
  try {
    const r = await wsOk('ws.versions', { ids });
    W.remote = Object.fromEntries((r.items || []).map(i => [i.id, i]));
    if (X.S.view !== 'workshop' && X.S.tab === 'overview') X.render(); else X.renderSide();
  } catch {}
}
export function remoteNewer(p) {
  const r = W.remote[remoteIdOf(p)];
  return r && r.version > localMax(p) ? r.version : 0;
}

// ---------- 侧栏入口 ----------
export function sideEntry(collapsed, sel) {
  const u = user();
  const av = u?.avatar ? `<img class="ws-av" src="${esc(u.avatar)}" alt="">` : '';
  if (collapsed) return `<div class="ws-entry${sel ? ' sel' : ''}" data-act="ws-open" title="创意工坊${u ? ' · ' + esc(u.name) : ''}"><span class="ws-ico">${icon('globe')}</span></div>`;
  return `<div class="ws-entry${sel ? ' sel' : ''}" data-act="ws-open" title="浏览、下载与发布工坊作品">
    <span class="ws-ico">${icon('globe')}</span>
    <div class="ps-body"><div class="ps-name">创意工坊</div><div class="ps-sub">${u ? esc(u.name) : '浏览与下载 · 未登录'}</div></div>${av}</div>`;
}
export const crumb = () => `<span class="ell">创意工坊</span><span class="sep">/</span><span class="ell muted">${W.detail ? esc(W.detail.data?.project?.name || '作品详情') : W.tab === 'mine' ? '我的作品' : '发现'}</span>`;

// ---------- 页面 ----------
export function renderWorkshop() {
  const m = $('#main');
  if (!m.querySelector('.ws')) m.innerHTML = `<div class="ws"><div class="ws-head" id="wshead"></div><div class="ws-body" id="wsbody"></div></div>`;
  $('#wshead').innerHTML = headHtml();
  renderBody();
}
function headHtml() {
  const u = user();
  const tabs = [['discover', '发现', 'search'], ['mine', '我的作品', 'user']];
  return `<div class="ws-title">${icon('globe')}<b>创意工坊</b><span class="pill plain" title="${esc(W.st?.base || '')}">${esc(serverLabel())}</span></div>
    <nav class="ws-tabs">${tabs.map(([k, t, i]) => `<button class="tab${W.tab === k && !W.detail ? ' on' : ''}" data-act="ws-tab" data-tab="${k}">${icon(i, 'xs')}${t}</button>`).join('')}</nav>
    <span class="grow"></span>
    ${u ? `<button class="ws-user" data-act="ws-user-menu">${u.avatar ? `<img class="ws-av" src="${esc(u.avatar)}" alt="">` : `<span class="ws-av ph">${icon('user', 'xs')}</span>`}<span class="ell">${esc(u.name)}</span>${icon('chevDown', 'xs')}</button>`
      : `<button class="btn discord" data-act="ws-login">${icon('discord')}使用 Discord 登录</button>`}`;
}
function renderBody() {
  const b = $('#wsbody');
  if (!b) return;
  if (!W.st) { b.innerHTML = `<div class="page"><div class="empty">${icon('xCircle', 'big')}<b>创意工坊暂时不可用</b></div></div>`; return; }
  if (!W.detail?.data) delete b.dataset.detail;
  if (W.detail) return renderDetail(b);
  if (W.tab === 'mine') return renderMine(b);
  renderDiscover(b);
}

// ---------- 发现 ----------
const listKey = () => JSON.stringify([W.st?.base, W.q]);
async function loadList(more) {
  const key = listKey();
  if (W.list.loading && !more) return;
  if (!more) W.list = { key, items: [], next: null, loading: true, error: null };
  else W.list.loading = true;
  if (X.S.view === 'workshop' && !W.detail && W.tab === 'discover') renderBody();
  try {
    const r = await wsOk('ws.list', { ...W.q, offset: more ? W.list.next : 0 });
    if (W.list.key !== key) return;
    W.list.items = more ? [...W.list.items, ...r.items] : r.items;
    W.list.next = r.next_offset;
  } catch (e) { if (W.list.key === key) W.list.error = e.message; }
  if (W.list.key === key) W.list.loading = false;
  if (X.S.view === 'workshop' && !W.detail && W.tab === 'discover') renderBody();
}
function renderDiscover(b) {
  if (W.list.key !== listKey()) { loadList(false); return; }
  const kinds = KINDS_OF[W.q.category];
  const bar = `<div class="ws-bar">
    <div class="search">${icon('search')}<input class="input" id="wsq" placeholder="搜索作品名称或简介…" value="${esc(W.q.query)}" spellcheck="false"></div>
    <div class="seg" data-ws-seg="category">${CATS.map(([v, t]) => `<button type="button" data-v="${v}" class="${(W.q.kind === 'store_catalog' ? 'store_catalog' : W.q.category) === v ? 'on' : ''}">${t}</button>`).join('')}</div>
    ${kinds.length ? `<select class="input ws-sel" data-ws-q="kind"><option value="">全部角色</option>${kinds.map(k => `<option value="${k}" ${W.q.kind === k ? 'selected' : ''}>${esc(KIND_LABEL[k])}</option>`).join('')}</select>` : ''}
    ${W.q.tag ? `<span class="tagc on" data-act="ws-untag" title="取消标签筛选">#${esc(W.q.tag)}${icon('x', 'xs')}</span>` : ''}
    <span class="grow"></span>
    <select class="input ws-sel" data-ws-q="sort">${SORTS.map(([v, t]) => `<option value="${v}" ${W.q.sort === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <button class="btn icon" data-act="ws-reload" title="刷新">${icon('refresh')}</button></div>`;
  let grid;
  if (W.list.error && !W.list.items.length) grid = `<div class="banner error">${icon('xCircle')}<div class="bb"><div class="bt">无法读取工坊作品</div><div class="bs">${esc(W.list.error)}</div><div class="ba"><button class="btn sm" data-act="ws-reload">${icon('refresh')}重试</button><button class="btn sm ghost" data-act="ws-server">${icon('settings')}检查服务器设置</button></div></div></div>`;
  else if (!W.list.items.length && W.list.loading) grid = `<div class="loading"><span class="spin"></span>正在读取工坊作品…</div>`;
  else if (!W.list.items.length) grid = `<div class="empty">${icon('search', 'big')}<b>没有找到作品</b>换个关键词或分类试试。</div>`;
  else grid = `<div class="ws-grid">${W.list.items.map(cardHtml).join('')}</div>
    ${W.list.next != null ? `<div class="row center" style="margin-top:16px"><button class="btn" data-act="ws-more" ${W.list.loading ? 'disabled' : ''}>${W.list.loading ? '<span class="spin"></span>正在读取…' : icon('arrowDown') + '加载更多'}</button></div>` : `<div class="ws-end">共 ${W.list.items.length} 个作品</div>`}`;
  const keep = document.activeElement?.id === 'wsq' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const scroll = b.scrollTop;
  b.innerHTML = `<div class="page wide">${bar}${grid}</div>`;
  b.scrollTop = scroll;
  if (keep) { const q = $('#wsq'); q.focus(); q.setSelectionRange(...keep); }
}
function localBadge(id, version) {
  const l = localFor(id);
  if (!l) return '';
  const v = localMax(l);
  return v < version ? `<span class="pill warn sm" title="本地已有 v${v}，工坊有新版本">${icon('arrowUp')}可更新</span>` : `<span class="pill ok sm" title="已在本地打开 v${v}">${icon('check')}本地 v${v}</span>`;
}
function cardHtml(p) {
  return `<div class="wcard" data-act="ws-detail" data-id="${esc(p.id)}" tabindex="0">
    ${cover(p, 480, 'wide')}
    <div class="wc-body">
      <div class="wc-title"><b class="ell" title="${esc(p.name)}">${esc(p.name)}</b>${localBadge(p.id, p.version)}</div>
      <div class="wc-meta"><span class="pill acc sm">${esc(KIND_LABEL[p.kind] || CAT_LABEL[p.category] || p.category)}</span><span class="ell">${esc(p.owner_name || '')}</span><span>v${esc(p.version)}</span><span class="grow"></span><span title="更新时间">${esc(ts(p.updated_at))}</span></div>
      <div class="wc-sum">${esc(p.summary || '（没有简介）')}</div>
      ${p.tags?.length ? `<div class="wc-tags">${p.tags.slice(0, 5).map(t => `<span class="tagc" data-act="ws-tag" data-tag="${esc(t)}">#${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="wc-stats"><span title="下载">${icon('download', 'xs')}${n(p.downloads_count)}</span><span title="点赞">${icon('heart', 'xs')}${n(p.likes_count)}</span><span title="收藏">${icon('star', 'xs')}${n(p.favorites_count)}</span></div>
    </div></div>`;
}

// ---------- 详情 ----------
export async function openDetail(id) {
  X.S.view = 'workshop';
  W.detail = { id, loading: true };
  X.render();
  try {
    const data = await wsOk('ws.detail', { id });
    if (W.detail?.id !== id) return;
    W.detail = { id, data };
    if (user()) api('ws.engagement', { id }).then(e => { if (W.detail?.id === id && e && e.ok !== false) { W.detail.eng = e; renderBody(); } });
  } catch (e) { if (W.detail?.id === id) W.detail = { id, error: e.message }; }
  if (X.S.view === 'workshop') X.render();
}
function renderDetail(b) {
  const d = W.detail;
  const back = `<button class="btn ghost sm" data-act="ws-back">${icon('arrowLeft')}返回${W.tab === 'mine' ? '我的作品' : '列表'}</button>`;
  if (d.loading) { b.innerHTML = `<div class="page">${back}<div class="loading"><span class="spin"></span>正在读取作品…</div></div>`; return; }
  if (d.error) {
    b.innerHTML = `<div class="page">${back}<div class="banner error" style="margin-top:12px">${icon('xCircle')}<div class="bb"><div class="bt">无法读取作品</div><div class="bs">${esc(d.error)}${isMine(d.id) ? '<br>这是你的作品：未发布或已下架的作品只能在“我的作品”里管理。' : ''}</div></div></div></div>`;
    return;
  }
  const { project: p, manifest, preview: pv, changelog, version_history: hist, change_preview: cp } = d.data;
  const local = localFor(p.id), lv = local ? localMax(local) : 0, eng = d.eng;
  const likes = eng ? eng.likes_count : p.likes_count, favs = eng ? eng.favorites_count : p.favorites_count;
  const lists = [['worldbook', '世界书条目', pv.worldbook, x => `${x.enabled === false ? '<span class="pill plain sm">停用</span>' : ''}${x.strategy_type === 'constant' ? '<span class="pill info sm">常驻</span>' : ''}<span class="ell">${esc(x.name)}</span>${x.primary_keys?.length ? `<small class="ell">${esc(x.primary_keys.slice(0, 4).join('、'))}</small>` : ''}`],
    ['regex', '正则', pv.regex, x => `${x.enabled === false ? '<span class="pill plain sm">停用</span>' : ''}<span class="ell">${esc(x.name)}</span>`],
    ['script', '脚本', pv.scripts, x => `${x.enabled === false ? '<span class="pill plain sm">停用</span>' : ''}<span class="ell">${esc((x.folder ? x.folder + ' / ' : '') + x.name)}</span><small>${esc({ character: '角色脚本', preset: '预设脚本', global: '全局脚本' }[x.scope] || '')}</small>`]].filter(([, , l]) => l?.length);
  // 后台刷新（文件变化、登录状态等）会重绘：同一个作品时保留展开的清单与滚动位置
  const same = b.dataset.detail === d.id, open = same ? new Set([...b.querySelectorAll('details[open]')].map(x => x.dataset.k)) : new Set(), scroll = same ? b.scrollTop : 0;
  b.dataset.detail = d.id;
  b.innerHTML = `<div class="page">${back}
    <div class="wd-grid">
      <div class="wd-main">
        ${cover(p, 1280, 'hero')}
        <div class="wd-title"><h1>${esc(p.name)}</h1><span class="pill acc">${esc(KIND_LABEL[p.kind] || CAT_LABEL[p.category])}</span><span class="pill plain">v${esc(p.version)}</span></div>
        <div class="wd-by">${icon('user', 'xs')}${esc(p.owner_name || '')}<span>·</span>更新于 ${esc(ts(p.updated_at))}<span>·</span>发布于 ${esc(ts(p.created_at))}</div>
        ${p.tags?.length ? `<div class="wc-tags">${p.tags.map(t => `<span class="tagc" data-act="ws-tag" data-tag="${esc(t)}">#${esc(t)}</span>`).join('')}</div>` : ''}
        <div class="card"><div class="card-h">${icon('file')}简介</div><div class="card-b wd-text">${esc(p.summary || '（没有简介）')}</div></div>
        ${changelog || cp ? `<div class="card"><div class="card-h">${icon('sparkles')}本版更新 · v${esc(p.version)}</div><div class="card-b">${changelog ? `<div class="wd-text">${esc(changelog)}</div>` : ''}${cp?.summary ? `<div class="wd-chg">与 v${esc(cp.from)} 相比：<span class="pill ok sm">新增 ${cp.summary.added}</span><span class="pill info sm">修改 ${cp.summary.modified}</span><span class="pill error sm">删除 ${cp.summary.removed}</span></div>` : ''}</div></div>` : ''}
        <div class="card"><div class="card-h">${icon('layers')}内容 <span class="count">${pv.artifacts.length} 个 artifact · ${fmtSize(manifest?.total_bytes)}</span></div>
          <div class="wd-arts">${pv.artifacts.map(a => `<div class="wd-art"><span class="kind ${esc(a.kind)}">${esc(ART_LABEL[a.kind] || a.kind)}</span><b class="ell">${esc(a.name)}</b><span class="muted small">${a.entry_count != null ? a.entry_count + ' 项' : ''}</span></div>`).join('')}</div>
          ${lists.map(([k, t, l, row]) => `<details class="wd-list" data-k="${k}" ${open.has(k) ? 'open' : ''}><summary>${icon(ART_ICON[k], 'xs')}${t} <span class="count">${l.length}</span></summary><div class="wd-items">${l.slice(0, 300).map(x => `<div class="wd-item">${row(x)}</div>`).join('')}${l.length > 300 ? `<div class="muted small">还有 ${l.length - 300} 项…</div>` : ''}</div></details>`).join('')}
          ${pv.overrides ? `<div class="wd-note">${icon('sliders', 'xs')}安装时会调整 ${pv.overrides} 条原版资源的启用状态，卸载时恢复。</div>` : ''}
        </div>
        ${hist?.length > 1 ? `<div class="card"><div class="card-h">${icon('clock')}版本历史</div><div class="card-b wd-hist">${hist.map(h => `<div><b>v${esc(h.version)}</b><span class="muted small">${esc(ts(h.reviewed_at || h.created_at))}</span><div class="wd-text small">${esc(h.changelog || '（没有更新说明）')}</div></div>`).join('')}</div></div>` : ''}
      </div>
      <div class="wd-side">
        <div class="card"><div class="card-b">
          ${local ? `<div class="wd-local">${lv < p.version ? `${icon('arrowUp')}<div><b>本地是 v${lv}，工坊有 v${esc(p.version)}</b><small>${esc(local.name)}</small></div>` : `${icon('checkCircle')}<div><b>本地已有 v${lv}</b><small>${esc(local.name)}</small></div>`}</div>` : ''}
          <button class="btn primary block needs-idle" data-act="ws-download" data-id="${esc(p.id)}" data-open="1">${icon('download')}${local && lv < p.version ? '下载 v' + esc(p.version) + ' 并打开' : local ? '重新下载并打开' : '下载并打开'}</button>
          <button class="btn block needs-idle" style="margin-top:8px" data-act="ws-download-install" data-id="${esc(p.id)}">${icon('tavern')}下载并安装到 SillyTavern</button>
          <button class="btn ghost block needs-idle" style="margin-top:4px" data-act="ws-download-to" data-id="${esc(p.id)}">${icon('folderOpen')}下载到…</button>
          ${local ? `<button class="btn ghost block" style="margin-top:4px" data-act="ws-goto-local" data-id="${esc(local.id)}">${icon('arrowRight')}查看本地项目</button>` : ''}
          <div class="fhint">下载为 .rwpack 离线包（与工坊“本地”页导出的格式相同），保存在 ${esc(W.st.downloadDir || W.st.defaultDownloadDir)}。下载不会执行其中的脚本。</div>
          <div class="wd-eng">
            <button class="btn ${eng?.user_liked ? 'on-like' : ''}" data-act="ws-engage" data-kind="like" title="${user() ? '' : '登录后可以点赞'}">${icon('heart')}<span>${n(likes)}</span></button>
            <button class="btn ${eng?.user_favorited ? 'on-fav' : ''}" data-act="ws-engage" data-kind="favorite" title="${user() ? '' : '登录后可以收藏'}">${icon('star')}<span>${n(favs)}</span></button>
            <span class="wd-dl" title="下载次数">${icon('download', 'xs')}${n(eng ? eng.downloads_count : p.downloads_count)}</span>
          </div>
        </div></div>
        <div class="card"><div class="card-h">${icon('info')}信息</div><div class="card-b kv">
          <div class="k">作者</div><div class="v">${esc(p.owner_name || '')}</div>
          <div class="k">分类</div><div class="v">${esc(p.category === 'character' ? '角色 · ' + (KIND_LABEL[p.kind] || '世界书角色') : KIND_LABEL[p.kind] || CAT_LABEL[p.category] || p.category)}</div>
          <div class="k">大小</div><div class="v">${fmtSize(manifest?.total_bytes)} · ${pv.artifacts.length} 个 artifact</div>
          <div class="k">项目 id</div><div class="v"><span class="mono small">${esc(p.id)}</span> <button class="btn xs ghost" data-act="copy" data-text="${esc(p.id)}">${icon('copy')}</button></div>
        </div></div>
        ${p.dependencies?.length ? `<div class="card"><div class="card-h">${icon('link')}依赖 <span class="count">${p.dependencies.length}</span></div><div class="card-b wd-deps">${p.dependencies.map(dep => { const l = localFor(dep.project_id); return `<div class="wd-dep" data-act="ws-detail" data-id="${esc(dep.project_id)}" title="查看这个作品">${icon('package', 'xs')}<span class="ell">${esc(l?.name || dep.project_id)}</span><span class="muted small">≥ v${esc(dep.min_version)}</span>${l ? `<span class="pill ${localMax(l) >= dep.min_version ? 'ok' : 'warn'} sm">本地 v${localMax(l)}</span>` : ''}</div>`; }).join('')}<div class="fhint">安装前需要先在工坊里安装这些作品。</div></div></div>` : ''}
      </div>
    </div></div>`;
  b.scrollTop = scroll;
}

// ---------- 我的作品 ----------
async function loadMine(quiet) {
  if (!user()) return;
  W.mine.loading = true;
  if (!quiet && X.S.view === 'workshop' && W.tab === 'mine') renderBody();
  try { W.mine.items = (await wsOk('ws.mine')).items; W.mine.error = null; }
  catch (e) { W.mine.error = e.message; }
  W.mine.loading = false;
  if (X.S.view === 'workshop' && (W.tab === 'mine' || W.detail)) renderBody();
  else if (X.S.view !== 'workshop' && X.S.tab === 'overview') X.render();
}
function statusPill(m) {
  const [t, c] = STATUS[m.status] || [m.status, 'plain'];
  return `<span class="pill ${c}">${esc(t)}</span>${m.owner_hidden ? `<span class="pill plain">${icon('eyeOff')}已下架</span>` : ''}`;
}
function renderMine(b) {
  if (!user()) {
    b.innerHTML = `<div class="page"><div class="ws-login-card">${icon('discord', 'big')}<h2>登录后管理你的工坊作品</h2><p>使用 Discord 账号登录创意工坊后，可以把本地项目发布到工坊、上传新版本、提交审核，管理封面与上下架。登录凭据只保存在这台电脑上（系统加密）。</p><button class="btn discord" data-act="ws-login">${icon('discord')}使用 Discord 登录</button></div></div>`;
    return;
  }
  if (W.mine.items == null) {
    b.innerHTML = W.mine.error ? `<div class="page"><div class="banner error">${icon('xCircle')}<div class="bb"><div class="bt">无法读取我的作品</div><div class="bs">${esc(W.mine.error)}</div><div class="ba"><button class="btn sm" data-act="ws-mine-reload">${icon('refresh')}重试</button></div></div></div></div>` : `<div class="page"><div class="loading"><span class="spin"></span>正在读取我的作品…</div></div>`;
    if (!W.mine.loading && !W.mine.error) loadMine();
    return;
  }
  const rows = W.mine.items.map(m => {
    const l = localFor(m.id);
    const note = m.status === 'rejected' && m.review_note ? `<div class="wm-note err">${icon('xCircle', 'xs')}驳回原因：${esc(m.review_note)}</div>` : m.status === 'archived' && m.archive_note ? `<div class="wm-note err">${icon('alert', 'xs')}下架原因：${esc(m.archive_note)}</div>` : '';
    return `<div class="wm-row">
      ${cover(m, 320, 'sm', true)}
      <div class="wm-main">
        <div class="wm-title"><b class="ell">${esc(m.name)}</b>${statusPill(m)}</div>
        <div class="wm-sub"><span>${esc(CAT_LABEL[m.category])}</span><span>最新上传 v${m.latest_version}</span><span>${m.published_version ? '已发布 v' + m.published_version : '尚未发布'}</span><span>${icon('download', 'xs')}${n(m.downloads_count)}</span><span>${icon('heart', 'xs')}${n(m.likes_count)}</span><span>${icon('star', 'xs')}${n(m.favorites_count)}</span><span class="muted">${esc(ts(m.updated_at))}</span></div>
        ${l ? `<div class="wm-link">${icon('link', 'xs')}本地项目：<a href="#" data-act="ws-goto-local" data-id="${esc(l.id)}">${esc(l.name)}</a><span class="muted">v${localMax(l)}</span></div>` : `<div class="wm-link muted">${icon('unlink', 'xs')}没有关联本地项目</div>`}
        ${note}
      </div>
      <div class="wm-acts">
        <button class="btn sm ${m.status === 'pending' || m.status === 'archived' ? '' : 'primary'} needs-idle" data-act="ws-upload" data-id="${esc(m.id)}" ${m.status === 'pending' || m.status === 'archived' ? 'disabled title="' + (m.status === 'pending' ? '审核结束前不能上传新版本' : '已被管理员下架') + '"' : ''}>${icon('cloudUp')}上传新版本</button>
        <button class="btn sm icon" data-act="ws-mine-menu" data-id="${esc(m.id)}" title="更多">${icon('more')}</button>
      </div></div>`;
  }).join('');
  b.innerHTML = `<div class="page">
    <div class="ws-bar"><div><b>我的作品</b> <span class="muted">${W.mine.items.length} 个</span></div><span class="grow"></span>
      <button class="btn icon" data-act="ws-mine-reload" title="刷新">${W.mine.loading ? '<span class="spin"></span>' : icon('refresh')}</button>
      <button class="btn primary needs-idle" data-act="ws-publish">${icon('cloudUp')}发布本地项目…</button></div>
    ${W.mine.items.length ? `<div class="card wm-list">${rows}</div>` : `<div class="empty">${icon('cloudUp', 'big')}<b>还没有发布过作品</b>打开或新建一个本地项目，再点“发布本地项目”。</div>`}
    <div class="fhint">首次发布需要提交审核，审核通过后公开；已通过审核的作品，之后上传的新版本会立即发布。审核中的作品不能修改。</div></div>`;
}
function mineMenu(anchor, id) {
  const m = W.mine.items.find(x => x.id === id); if (!m) return;
  const l = localFor(id);
  const canSubmit = ['draft', 'rejected'].includes(m.status) && m.latest_version > 0;
  const locked = m.status === 'pending' || m.status === 'archived';
  menu(anchor, [
    { label: '提交审核', icon: 'send', disabled: !canSubmit, hint: canSubmit ? '审核通过后公开' : m.status === 'pending' ? '正在审核' : m.latest_version ? '' : '先上传一个版本', onClick: () => submitFlow(m) },
    { label: '编辑作品资料…', icon: 'pencil', disabled: locked, onClick: () => editMetaFlow(m) },
    { label: '更换封面…', icon: 'image', disabled: locked, onClick: () => coverFlow(m) },
    m.published_version ? { label: m.owner_hidden ? '重新上架' : '下架（不再公开显示）', icon: m.owner_hidden ? 'eye' : 'eyeOff', disabled: !m.owner_hidden && m.status === 'archived', onClick: () => visibilityFlow(m) } : null,
    '-',
    { label: '下载最新上传的版本', icon: 'download', disabled: !m.latest_version, hint: m.latest_version ? 'v' + m.latest_version + (m.latest_version !== m.published_version ? '（未发布）' : '') : '', onClick: () => downloadOwnFlow(m) },
    { label: '在发现页查看', icon: 'globe', disabled: !m.published_version || m.owner_hidden || m.status === 'archived', onClick: () => openDetail(m.id) },
    l ? { label: '查看本地项目', icon: 'arrowRight', onClick: () => X.select(l.id) } : null,
    l && linkOf(l.id) === id ? { label: '取消关联本地项目', icon: 'unlink', onClick: () => linkSet(l.id, null) } : null,
    '-',
    { label: '永久删除…', icon: 'trash', danger: true, disabled: m.status === 'pending' || (m.published_version > 0 && !m.owner_hidden && m.status !== 'archived'), hint: m.status === 'pending' ? '审核中不能删除' : m.published_version > 0 && !m.owner_hidden && m.status !== 'archived' ? '已发布的作品要先下架' : '', onClick: () => deleteFlow(m) },
  ].filter(Boolean), { align: 'right', width: 260 });
}

// ---------- 概览页的工坊卡片 ----------
export function projectCard(p) {
  if (!W.st) return '';
  const rid = remoteIdOf(p), mine = W.mine.items?.find(m => m.id === rid), pub = W.remote[rid], lv = localMax(p);
  let body;
  if (mine) {
    body = `<div class="wp-row">${statusPill(mine)}<span class="muted small">最新上传 v${mine.latest_version} · ${mine.published_version ? '已发布 v' + mine.published_version : '尚未发布'}</span></div>
      <div class="wp-name ell">${icon('link', 'xs')}${esc(mine.name)}</div>
      <button class="btn primary block needs-idle" data-act="ws-upload" data-id="${esc(mine.id)}" data-local="${esc(p.id)}" ${mine.status === 'pending' || mine.status === 'archived' ? 'disabled' : ''}>${icon('cloudUp')}上传为新版本…</button>
      <div class="row" style="margin-top:6px"><button class="btn sm ghost" data-act="ws-goto-mine">${icon('user')}在“我的作品”中管理</button></div>
      ${mine.status === 'pending' ? '<div class="fhint">正在审核，审核结束前不能上传新版本。</div>' : mine.published_version ? '<div class="fhint">已通过审核：上传的新版本会立即发布。</div>' : ''}`;
  } else if (pub) {
    body = `<div class="wp-row"><span class="pill ${pub.version > lv ? 'warn' : 'ok'}">${pub.version > lv ? icon('arrowUp') + '工坊有新版本' : icon('check') + '与工坊同步'}</span><span class="muted small">工坊 v${pub.version} · 本地 v${lv}</span></div>
      ${pub.version > lv ? `<button class="btn primary block needs-idle" data-act="ws-download" data-id="${esc(rid)}" data-open="1">${icon('download')}下载 v${pub.version}</button>` : ''}
      <div class="row" style="margin-top:6px"><button class="btn sm ghost" data-act="ws-detail" data-id="${esc(rid)}">${icon('globe')}查看工坊页面</button></div>
      ${user() ? '' : '<div class="fhint">如果这是你的作品，登录 Discord 后可以直接上传新版本。</div>'}`;
  } else if (user()) {
    body = `<p class="small muted" style="margin:0 0 10px">这个项目还没有发布到 ${esc(serverLabel())}。</p>
      <button class="btn primary block needs-idle" data-act="ws-publish" data-local="${esc(p.id)}">${icon('cloudUp')}发布到创意工坊…</button>
      <button class="btn block" style="margin-top:6px" data-act="ws-link" data-local="${esc(p.id)}">${icon('link')}关联已有作品…</button>`;
  } else {
    body = `<p class="small muted" style="margin:0 0 10px">登录 Discord 后，可以把这个项目发布到创意工坊，或为已发布的作品上传新版本。</p>
      <button class="btn discord block" data-act="ws-login">${icon('discord')}使用 Discord 登录</button>`;
  }
  return `<div class="card"><div class="card-h">${icon('globe')}创意工坊<span class="grow"></span><span class="muted small">${esc(serverLabel())}</span></div><div class="card-b">${body}</div></div>`;
}

// ---------- 登录 ----------
export async function loginFlow() {
  let r;
  try { r = await wsOk('ws.login'); } catch (e) { toast(e.message, 'error'); return null; }
  return new Promise(res => {
    let done = false;
    const m = modal({
      title: `${icon('discord')}<span>使用 Discord 登录</span>`,
      body: `<div class="ws-wait"><span class="spin big"></span><div><b>已在浏览器中打开 Discord 授权页</b><p>在浏览器里点“授权”，完成后回到这里，会自动完成登录（5 分钟内有效）。</p></div></div>
        <div class="fhint">没有看到浏览器？可以重新打开，或复制链接到浏览器里打开。授权只读取 Discord 用户名与头像（identify）。</div>
        <div class="row" style="margin-top:10px"><button class="btn sm" data-w="reopen">${icon('external')}重新打开授权页</button><button class="btn sm ghost" data-w="copy">${icon('copy')}复制链接</button></div>
        <div class="ferr" hidden></div>`,
      foot: '<div class="spacer"></div><button class="btn" data-m="close">取消</button>',
      onClose: () => { if (!done) { api('ws.loginCancel'); res(null); } },
    });
    m.el.addEventListener('click', e => {
      const a = e.target.closest('[data-w]'); if (!a) return;
      if (a.dataset.w === 'reopen') api('ws.login').then(x => { if (x?.url) r = x; });
      if (a.dataset.w === 'copy') copyText(r.url);
    });
    const wait = () => api('ws.loginWait').then(x => {
      if (m.closed) return;
      if (x?.ok) { done = true; m.close(); W.st.user = x.user; toast('已登录：' + x.user.name, 'ok'); loadMine(true); checkRemote(true); X.render(); res(x.user); return; }
      // 重新打开授权页会开始新的等待
      if (x?.code === 'login_cancelled' && !m.closed) { setTimeout(wait, 300); return; }
      const err = $('.ferr', m.el); err.hidden = false; err.textContent = x?.error || '登录失败';
      $('.ws-wait', m.el).classList.add('stopped');
    });
    wait();
  });
}
async function ensureLogin() { if (user()) return true; return !!(await loginFlow()); }
function userMenu(anchor) {
  const u = user();
  menu(anchor, [
    { header: u.name + (u.username && u.username !== u.name ? ' (@' + u.username + ')' : '') },
    { label: '我的作品', icon: 'user', onClick: () => { W.tab = 'mine'; W.detail = null; X.render(); } },
    { label: '服务器与下载位置…', icon: 'settings', onClick: serverFlow },
    '-',
    { label: '退出登录', icon: 'logOut', danger: true, onClick: async () => { W.st = await api('ws.logout'); W.mine.items = null; if (W.tab === 'mine') W.tab = 'discover'; X.render(); toast('已退出登录', 'ok', 1600); } },
  ], { align: 'right', width: 240 });
}
export function serverFlow() {
  const st = W.st, custom = !st.servers.some(s => s.base === st.base);
  const m = modal({ cls: 'mid', title: '创意工坊设置', body: `
    <div class="set-sec"><h4>服务器</h4><div class="seg" data-wss>${st.servers.map(s => `<button type="button" data-v="${esc(s.base)}" class="${s.base === st.base ? 'on' : ''}">${esc(s.label)}</button>`).join('')}<button type="button" data-v="" class="${custom ? 'on' : ''}">自定义</button></div>
      <div class="row-input" style="margin-top:8px"><input class="input mono" data-ws-base value="${esc(st.base)}" spellcheck="false"></div>
      <div class="fhint">正式服是酒馆里“创意工坊”脚本默认连接的服务器；测试服的作品与账号和正式服分开。每个服务器分别保存登录状态。</div></div>
    <div class="set-sec"><h4>下载位置</h4><div class="row-input"><input class="input mono" data-ws-dir value="${esc(st.downloadDir)}" placeholder="${esc(st.defaultDownloadDir)}" spellcheck="false"><button class="btn" type="button" data-wsd>${icon('folderOpen')}选择…</button></div>
      <div class="fhint">留空时使用 ${esc(st.defaultDownloadDir)}。</div></div>
    <div class="set-sec"><h4>更新提醒</h4><label class="toggle"><input type="checkbox" data-ws-check ${st.checkUpdates !== false ? 'checked' : ''}><span class="sw"></span><span>检查打开的项目在工坊上有没有新版本</span></label>
      <div class="fhint">打开或刷新项目列表时，把这些项目的 id 发给工坊服务器查询最新版本（最多每 10 分钟一次）。关闭后只有进入“创意工坊”时才会联网。</div></div>
    <div class="ferr" hidden></div>`,
    foot: '<div class="spacer"></div><button class="btn" data-m="close">取消</button><button class="btn primary" data-ok>保存</button>' });
  m.el.addEventListener('click', async e => {
    const s = e.target.closest('[data-wss] button');
    if (s) { $$('[data-wss] button', m.el).forEach(b => b.classList.toggle('on', b === s)); if (s.dataset.v) $('[data-ws-base]', m.el).value = s.dataset.v; else $('[data-ws-base]', m.el).focus(); return; }
    if (e.target.closest('[data-wsd]')) { const p = (await X.pick('folder', { title: '选择工坊作品的下载位置', defaultPath: $('[data-ws-dir]', m.el).value || st.defaultDownloadDir }))[0]; if (p) $('[data-ws-dir]', m.el).value = p; return; }
    if (e.target.closest('[data-ok]')) {
      const base = $('[data-ws-base]', m.el).value.trim();
      const r = await api('ws.settings', { base, downloadDir: $('[data-ws-dir]', m.el).value.trim(), checkUpdates: $('[data-ws-check]', m.el).checked });
      if (r.ok === false) { const err = $('.ferr', m.el); err.hidden = false; err.textContent = r.error; return; }
      const changed = r.base !== W.st.base;
      W.st = r; m.close();
      if (changed) { W.list.key = null; W.mine.items = null; W.detail = null; W.remote = {}; W.remoteKey = ''; if (user()) loadMine(true); checkRemote(true); toast('已切换到 ' + serverLabel(), 'ok'); }
      else if (r.checkUpdates === false) W.remote = {};
      else checkRemote(true);
      X.render();
    }
  });
}

// ---------- 下载 ----------
async function downloadFlow(id, { open = true, dir } = {}, overwrite = false) {
  X.busy(true);
  let r;
  try { r = await api('ws.download', { id, open, dir, overwrite }); } catch (e) { r = { ok: false, error: e.message }; }
  X.busy(false);
  return afterDownload(r, () => downloadFlow(id, { open, dir }, true));
}
async function downloadOwnFlow(m, overwrite = false) {
  X.busy(true);
  let r;
  try { r = await api('ws.downloadOwn', { id: m.id, open: true, overwrite }); } catch (e) { r = { ok: false, error: e.message }; }
  X.busy(false);
  return afterDownload(r, () => downloadOwnFlow(m, true));
}
async function afterDownload(r, again) {
  if (r.confirm) {
    const v = await ask({ title: '文件已存在', html: `<p>下载位置已经有 <b>${esc(r.confirm.file)}</b>，内容与工坊上的不同（可能在本地改过）。</p><p>覆盖前会另存一份 .bak 备份（可在设置里关闭）。</p>`, buttons: [{ label: '取消', value: null }, { label: '覆盖', value: 'ok', primary: true }] });
    if (v === 'ok') return again();
    return null;
  }
  if (r.ok === false) { toast(r.error, 'error', 7000); return null; }
  if (r.projects) X.applyView(r);
  const first = r.opened?.find(x => x.id);
  toast(r.same ? '本地已是这个版本：' + r.target.split(/[\\/]/).pop() : '已下载 ' + r.target.split(/[\\/]/).pop() + (r.covered ? '' : '（封面太大，未嵌入）'), 'ok', 4000);
  if (first) { X.S.view = 'project'; X.S.sel = first.id; X.S.src[first.id] = first.path; X.S.tab = 'overview'; X.render(); }
  checkRemote(true);
  return r;
}

// ---------- 发布与上传 ----------
function sourceOptions(sel) {
  const list = [];
  for (const p of X.S.projects) {
    const s = uploadSource(p);
    list.push({ p, s, label: p.name, hint: s ? (s.kind === 'folder' ? '项目文件夹 ' : '') + s.file + ' · v' + (s.version ?? '?') : p.drafts ? '有未保存的修改，先保存' : '有错误，修正后才能上传' });
  }
  return `<select class="input" data-up="src">${list.map(o => `<option value="${o.s ? esc(o.s.path) : ''}" ${o.s ? '' : 'disabled'} ${o.p.id === sel ? 'selected' : ''}>${esc(o.label)} — ${esc(o.hint)}</option>`).join('')}</select>`;
}
const meter = (size, limit) => `<div class="lim"><div class="lim-t"><span>上传内容</span><b>${fmtSize(size)} / 4 MB</b></div><div class="meter ${size > limit ? 'over' : size > limit * 0.8 ? 'hi' : ''}"><i style="width:${Math.min(100, (size / limit) * 100).toFixed(1)}%"></i></div></div>`;
function localSummary(L) {
  return `<div class="up-src">${meter(L.size, L.limit)}<div class="up-facts"><span>${L.artifacts} 个 artifact</span>${L.warns ? `<span class="warn-text">${icon('alert', 'xs')}${L.warns} 条提示</span>` : `<span class="ok-text">${icon('checkCircle', 'xs')}检查通过</span>`}<span>${L.cover ? (L.cover.ok ? icon('image', 'xs') + '有封面' : `<span class="warn-text">${icon('image', 'xs')}封面不能用于工坊（${L.cover.type === 'image/png' || L.cover.type === 'image/jpeg' || L.cover.type === 'image/webp' ? '超过 3 MB' : '只支持 PNG/JPEG/WebP'}）</span>`) : icon('image', 'xs') + '没有封面'}</span></div></div>`;
}
export async function publishFlow(localId) {
  if (!(await ensureLogin())) return;
  if (!X.S.projects.length) { toast('先打开或新建一个本地项目', 'warn'); return; }
  const first = X.S.projects.find(p => p.id === localId) || X.curProject() || X.S.projects[0];
  const m = modal({ cls: 'mid', title: '发布到创意工坊', body: `<div class="fgrid up-form"><label class="flabel">本地项目</label><div class="fval">${sourceOptions(first.id)}</div></div><div data-up="detail"><div class="loading"><span class="spin"></span></div></div><div class="ferr" hidden></div>`,
    foot: `<span class="muted small">发布到 ${esc(serverLabel())} · ${esc(user().name)}</span><div class="spacer"></div><button class="btn" data-m="close">取消</button><button class="btn primary" data-ok disabled>${icon('cloudUp')}发布</button>` });
  let L = null, path = null;
  const err = msg => { const e = $('.ferr', m.el); e.hidden = !msg; e.textContent = msg || ''; };
  const load = async () => {
    path = $('[data-up="src"]', m.el).value; err(''); $('[data-ok]', m.el).disabled = true;
    const box = $('[data-up="detail"]', m.el);
    if (!path) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="loading"><span class="spin"></span></div>';
    try { L = await wsOk('ws.local', { path }); } catch (e) { box.innerHTML = ''; err(e.message); return; }
    const already = W.mine.items?.find(x => x.id === L.localId || x.id === linkOf(L.localId));
    box.innerHTML = `${already ? `<div class="banner warn" style="margin-bottom:10px">${icon('alert')}<div class="bb"><div class="bt">这个项目已经关联了工坊作品“${esc(already.name)}”</div><div class="bs">要更新它，请用“上传新版本”；继续会另外新建一个作品。</div></div></div>` : ''}
      ${issuesBanner(L.issues, '先改好这些地方才能发布')}
      ${L.cover?.ok ? '' : `<div class="banner error" style="margin-bottom:10px">${icon('image')}<div class="bb"><div class="bt">工坊要求作品有封面</div><div class="bs">${L.cover ? '当前封面不能用于工坊：只支持 PNG、JPEG、WebP，且不超过 3 MB。' : '这个项目还没有封面：请先在项目概览里设置封面。'}</div></div></div>`}
      ${localSummary(L)}
      <div class="fgrid up-form">
        <label class="flabel">作品名称</label><div class="fval cnt-wrap"><input class="input" data-m-f="name" value="${esc(L.meta.name)}" maxlength="${LIMIT.name}" data-max="${LIMIT.name}">${counter(L.meta.name, LIMIT.name)}</div>
        <label class="flabel">分类</label><div class="fval">${catSeg(L.display)}<div class="fhint" data-cat-hint>${catHint(L.display, L.kind)}</div></div>
        <label class="flabel">简介</label><div class="fval cnt-wrap"><textarea class="input" rows="4" data-m-f="summary" maxlength="${LIMIT.summary}" data-max="${LIMIT.summary}">${esc(L.meta.summary)}</textarea>${aiIn('创意工坊作品简介（不超过 2000 字）')}${counter(L.meta.summary, LIMIT.summary)}</div>
        <label class="flabel">标签</label><div class="fval"><input class="input" data-m-f="tags" value="${esc(L.meta.tags.join('，'))}" placeholder="用逗号分隔"><div class="fhint">最多 ${LIMIT.tags} 个，每个不超过 ${LIMIT.tag} 个字。</div></div>
        <label class="flabel">更新说明</label><div class="fval cnt-wrap"><textarea class="input" rows="2" data-m-f="changelog" maxlength="${LIMIT.changelog}" data-max="${LIMIT.changelog}" placeholder="可选：这个版本的内容"></textarea>${aiIn('创意工坊更新说明（不超过 2000 字）')}${counter('', LIMIT.changelog)}</div>
        <label class="flabel"></label><div class="fval col">
          <label class="toggle"><input type="checkbox" checked disabled><span class="sw"></span><span>同时上传封面（工坊要求作品必须有封面）</span></label>
          <label class="toggle"><input type="checkbox" data-m-c="submit" checked><span class="sw"></span><span>上传后立即提交审核</span></label>
          ${L.meta.dependencies.length ? `<div class="fhint">${icon('link', 'xs')}包含 ${L.meta.dependencies.length} 个依赖：依赖的作品必须已在工坊发布，且版本不低于要求。</div>` : ''}
        </div></div>`;
    const blocked = L.size > L.limit || !L.cover?.ok || L.issues?.length;
    $('[data-ok]', m.el).disabled = !!blocked;
    if (L.size > L.limit) err('内容超过工坊 4 MB 的上传限制，无法发布');
  };
  m.el.addEventListener('change', e => { if (e.target.matches('[data-up="src"]')) load(); });
  m.el.addEventListener('click', async e => {
    const s = e.target.closest('[data-m-seg] button');
    if (s) { $$('button', s.parentElement).forEach(b => b.classList.toggle('on', b === s)); const h = $('[data-cat-hint]', m.el); if (h && L) h.innerHTML = catHint(s.dataset.v, L.kind); return; }
    if (!e.target.closest('[data-ok]') || !L) return;
    const f = k => $(`[data-m-f="${k}"]`, m.el).value;
    const meta = { name: f('name').trim(), summary: f('summary'), category: $('[data-m-seg="category"] .on', m.el)?.dataset.v || 'extension', tags: f('tags').split(/[,，、\n]+/).map(t => t.trim()).filter(Boolean) };
    const bad = metaProblems(meta) || (meta.category === 'store_catalog' && L.kind !== 'store_catalog' ? '选择“开局商店”需要项目里有开局商店目录：可以在项目概览的“分类”里添加' : meta.category === 'extension' && L.kind === 'store_catalog' ? '项目里有开局商店目录，工坊会归为“开局商店”，请选择“开局商店”' : '');
    if (bad) { err(bad); return; }
    const opt = { cover: true, submit: $('[data-m-c="submit"]', m.el).checked, changelog: f('changelog') };
    m.foot.querySelectorAll('button').forEach(b => { b.disabled = true; });
    const steps = ['创建作品', '上传内容' + (opt.cover ? '与封面' : ''), opt.submit ? '提交审核' : null].filter(Boolean);
    const box = $('[data-up="detail"]', m.el);
    box.innerHTML = `<ol class="vsteps up-steps">${steps.map((t, i) => `<li data-step="${i}"><span class="vs-n">${i + 1}</span><div><b>${t}</b><small></small></div></li>`).join('')}</ol>`;
    const step = (i, cls, note = '') => { const li = $(`[data-step="${i}"]`, box); if (!li) return; li.className = cls; $('.vs-n', li).innerHTML = cls === 'done' ? icon('check', 'xs') : cls === 'cur' ? '<span class="spin"></span>' : cls === 'bad' ? icon('x', 'xs') : i + 1; $('small', li).textContent = note; };
    X.busy(true);
    let created = null;
    try {
      step(0, 'cur');
      created = (await wsOk('ws.create', { path, meta })).project;
      step(0, 'done', '作品 id ' + created.id);
      step(1, 'cur');
      const up = await wsOk('ws.upload', { id: created.id, path, changelog: opt.changelog, cover: opt.cover, submit: opt.submit });
      step(1, 'done', '已上传为 v' + up.version);
      if (opt.submit) step(2, up.submitted ? 'done' : 'cur', up.submitted ? '等待管理员审核' : '');
      X.busy(false);
      m.foot.innerHTML = `<div class="spacer"></div><button class="btn primary" data-m="close">完成</button>`;
      err('');
      toast(opt.submit ? '已发布并提交审核' : '已上传为草稿，可在“我的作品”里提交审核', 'ok', 5000);
      W.st = await api('ws.state'); loadMine(true); X.render();
    } catch (e2) {
      X.busy(false);
      const i = created ? 1 : 0; step(i, 'bad', e2.message);
      err(created ? '作品已经创建，但后续步骤失败：' + e2.message + '。可以在“我的作品”里继续上传。' : e2.message);
      m.foot.innerHTML = `<div class="spacer"></div><button class="btn" data-m="close">关闭</button>`;
      if (created) { W.st = await api('ws.state'); loadMine(true); }
    }
  });
  load();
}
export async function uploadFlow(id, localId) {
  if (!(await ensureLogin())) return;
  if (!W.mine.items) await loadMine(true);
  const mine = W.mine.items?.find(x => x.id === id);
  if (!mine) { toast('在“我的作品”里找不到这个作品', 'error'); return; }
  const local = X.S.projects.find(p => p.id === localId) || localFor(id);
  const m = modal({ cls: 'mid', title: '上传新版本 · ' + esc(mine.name), body: `<div class="fgrid up-form"><label class="flabel">本地项目</label><div class="fval">${sourceOptions(local?.id)}${local ? '' : '<div class="fhint">选择要上传的本地项目；上传后会记住这个关联。</div>'}</div></div><div data-up="detail"><div class="loading"><span class="spin"></span></div></div><div class="ferr" hidden></div>`,
    foot: `<span class="muted small">${esc(serverLabel())} · ${esc(user().name)}</span><div class="spacer"></div><button class="btn" data-m="close">取消</button><button class="btn primary" data-ok disabled>${icon('cloudUp')}上传</button>` });
  if (!local) $('[data-up="src"]', m.el).selectedIndex = -1;
  let L = null, path = null;
  const err = msg => { const e = $('.ferr', m.el); e.hidden = !msg; e.textContent = msg || ''; };
  const load = async () => {
    path = $('[data-up="src"]', m.el).value; err(''); $('[data-ok]', m.el).disabled = true;
    const box = $('[data-up="detail"]', m.el);
    if (!path) { box.innerHTML = '<div class="fhint">请选择本地项目。</div>'; return; }
    box.innerHTML = '<div class="loading"><span class="spin"></span></div>';
    try { L = await wsOk('ws.local', { path, id }); } catch (e) { box.innerHTML = ''; err(e.message); return; }
    const r = L.remote, published = r.published_version > 0, next = r.latest_version + 1;
    const blocked = r.status === 'pending' ? '作品正在审核，审核结束前不能上传新版本。' : r.status === 'archived' ? '作品已被管理员下架，不能上传。' : published && !r.has_cover && !L.cover?.ok ? '已发布的作品上传新版本前必须有封面：请先在“我的作品”里上传封面，或给本地项目设置 PNG/JPEG/WebP 封面。' : L.size > L.limit ? '内容超过工坊 4 MB 的上传限制。' : L.issues?.length ? '先改好上面标出的问题（创意工坊的限制）。' : '';
    const other = L.localId !== id && linkOf(L.localId) && linkOf(L.localId) !== id;
    box.innerHTML = `<div class="banner ${published ? 'info' : 'plain'}" style="margin-bottom:10px">${icon(published ? 'zap' : 'info')}<div class="bb"><div class="bt">${published ? `上传后立即发布为 v${next}` : `上传为 v${next}（草稿）`}</div><div class="bs">${published ? '这个作品已通过审核，之后的新版本不需要再次审核，会直接替换公开版本。' : '首次发布需要提交审核，审核通过后才会公开。'}</div></div></div>
      ${other ? `<div class="banner warn" style="margin-bottom:10px">${icon('alert')}<div class="bb"><div class="bt">这个本地项目关联的是另一个工坊作品</div><div class="bs">继续上传会把关联改到“${esc(mine.name)}”。</div></div></div>` : ''}
      ${issuesBanner(L.issues, '先改好这些地方才能上传')}
      ${localSummary(L)}
      <div class="fgrid up-form">
        <label class="flabel">更新说明</label><div class="fval cnt-wrap"><textarea class="input" rows="4" data-m-f="changelog" maxlength="${LIMIT.changelog}" data-max="${LIMIT.changelog}" placeholder="这个版本改了什么（显示在工坊作品页的“本版更新”）"></textarea>${aiIn('创意工坊更新说明（不超过 2000 字）')}${counter('', LIMIT.changelog)}</div>
        <label class="flabel"></label><div class="fval col">
          ${L.diff?.length ? `<label class="toggle"><input type="checkbox" data-m-c="meta" checked><span class="sw"></span><span>同时更新作品资料（${L.diff.map(x => esc(x.label)).join('、')}与本地不同）</span></label>${L.diff.some(x => x.key === 'category') && published ? '<div class="fhint warn-text">已发布的作品不能修改分类，请先把本地项目的分类改回去，或取消“同时更新作品资料”。</div>' : ''}` : '<div class="fhint">作品资料（名称、简介、标签、依赖）与本地一致。</div>'}
          <label class="toggle"><input type="checkbox" data-m-c="cover" ${L.cover?.ok ? (r.has_cover ? '' : 'checked') : 'disabled'}><span class="sw"></span><span>同时用本地封面替换工坊封面${r.has_cover ? '' : '（工坊上还没有封面）'}</span></label>
          ${published ? '' : `<label class="toggle"><input type="checkbox" data-m-c="submit" checked><span class="sw"></span><span>上传后立即提交审核</span></label>`}
        </div></div>`;
    $('[data-ok]', m.el).disabled = !!blocked;
    if (blocked) err(blocked);
  };
  m.el.addEventListener('change', e => { if (e.target.matches('[data-up="src"]')) load(); });
  m.el.addEventListener('click', async e => {
    if (!e.target.closest('[data-ok]') || !L) return;
    const c = k => !!$(`[data-m-c="${k}"]`, m.el)?.checked;
    m.foot.querySelectorAll('button').forEach(b => { b.disabled = true; });
    X.busy(true);
    try {
      const r = await wsOk('ws.upload', { id, path, changelog: $('[data-m-f="changelog"]', m.el).value, syncMeta: c('meta'), cover: c('cover'), submit: c('submit') });
      X.busy(false); m.close();
      toast(r.autoPublished ? `已发布 v${r.version}` : r.submitted ? `已上传 v${r.version} 并提交审核` : `已上传 v${r.version}（草稿）`, 'ok', 5000);
      W.st = await api('ws.state'); loadMine(true); checkRemote(true); X.render();
    } catch (e2) {
      X.busy(false); err(e2.message);
      m.foot.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  });
  load();
}
async function submitFlow(m) {
  const v = await ask({ title: '提交审核“' + m.name + '”？', html: `<p>提交 v${m.latest_version} 给管理员审核。审核期间不能修改资料、封面，也不能上传新版本。</p>`, buttons: [{ label: '取消', value: null }, { label: '提交审核', value: 'ok', primary: true }] });
  if (v !== 'ok') return;
  try { const r = await wsOk('ws.submit', { id: m.id }); toast(r.auto_published ? '已发布' : '已提交审核', 'ok'); loadMine(true); } catch (e) { toast(e.message, 'error', 6000); }
}
function editMetaFlow(m) {
  const md = modal({ cls: 'mid', title: '编辑作品资料', body: `<div class="fgrid up-form">
      <label class="flabel">作品名称</label><div class="fval cnt-wrap"><input class="input" data-m-f="name" value="${esc(m.name)}" maxlength="${LIMIT.name}" data-max="${LIMIT.name}">${counter(m.name, LIMIT.name)}</div>
      <label class="flabel">分类</label><div class="fval"><div class="seg" data-m-seg="category">${[['extension', '扩展 / 开局商店'], ['character', '角色']].map(([v, t]) => `<button type="button" data-v="${v}" class="${m.category === v ? 'on' : ''}" ${m.published_version ? 'disabled' : ''}>${t}</button>`).join('')}</div><div class="fhint">开局商店属于扩展，由作品内容里的开局商店目录决定；角色的用途也由内容决定。${m.published_version ? '首次发布后不能修改分类。' : ''}</div></div>
      <label class="flabel">简介</label><div class="fval cnt-wrap"><textarea class="input" rows="5" data-m-f="summary" maxlength="${LIMIT.summary}" data-max="${LIMIT.summary}">${esc(m.summary)}</textarea>${aiIn('创意工坊作品简介（不超过 2000 字）')}${counter(m.summary, LIMIT.summary)}</div>
      <label class="flabel">标签</label><div class="fval"><input class="input" data-m-f="tags" value="${esc((m.tags || []).join('，'))}" placeholder="用逗号分隔"><div class="fhint">最多 ${LIMIT.tags} 个，每个不超过 ${LIMIT.tag} 个字。</div></div>
    </div><div class="fhint">${m.published_version ? '已发布的作品：资料修改会在下次上传新版本时随版本公开。' : '修改会同时更新最新上传的草稿版本。'}依赖请在本地项目里修改，上传时同步。</div><div class="ferr" hidden></div>`,
    foot: '<div class="spacer"></div><button class="btn" data-m="close">取消</button><button class="btn primary" data-ok>保存</button>' });
  md.el.addEventListener('click', async e => {
    const s = e.target.closest('[data-m-seg] button');
    if (s) { $$('button', s.parentElement).forEach(b => b.classList.toggle('on', b === s)); return; }
    if (!e.target.closest('[data-ok]')) return;
    const f = k => $(`[data-m-f="${k}"]`, md.el).value;
    const fields = { name: f('name').trim(), summary: f('summary'), tags: f('tags').split(/[,，、\n]+/).map(t => t.trim()).filter(Boolean) };
    const bad = metaProblems(fields);
    if (bad) { const er = $('.ferr', md.el); er.hidden = false; er.textContent = bad; return; }
    const cat = $('[data-m-seg="category"] .on', md.el)?.dataset.v; if (cat && cat !== m.category) fields.category = cat;
    try { await wsOk('ws.update', { id: m.id, fields }); md.close(); toast('作品资料已保存', 'ok'); loadMine(true); }
    catch (e2) { const er = $('.ferr', md.el); er.hidden = false; er.textContent = e2.message; }
  });
}
async function coverFlow(m) {
  const f = (await X.pick('wsCover'))[0]; if (!f) return;
  X.busy(true);
  try { await wsOk('ws.cover', { id: m.id, file: f }); toast('封面已更换', 'ok'); loadMine(true); } catch (e) { toast(e.message, 'error', 6000); }
  X.busy(false);
}
async function visibilityFlow(m) {
  const hide = !m.owner_hidden;
  const v = await ask({ title: (hide ? '下架' : '重新上架') + '“' + m.name + '”？', html: hide ? '<p>下架后作品不再出现在发现页，其他人也无法下载；已经安装的玩家不受影响。可以随时重新上架。</p>' : '<p>重新上架后作品会回到发现页。</p>', buttons: [{ label: '取消', value: null }, { label: hide ? '下架' : '重新上架', value: 'ok', primary: true }] });
  if (v !== 'ok') return;
  try { await wsOk('ws.visibility', { id: m.id, hidden: hide }); toast(hide ? '已下架' : '已重新上架', 'ok'); loadMine(true); checkRemote(true); } catch (e) { toast(e.message, 'error', 6000); }
}
function deleteFlow(m) {
  const md = modal({ title: '永久删除“' + esc(m.name) + '”？', body: `<p class="warn-text"><b>会删除工坊上这个作品的所有版本、封面、点赞与收藏，无法恢复。</b>本地文件不受影响。</p><p>输入作品名称确认：</p><input class="input" data-del-confirm placeholder="${esc(m.name)}" spellcheck="false" autofocus><div class="ferr" hidden></div>`,
    foot: '<div class="spacer"></div><button class="btn" data-m="close">取消</button><button class="btn danger-ghost" data-ok disabled>永久删除</button>' });
  const input = $('[data-del-confirm]', md.el), ok = $('[data-ok]', md.el);
  input.addEventListener('input', () => { ok.disabled = input.value.trim() !== m.name.trim(); });
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    try { await wsOk('ws.delete', { id: m.id }); md.close(); toast('已永久删除', 'ok'); W.st = await api('ws.state'); loadMine(true); }
    catch (e) { const er = $('.ferr', md.el); er.hidden = false; er.textContent = e.message; ok.disabled = false; }
  });
}
async function linkFlow(localId) {
  if (!(await ensureLogin())) return;
  if (!W.mine.items) await loadMine(true);
  const items = W.mine.items || [];
  if (!items.length) { toast('你还没有工坊作品，可以先“发布到创意工坊”', 'info'); return; }
  const v = await ask({ title: '关联已有的工坊作品', html: `<p>选择要用这个本地项目更新的作品：</p>${items.map(m => `<button class="choice" data-pick="${esc(m.id)}">${icon('globe')}<div><b>${esc(m.name)}</b> ${statusPill(m)}<div class="small muted">最新上传 v${m.latest_version} · ${esc(CAT_LABEL[m.category])}</div></div></button>`).join('')}`, buttons: [{ label: '取消', value: null }] });
  if (v) await linkSet(localId, v);
}
async function linkSet(localId, remoteId) {
  W.st = await api('ws.link', { localId, remoteId });
  checkRemote(true); X.render();
  toast(remoteId ? '已关联工坊作品' : '已取消关联', 'ok', 1600);
}

// ---------- 点击 ----------
export async function workshopClick(act, t, e) {
  switch (act) {
    case 'ws-open': X.S.view = 'workshop'; X.render(); return true;
    case 'ws-tab': W.tab = t.dataset.tab; W.detail = null; if (W.tab === 'mine' && user()) loadMine(true); X.render(); return true;
    case 'ws-goto-mine': X.S.view = 'workshop'; W.tab = 'mine'; W.detail = null; loadMine(true); X.render(); return true;
    case 'ws-login': loginFlow(); return true;
    case 'ws-user-menu': userMenu(t); return true;
    case 'ws-server': serverFlow(); return true;
    case 'ws-reload': W.list.key = null; renderBody(); return true;
    case 'ws-more': loadList(true); return true;
    case 'ws-tag': W.q = { ...W.q, query: '', tag: t.dataset.tag }; W.detail = null; W.tab = 'discover'; X.S.view = 'workshop'; W.list.key = null; X.render(); return true;
    case 'ws-untag': W.q = { ...W.q }; delete W.q.tag; W.list.key = null; renderBody(); return true;
    case 'ws-detail': openDetail(t.dataset.id); return true;
    case 'ws-back': W.detail = null; X.render(); return true;
    case 'ws-download': downloadFlow(t.dataset.id, { open: t.dataset.open === '1' }); return true;
    case 'ws-download-install': { const r = await downloadFlow(t.dataset.id, { open: true }); if (r?.target) installFlow(r.target); return true; }
    case 'ws-download-to': { const d = (await X.pick('folder', { title: '下载到…', defaultPath: W.st.downloadDir || W.st.defaultDownloadDir }))[0]; if (d) downloadFlow(t.dataset.id, { open: true, dir: d }); return true; }
    case 'ws-goto-local': e.preventDefault(); X.select(t.dataset.id); return true;
    case 'ws-engage': {
      if (!(await ensureLogin())) return true;
      const d = W.detail; if (!d?.data) return true;
      const kind = t.dataset.kind, on = kind === 'like' ? !d.eng?.user_liked : !d.eng?.user_favorited;
      try { d.eng = await wsOk('ws.engage', { id: d.id, kind, enabled: on }); renderBody(); } catch (err) { toast(err.message, 'error'); }
      return true;
    }
    case 'ws-mine-reload': loadMine(); return true;
    case 'ws-mine-menu': mineMenu(t, t.dataset.id); return true;
    case 'ws-upload': uploadFlow(t.dataset.id, t.dataset.local); return true;
    case 'ws-publish': publishFlow(t.dataset.local); return true;
    case 'ws-link': linkFlow(t.dataset.local); return true;
  }
  return false;
}
// 搜索框、筛选
export function workshopInput(e) {
  if (e.target.id === 'wsq') { searchSoon(e.target.value); return true; }
  return false;
}
const searchSoon = debounce(v => { if (W.q.query === v.trim()) return; W.q = { ...W.q, query: v.trim() }; delete W.q.tag; W.list.key = null; renderBody(); }, 450);
export function workshopChange(e) {
  const k = e.target.dataset.wsQ;
  if (!k) return false;
  W.q = { ...W.q, [k]: e.target.value }; W.list.key = null; renderBody();
  return true;
}
export function workshopSeg(e) {
  const b = e.target.closest('[data-ws-seg] button');
  if (!b) return false;
  // 扩展只看通用扩展、开局商店单独一类（与官方客户端的导航一致）
  const v = b.dataset.v;
  W.q = { ...W.q, category: v === 'store_catalog' ? 'extension' : v, kind: v === 'extension' ? 'extension' : v === 'store_catalog' ? 'store_catalog' : '' }; W.list.key = null; renderBody();
  return true;
}
export const workshopState = () => W;
