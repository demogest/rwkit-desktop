// 应用内检查更新：启动时自动检查（每天最多一次）、发现新版本时在侧栏提示、更新窗口里下载并安装
import { $, esc, fmtSize, fmtTime, icon, toast, modal, ask } from './util.js';

let X = null;
const U = { st: null, modal: null };
const api = (r, b) => X.api(r, b);
const KIND = { setup: '安装版', portable: '免安装版', dev: '源码运行' };

export async function initUpdates(ctx) {
  X = ctx;
  try { U.st = await api('up.state'); } catch { return; }
  const r = await api('up.auto');
  if (r && r.ok !== false && !r.skipped) {
    U.st = r;
    if (U.st.newer && U.st.latest.version !== U.st.skip) { toast(`rwkit 有新版本 v${U.st.latest.version}，点左下角查看`, 'info', 6000); X.render(); }
  }
}
export function onUpdateEvent(d) {
  if (d?.type !== 'progress' || !U.st) return;
  const prev = U.st.download?.state;
  U.st.download = d;
  // 下载中只更新进度条，不重绘整个窗口（更新说明的滚动位置不变）
  const bar = U.modal && !U.modal.closed && $('.up-prog', U.modal.el);
  if (bar && d.state === 'downloading' && prev === 'downloading') {
    $('b', bar).textContent = fmtSize(d.received) + ' / ' + fmtSize(d.total);
    $('.meter > i', bar).style.width = (d.total ? Math.min(100, d.received / d.total * 100).toFixed(1) : 0) + '%';
    return;
  }
  U.paint?.();
}
const pending = () => U.st?.newer && U.st.latest.version !== U.st.skip;

// 侧栏底部：发现新版本时显示
export function sideNotice(collapsed) {
  if (!pending()) return '';
  return collapsed ? `<button class="btn primary icon sm up-side-c" data-act="up-open" title="有新版本 v${esc(U.st.latest.version)}">${icon('arrowUp')}</button>`
    : `<button class="up-side" data-act="up-open">${icon('arrowUp')}<span class="ell">有新版本 v${esc(U.st.latest.version)}</span><small>查看</small></button>`;
}

let markedMod = null;
async function notesHtml(md) {
  try { markedMod = markedMod || (await import('../vendor/marked.js')).marked; return markedMod.parse(md || '（没有更新说明）', { gfm: true }); }
  catch { return `<pre>${esc(md)}</pre>`; }
}
const dirty = () => X.S.projects.some(p => p.drafts) || X.S.ed?.dirty || X.S.pf?.dirty;

export async function updateFlow({ check = true } = {}) {
  if (U.modal && !U.modal.closed) return;
  const m = modal({ cls: 'mid', title: `${icon('arrowUp')}<span>检查更新</span>`, body: '<div data-up="body"><div class="loading"><span class="spin"></span>正在查询 GitHub 上的最新版本…</div></div>', foot: '<div data-up="foot" class="up-foot"></div>', onClose: () => { U.paint = null; } });
  U.modal = m;
  let error = '';
  const paint = async () => {
    const st = U.st || {}, l = st.latest, d = st.download;
    const body = $('[data-up="body"]', m.el), foot = $('[data-up="foot"]', m.el);
    if (!body) return;
    const auto = `<label class="toggle sm"><input type="checkbox" data-up="auto" ${st.auto ? 'checked' : ''}><span class="sw"></span><span>启动时自动检查（每天最多一次）</span></label>`;
    if (error) {
      body.innerHTML = `<div class="banner error">${icon('xCircle')}<div class="bb"><div class="bt">检查更新失败</div><div class="bs">${esc(error)}</div></div></div><p class="small muted" style="margin-top:10px">当前版本 v${esc(st.version)}（${esc(KIND[st.kind] || '')}）。也可以直接打开发布页查看。</p>`;
      foot.innerHTML = `${auto}<div class="spacer"></div><button class="btn" data-up="page">${icon('external')}打开发布页</button><button class="btn primary" data-up="retry">${icon('refresh')}重试</button>`;
      return;
    }
    if (!l) return;
    if (!st.newer) {
      body.innerHTML = `<div class="banner ok">${icon('checkCircle')}<div class="bb"><div class="bt">已是最新版本 v${esc(st.version)}</div><div class="bs">GitHub 上的最新发布是 v${esc(l.version)}（${esc(fmtTime(Date.parse(l.publishedAt)))}）。</div></div></div>`;
      foot.innerHTML = `${auto}<div class="spacer"></div><button class="btn" data-up="page">${icon('external')}发布页</button><button class="btn primary" data-m="close">好的</button>`;
      return;
    }
    const size = l.asset ? fmtSize(l.asset.size) : '';
    let action = '';
    if (st.kind === 'dev') action = `<div class="fhint">从源码运行时不能自动更新：请 git pull 后重新构建，或到发布页下载。</div>`;
    else if (!l.asset) action = `<div class="fhint warn-text">这个版本没有${esc(KIND[st.kind])}的文件，请到发布页下载。</div>`;
    else if (!l.asset.sha256) action = `<div class="fhint warn-text">这个版本的文件没有校验值，为安全起见不在程序里下载，请到发布页手动下载。</div>`;
    else if (d?.state === 'downloading') action = `<div class="up-prog"><div class="lim-t"><span>正在下载 ${esc(l.asset.name)}</span><b>${fmtSize(d.received)} / ${fmtSize(d.total)}</b></div><div class="meter"><i style="width:${d.total ? Math.min(100, d.received / d.total * 100).toFixed(1) : 0}%"></i></div></div>`;
    else if (d?.state === 'done' && d.version === l.version) action = `<div class="banner ok">${icon('checkCircle')}<div class="bb"><div class="bt">已下载 v${esc(l.version)}${l.asset.sha256 ? '，SHA-256 校验通过' : ''}</div><div class="bs">${st.kind === 'setup' ? '点“立即安装”会关闭本程序并运行安装程序，安装完成后重新打开即可。' : `新的免安装版保存在 ${esc(d.file)}。点“运行新版本”会关闭本程序并打开新版本；旧版本的 exe 可以之后删除。`}</div></div></div>`;
    else if (d?.state === 'failed') action = `<div class="banner error">${icon('xCircle')}<div class="bb"><div class="bt">下载失败</div><div class="bs">${esc(d.error)}</div></div></div>`;
    body.innerHTML = `<div class="up-head"><div><small>当前版本</small><b>v${esc(st.version)}</b></div>${icon('arrowRight')}<div><small>最新版本</small><b class="acc">v${esc(l.version)}</b></div><span class="grow"></span><span class="muted small">${esc(fmtTime(Date.parse(l.publishedAt)))} 发布${size ? ' · ' + KIND[st.kind] + ' ' + size : ''}</span></div>
      <div class="up-notes md-body">${await notesHtml(l.notes)}</div>${action}`;
    let btns = '';
    if (st.kind !== 'dev' && l.asset?.sha256) {
      if (d?.state === 'downloading') btns = `<button class="btn" data-up="cancel">取消下载</button>`;
      else if (d?.state === 'done' && d.version === l.version) btns = `<button class="btn" data-up="reveal">${icon('folderOpen')}显示文件</button><button class="btn primary" data-up="install">${icon('zap')}${st.kind === 'setup' ? '立即安装' : '运行新版本'}</button>`;
      else btns = `<button class="btn primary" data-up="download">${icon('download')}${st.kind === 'setup' ? '下载并安装' : '下载新版本'}（${size}）</button>`;
    }
    foot.innerHTML = `${auto}<div class="spacer"></div><button class="btn ghost" data-up="skip">跳过这个版本</button><button class="btn" data-up="page">${icon('external')}发布页</button>${btns}`;
  };
  U.paint = paint;
  const doCheck = async () => {
    error = '';
    $('[data-up="body"]', m.el).innerHTML = '<div class="loading"><span class="spin"></span>正在查询 GitHub 上的最新版本…</div>';
    $('[data-up="foot"]', m.el).innerHTML = '';
    const r = await api('up.check');
    if (r.ok === false) error = r.error; else U.st = r;
    X.render(); paint();
  };
  m.el.addEventListener('change', async e => { if (e.target.dataset.up === 'auto') U.st = await api('up.settings', { auto: e.target.checked }); });
  m.el.addEventListener('click', async e => {
    // 更新说明里的链接用系统浏览器打开
    const link = e.target.closest('.up-notes a[href]');
    if (link) { e.preventDefault(); if (/^https:\/\//.test(link.getAttribute('href'))) window.open(link.getAttribute('href')); return; }
    const a = e.target.closest('[data-up]'); if (!a || a.tagName === 'INPUT' || a.tagName === 'LABEL') return;
    const k = a.dataset.up, l = U.st?.latest;
    if (k === 'retry') doCheck();
    if (k === 'page') window.open(l?.url || 'https://github.com/demogest/rwkit-desktop/releases/latest');
    if (k === 'skip') { U.st = await api('up.settings', { skip: l.version }); m.close(); X.render(); toast(`已跳过 v${l.version}，有更新的版本时会再提醒`, 'info'); }
    if (k === 'download') {
      U.st.download = { state: 'downloading', received: 0, total: l.asset.size, version: l.version }; paint();
      const r = await api('up.download');
      if (r.ok === false) { U.st.download = { state: 'failed', error: r.error, version: l.version }; } else U.st = r;
      paint();
    }
    if (k === 'cancel') api('up.cancel');
    if (k === 'reveal') api('up.reveal');
    if (k === 'install') {
      if (dirty()) { await ask({ title: '还有未保存的修改', html: '<p>更新会关闭本程序，请先保存或放弃未保存的修改。</p>', buttons: [{ label: '好的', value: null, primary: true }] }); return; }
      const r = await api('up.install');
      if (r.ok === false) toast(r.error, 'error', 6000);
      else if (r.dev) toast('源码运行时不会自动安装，已打开下载的文件位置', 'info');
    }
  });
  if (check || !U.st?.latest) await doCheck(); else paint();
}

export function updatesClick(act) {
  if (act === 'up-open') { updateFlow({ check: !pending() }); return true; }
  if (act === 'up-check') { updateFlow({ check: true }); return true; }
  return false;
}
export const updateState = () => U;
