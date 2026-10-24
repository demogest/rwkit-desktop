// rwkit 桌面版界面
import { $, $$, esc, clone, stable, samePath, baseName, debounce, KIND, KIND_ICON, CAT, KIND_LABEL, displayCat, catLabel, counter, LV, POS, ROLE, PLACE, SCOPE, MAX_BYTES, fmtSize, fmtTime, hue, icon, pill, srcPill, toast, copyText, modal, ask, form, layers, menu, closeMenu } from './util.js';
import { diffHtml } from './diff.js';
import { editorHtml, bindEditor, makeEd, editOp, footHtml, pageOf, F, listHtml } from './editors.js';
import { initUpdates, onUpdateEvent, sideNotice, updatesClick, updateFlow } from './updates.js';
import { initAI, onAIEvent, aiAssist, aiReviewFlow, aiSettingsFlow, cmTarget, aiIn, aiState } from './ai.js';
import { initTavern, onTavernEvent, sideStatus, tavernCard, tavernClick, setupFlow, installFlow, installSource, tavernState } from './tavern.js';
import { initWorkshop, onWorkshopEvent, projectsChanged, remoteNewer, sideEntry, crumb as wsCrumb, renderWorkshop, projectCard, workshopClick, workshopInput, workshopChange, workshopSeg, serverFlow, loginFlow, workshopState } from './workshop.js';

const host = window.rwkit;
const api = (route, body) => host.api(route, body);
async function apiOk(route, body) { const r = await api(route, body); if (r && r.ok === false && !r.confirm) throw new Error(r.error || '操作失败'); return r; }

// ---------- 状态 ----------
const S = {
  env: null, app: null, settings: {}, projects: [], loose: [],
  view: 'project', sel: null, src: {}, tab: 'overview',
  content: { key: null }, ed: null, edCleanup: null, edSel: {}, navq: '', navClosed: new Set(),
  pf: null, pfCleanup: null,
  diff: { key: null }, base: {}, dopen: new Set(),
  logs: [], result: null, busy: false, bump: {}, samples: {},
};
const curProject = () => S.projects.find(p => p.id === S.sel) || null;
const allSrc = p => [...p.folders, ...p.packs];
function curSrc(p = curProject()) {
  if (!p) return null;
  const f = S.src[p.id], list = allSrc(p);
  return list.find(s => samePath(s.path, f)) || list.find(s => s.draft) || p.folders[0] || p.packs[0] || null;
}
function findByPath(path) { for (const p of S.projects) { const s = allSrc(p).find(x => samePath(x.path, path)); if (s) return { p, s }; } return null; }
function applyView(v) {
  if (!v || !Array.isArray(v.projects)) return;
  S.projects = v.projects; S.loose = v.loose || [];
  if (S.sel && !S.projects.some(p => p.id === S.sel) && !S.loose.some(l => samePath(l.path, S.sel))) S.sel = null;
  if (!S.sel && S.projects.length) S.sel = S.projects[0].id;
}
const bumpOn = f => (S.bump[f.path] !== undefined ? S.bump[f.path] : !!(f.target?.exists && f.vsSameVersion && !f.vsSameVersion.same));
const coverUrl = c => 'app://cover/?p=' + encodeURIComponent(c.path) + '&v=' + encodeURIComponent(c.v);
function thumb(p, size) {
  const ph = [...String(p.name || '?')][0] || '?';
  return `<div class="thumb ${size}" data-ph="${esc(ph)}" style="--h:${hue(p.id)}">${p.cover ? `<img src="${coverUrl(p.cover)}" alt="" loading="lazy">` : ''}</div>`;
}
document.addEventListener('error', e => { if (e.target.tagName === 'IMG' && e.target.closest('.thumb, .cover-box')) e.target.classList.add('broken'); }, true);
function busy(on) { S.busy = on; document.body.classList.toggle('busy', on); }
function logEntry(pid, title, r) { S.logs.push({ pid, time: Date.now(), title, ok: !!r.ok, text: r.log || r.error || '' }); if (S.logs.length > 300) S.logs.shift(); }

// ---------- 整体渲染 ----------
function render() {
  document.body.classList.toggle('side-collapsed', S.settings.sidebar === false);
  // 重绘时保留输入焦点与光标位置（编辑器内的 CodeMirror 不会被重绘）
  const ae = document.activeElement;
  const keep = ae && ae !== document.body && !ae.closest('.cm-editor') ? { id: ae.id, bind: ae.dataset?.bind, s: ae.selectionStart, e: ae.selectionEnd } : null;
  renderSide(); renderCrumb(); renderMain();
  if (keep && (keep.id || keep.bind)) {
    const el = keep.id ? document.getElementById(keep.id) : $(`#pbody [data-bind="${CSS.escape(keep.bind)}"]`);
    if (el && el !== document.activeElement) { el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch {} }
  }
}
function renderSide() {
  const collapsed = S.settings.sidebar === false;
  let h = `<div class="side-top">${collapsed ? `<button class="btn primary icon needs-idle" data-act="open-menu" title="打开或新建">${icon('plus')}</button>` : `<button class="btn primary block needs-idle" data-act="open-menu">${icon('plus')}打开或新建…</button>`}</div>`;
  h += `<div class="plist-side ws-side">${sideEntry(collapsed, S.view === 'workshop')}</div>`;
  if (S.projects.length) {
    if (!collapsed) h += `<div class="side-sec">项目 <span class="count">${S.projects.length}</span></div>`;
    h += '<div class="plist-side">';
    for (const p of S.projects) {
      const up = remoteNewer(p);
      h += `<div class="ps${p.id === S.sel && S.view !== 'workshop' ? ' sel' : ''}" data-act="select" data-id="${esc(p.id)}" title="${esc(p.name)}${up ? '（创意工坊有新版本 v' + up + '）' : ''}">
        ${thumb(p, 'sm')}
        <div class="ps-body"><div class="ps-name">${esc(p.name)}</div>
        <div class="ps-sub"><span>${esc(catLabel(p.category, p.kind))} · v${esc(p.version ?? '?')}</span>${p.folders.length ? `<span title="项目文件夹">${icon('folder', 'xs')}${p.folders.length}</span>` : ''}${p.packs.length ? `<span title="离线包">${icon('package', 'xs')}${p.packs.length}</span>` : ''}</div></div>
        ${up ? `<span class="ws-up" title="创意工坊有新版本 v${up}">${icon('arrowUp', 'xs')}</span>` : ''}${p.drafts ? `<span class="dot draft" title="有未保存的修改"></span>` : `<span class="dot ${p.level}" title="${esc(LV[p.level].t)}"></span>`}</div>`;
    }
    h += '</div>';
  }
  if (S.loose.length) {
    if (!collapsed) h += `<div class="side-sec">无法读取 <span class="count">${S.loose.length}</span></div>`;
    h += '<div class="plist-side">' + S.loose.map(l => `<div class="ps${samePath(l.path, S.sel) && S.view !== 'workshop' ? ' sel' : ''}" data-act="select-loose" data-path="${esc(l.path)}" title="${esc(l.path)}"><div class="thumb sm" data-ph="!" style="--h:0"></div><div class="ps-body"><div class="ps-name">${esc(l.file)}</div><div class="ps-sub">读取失败</div></div><span class="dot error"></span></div>`).join('') + '</div>';
  }
  const rk = S.env?.rwkit;
  h += `<div class="side-foot">${sideNotice(collapsed)}${collapsed ? `<span class="dot ${rk?.ok ? 'ok' : 'error'}" title="${rk?.ok ? 'rwkit 已就绪' : 'rwkit 载入失败'}"></span>${sideStatus(true)}` : `
    ${sideStatus(false)}
    <div class="row"><span class="dot ${rk?.ok ? 'ok' : 'error'}"></span><span class="ell">${rk ? (rk.ok ? 'rwkit 已就绪 · ' + esc(rk.label || '') : 'rwkit 载入失败') : ''}</span></div>
    <div class="row muted">v${esc(S.app?.version || '')} · Electron ${esc(S.app?.electron || '')}</div>`}</div>`;
  $('#side').innerHTML = h;
}
function renderCrumb() {
  if (S.view === 'workshop') { $('#crumb').innerHTML = wsCrumb(); return; }
  const p = curProject(), s = curSrc(p);
  $('#crumb').innerHTML = p ? `<span class="ell">${esc(p.name)}</span>${s ? `<span class="sep">/</span><span class="ell muted">${esc(s.file)}</span>` : ''}` : '';
}
function renderMain() {
  const m = $('#main');
  if (!S.env) return;
  if (S.view === 'workshop') { teardownEditor(); teardownPf(true); document.body.classList.remove('has-draftbar'); renderWorkshop(); return; }
  const loose = S.loose.find(l => samePath(l.path, S.sel));
  if (loose) { teardownEditor(); m.innerHTML = `<div class="page">${rwkitNotice()}${looseView(loose)}</div>`; return; }
  const p = curProject();
  if (!p) { teardownEditor(); m.innerHTML = welcome(); return; }
  const s = curSrc(p);
  if (!m.querySelector('.proj') || m.querySelector('.proj').dataset.pid !== p.id) {
    teardownEditor();
    m.innerHTML = `<div class="proj" data-pid="${esc(p.id)}"><div class="phead" id="phead"></div><nav class="ptabs" id="ptabs"></nav><div class="pbody" id="pbody"></div><div class="draftbar" id="draftbar" hidden></div></div>`;
  }
  $('#phead').innerHTML = rwkitNotice() + projHead(p, s);
  renderTabs(p, s);
  renderBody(p, s);
  renderDraftBar(p, s);
}
function rwkitNotice() {
  if (S.env?.rwkit?.ok) return '';
  return `<div class="notice error">${icon('xCircle')}<div><b>rwkit.mjs 载入失败，检查、编辑与打包暂时不可用</b><div class="small">${esc(S.env?.rwkit?.error || '')}</div><button class="btn sm" data-act="settings">${icon('settings')}在设置里选择 rwkit.mjs</button></div></div>`;
}
function welcome() {
  return `<div class="welcome">
    <div class="hero">${icon('package', 'hero-i')}<div><h1>轮回战场创意工坊 · 离线包工具</h1><p>检查与修复 .rwpack，直接编辑世界书、正则和脚本，再打包成新版本。所有检查都与 rwkit 命令行同一套规则。</p></div></div>
    <div class="dropzone">
      ${icon('upload', 'dz-i')}
      <div class="t">把 .rwpack 或项目文件夹拖到这里</div>
      <div class="s">也可以拖入装着它们的文件夹，一次全部打开</div>
      <div class="row center">
        <button class="btn primary needs-idle" data-act="open-packs">${icon('package')}打开离线包…</button>
        <button class="btn needs-idle" data-act="open-folders">${icon('folderOpen')}打开项目文件夹…</button>
        <button class="btn needs-idle" data-act="new-project">${icon('folderPlus')}新建项目…</button>
        <button class="btn ghost needs-idle" data-act="example">${icon('sparkles')}生成示例</button>
      </div>
      <div class="row center" style="margin-top:12px"><button class="btn ghost" data-act="ws-open">${icon('globe')}浏览创意工坊，下载别人的作品</button></div>
    </div>
    <div class="wsteps">
      ${[['pencil', '直接编辑', '打开 .rwpack 就能改：世界书条目、正则、脚本、项目资料都有对应的表单，修改先存在草稿里。'], ['save', '保存为新版本', '保存时自动升版本号、重算大小与 SHA-256，工坊可以直接导入。'], ['folder', '或者解包编辑', '需要用 VS Code 大量修改时，解包成项目文件夹；保存文件后这里自动重新检查。'], ['wrench', '一键修复', '手动改过 .rwpack、导入时报“校验失败”？打开它点“修复”即可。']].map(([i, t, d]) => `<div class="wstep">${icon(i)}<b>${t}</b><span>${d}</span></div>`).join('')}
    </div>
    <div class="learn">${icon('book')}<div><b>第一次写扩展？</b><span>编写教程讲解了世界书、正则（含 HTML 页面）、脚本、预设、数据、原版资源规则、依赖等全部工坊内容的写法，以及检查规则和常见的坑。</span></div><button class="btn" data-act="tutorial">${icon('book')}打开编写教程</button></div></div>`;
}
function looseView(l) {
  return `<div class="card"><div class="card-h">${icon(l.kind === 'pack' ? 'package' : 'folder')}${esc(l.file)}<span class="grow"></span>
    <button class="btn sm" data-act="reveal" data-path="${esc(l.path)}">${icon('external')}显示位置</button><button class="btn sm danger" data-act="remove-loose" data-path="${esc(l.path)}">${icon('x')}从列表移除</button></div>
    <div class="card-b">${problemsHtml(l)}</div></div>`;
}

// ---------- 项目页头 ----------
function projHead(p, s) {
  // 页头显示当前查看的这个版本的资料与状态
  const lv = s ? s.level : p.level;
  const status = s?.draft ? `<span class="pill draft">${icon('pencil')}未保存 ${s.draft.count} 处</span>` : lv !== 'ok' ? pill(lv) : '';
  const pj = s?.project?.name != null ? s.project : p;
  return `<div class="ph-main">
    ${thumb(p, 'md')}
    <div class="ph-text">
      <div class="ph-title"><h1>${esc(pj.name)}</h1><span class="pill acc">${esc(pj.category ? catLabel(pj.category, s?.project?.kind ?? p.kind) : '未知分类')}</span><span class="pill plain">v${esc(pj.version ?? '?')}</span>${status}</div>
      <div class="ph-sub ell">${esc(pj.summary || '（没有简介）')}</div>
    </div>
    <div class="ph-right">
      ${s ? `<button class="srcsel" data-act="src-menu" title="切换要查看和编辑的版本">${icon(s.kind === 'folder' ? 'folder' : 'package')}<span class="ss-t"><b class="ell">${esc(s.file)}</b><small>${s.kind === 'folder' ? '项目文件夹' : '离线包'} · v${esc(s.version ?? '?')}</small></span>${srcPill(s)}${icon('chevDown', 'xs')}</button>` : ''}
      ${s ? headActions(p, s) : ''}
    </div></div>`;
}
const simBtn = s => `<button class="btn" data-act="sim" data-path="${esc(s.path)}" title="在模拟酒馆里运行作品：脚本按钮与界面、正则页面、实时修改变量">${icon('tavern')}模拟预览</button>`;
function headActions(p, s) {
  if (s.kind === 'folder') {
    const b = bumpOn(s), t = b ? s.bumpTarget : s.target, upToDate = !b && s.target?.exists && s.vsSameVersion?.same;
    return `<div class="split"><button class="btn ${upToDate || s.level === 'error' ? '' : 'primary'} needs-idle" data-act="pack" data-path="${esc(s.path)}" ${s.level === 'error' ? 'disabled title="项目文件夹有错误，修正后才能打包"' : `title="${esc(t ? '生成 ' + t.file : '')}"`}>${icon('pack')}${b ? '打包并升为 v' + esc(t?.version) : upToDate ? '重新打包' : '打包 v' + esc(s.version)}</button><button class="btn ${upToDate || s.level === 'error' ? '' : 'primary'} icon needs-idle" data-act="pack-menu" data-path="${esc(s.path)}" title="打包选项">${icon('chevDown')}</button></div>
      ${simBtn(s)}<button class="btn icon" data-act="more-menu" title="更多">${icon('more')}</button>`;
  }
  if (s.draft) return `<div class="split"><button class="btn primary needs-idle" data-act="draft-save" data-path="${esc(s.path)}">${icon('save')}保存为 v${esc(Math.max((s.version || 0), (savedVersion(p, s) || 0) + 1))}</button><button class="btn primary icon needs-idle" data-act="draft-menu" data-path="${esc(s.path)}">${icon('chevDown')}</button></div>
    ${simBtn(s)}<button class="btn icon" data-act="more-menu" title="更多">${icon('more')}</button>`;
  return `${s.level === 'fix' ? `<button class="btn warnb needs-idle" data-act="fix" data-path="${esc(s.path)}" title="重算大小与 SHA-256 并覆盖原文件">${icon('wrench')}修复</button>` : ''}
    <button class="btn needs-idle" data-act="unpack" data-path="${esc(s.path)}" ${s.fatal ? 'disabled' : ''} title="拆成项目文件夹，适合用 VS Code 大量修改">${icon('unpack')}解包</button>
    ${simBtn(s)}<button class="btn icon" data-act="more-menu" title="更多">${icon('more')}</button>`;
}
const savedVersion = (p, s) => { const r = /-v(\d+)\.rwpack$/i.exec(s.file); return r ? Number(r[1]) : s.version; };
function renderTabs(p, s) {
  const nProb = s ? (s.fatal ? 1 : 0) + s.errors.length + s.warns.length + (s.needFix ? 1 : 0) : 0;
  const nLog = S.logs.filter(l => l.pid === p.id).length;
  const tabs = [['overview', '概览', 'home'], ['edit', '编辑内容', 'pencil'], ['checks', '检查结果', 'checkCircle', nProb, s?.level], ['changes', '改动对比', 'compare'], ['log', '操作记录', 'list', nLog, '']];
  $('#ptabs').innerHTML = tabs.map(([k, t, i, n, lv]) => `<button class="tab${S.tab === k ? ' on' : ''}" data-act="tab" data-tab="${k}">${icon(i, 'xs')}${t}${n ? `<span class="n ${lv || ''}">${n}</span>` : ''}</button>`).join('') + `<span class="grow"></span>${S.result && S.result.pid === p.id ? '' : ''}`;
}
function renderDraftBar(p, s) {
  const bar = $('#draftbar');
  document.body.classList.toggle('has-draftbar', !!s?.draft);
  if (!s?.draft) { bar.hidden = true; return; }
  bar.hidden = false;
  const v = Math.max(s.version || 0, (savedVersion(p, s) || 0) + 1);
  bar.innerHTML = `${icon('pencil')}<div class="db-t"><b>有 ${s.draft.count} 处未保存的修改</b><span>修改先保存在草稿里，${esc(s.file)} 还没有改动。保存时会自动升版本号并重新计算校验。</span></div>
    <button class="btn ghost" data-act="draft-undo" data-path="${esc(s.path)}" ${s.draft.undo ? '' : 'disabled'}>${icon('undo')}撤销</button>
    <button class="btn ghost danger" data-act="draft-discard" data-path="${esc(s.path)}">${icon('trash')}放弃修改</button>
    <button class="btn" data-act="draft-overwrite" data-path="${esc(s.path)}">覆盖原文件</button>
    <button class="btn primary needs-idle" data-act="draft-save" data-path="${esc(s.path)}">${icon('save')}保存为 v${v}</button>`;
}

// ---------- 页面主体 ----------
function renderBody(p, s) {
  const body = $('#pbody');
  body.classList.toggle('fill', S.tab === 'edit');
  if (S.tab !== 'edit') teardownEditor();
  if (S.tab !== 'overview') teardownPf();
  if (!s) { body.innerHTML = '<div class="empty">这个项目没有可用的版本。</div>'; return; }
  if (S.tab === 'edit') return renderEdit(p, s);
  if (S.tab === 'overview') return renderOverview(p, s);
  const res = resultCard(p);
  if (S.tab === 'checks') body.innerHTML = `<div class="page">${res}${problemsHtml(s)}${s.fatal ? '' : aiReviewCard(s)}</div>`;
  else if (S.tab === 'changes') body.innerHTML = `<div class="page">${res}${changesHtml(p, s)}</div>`;
  else body.innerHTML = `<div class="page">${res}${logHtml(p)}</div>`;
}
function resultCard(p) {
  const r = S.result;
  if (!r || r.pid !== p.id) return '';
  return `<div class="result ${r.ok ? 'ok' : 'bad'}">${icon(r.ok ? 'checkCircle' : 'xCircle')}<div class="rb"><div class="rt">${esc(r.title)}</div>${(r.lines || []).map(l => `<div class="rl">${esc(l)}</div>`).join('')}
    ${r.actions?.length ? `<div class="ra">${r.actions.join('')}</div>` : ''}</div><button class="btn ghost sm icon" data-act="dismiss" title="关闭">${icon('x')}</button></div>`;
}

// ---------- 概览 ----------
async function renderOverview(p, s) {
  const body = $('#pbody');
  const key = s.path + '|' + s.sig;
  if (!S.pf || S.pf.key !== key) {
    if (S.pf?.dirty && samePath(S.pf.path, s.path)) {
      // 外部改动时保留正在编辑的内容
    } else {
      teardownPf();
      body.innerHTML = `<div class="page"><div class="loading"><span class="spin"></span>读取中…</div></div>`;
      let d;
      try { d = await apiOk('project', { path: s.path }); } catch (e) { body.innerHTML = `<div class="page">${resultCard(p)}<div class="banner error">${icon('xCircle')}<div class="bb"><div class="bt">无法读取项目资料</div><div class="bs">${esc(e.message)}</div></div></div>${sideCards(p, s)}</div>`; return; }
      if (curSrc() !== s && !samePath(curSrc()?.path, s.path)) return;
      const f = { name: d.project.name ?? '', category: d.project.category || 'extension', version: d.project.version ?? 1, summary: d.project.summary ?? '', tags: Array.isArray(d.project.tags) ? d.project.tags : [], dependencies: clone(d.project.dependencies || []), overrides: clone(d.overrides || []) };
      S.pf = { key, path: s.path, type: 'project', data: { kind: 'project', ...d }, form: f, orig: clone(f), dirty: false, names: Object.fromEntries(S.projects.map(x => [x.id, x.name])) };
    }
  }
  S.pf.key = key;
  const f = S.pf.form, d = S.pf.data;
  teardownPf(true);
  body.innerHTML = `<div class="page ov">${resultCard(p)}<div class="ov-grid">
    <div class="ov-main">
      <div class="card" id="pfcard">
        <div class="card-h">${icon('pencil')}项目资料<button class="btn xs ghost" data-act="tutorial" data-sec="project" title="编写教程：项目资料">${icon('book')}教程</button><span class="grow"></span><span class="ed-state ${S.pf.dirty ? 'dirty' : ''}" data-pf-state>${S.pf.dirty ? icon('dot') + '有未保存的修改' : ''}</span>
          <button class="btn sm" data-act="pf-revert" ${S.pf.dirty ? '' : 'disabled'}>${icon('undo')}还原</button><button class="btn sm primary" data-act="pf-save" ${S.pf.dirty ? '' : 'disabled'}>${icon('save')}保存</button></div>
        <div class="card-b form">
          ${F.field('名称', `<div class="cnt-wrap"><input class="input" data-bind="name" data-type="text" value="${esc(f.name)}" placeholder="项目名称" spellcheck="false" maxlength="${LIM.name}" data-max="${LIM.name}">${counter(f.name, LIM.name)}</div>`)}
          ${F.field('分类', catField(f, d))}
          ${F.field('版本号', `<div class="row">${F.num('version', f.version)}<span class="fhint" style="margin:0">工坊靠它识别新版本：已安装的同一版本不能直接覆盖导入。</span></div>`)}
          ${F.field('简介', `<div class="cnt-wrap"><textarea class="input" rows="4" data-bind="summary" data-type="text" placeholder="显示在工坊作品卡片与“本地”页上" maxlength="${LIM.summary}" data-max="${LIM.summary}">${esc(f.summary)}</textarea>${aiIn('作品简介（显示在创意工坊作品卡片上，不超过 2000 字）')}${counter(f.summary, LIM.summary)}</div>`)}
          ${F.field('标签', F.chips('tags', f.tags, '输入后按回车'), `最多 ${LIM.tags} 个，每个不超过 ${LIM.tag} 个字（创意工坊的上限）。`)}
          ${F.field('项目 id', `<div class="row"><span class="mono small">${esc(d.project.id)}</span><button class="btn xs ghost" data-act="copy" data-text="${esc(d.project.id)}">${icon('copy')}复制</button></div>`, '依赖这个项目时要填写它。新建项目时自动生成，不要修改。')}
          <div class="form-sec"><h4>${icon('link', 'xs')}依赖 <span class="muted small">需要先安装的其他工坊项目，最多 12 个</span><button class="btn xs ghost icon" data-act="tutorial" data-sec="deps" title="编写教程：依赖">${icon('help')}</button></h4>${listHtml('dependencies', S.pf)}</div>
          <div class="form-sec"><h4>${icon('sliders', 'xs')}原版资源规则 <span class="muted small">安装后停用或启用原版角色卡里的资源，卸载时恢复</span><button class="btn xs ghost icon" data-act="tutorial" data-sec="overrides" title="编写教程：原版资源规则">${icon('help')}</button></h4>${listHtml('overrides', S.pf)}</div>
        </div>
      </div>
    </div>
    <div class="ov-side">
      <div class="card"><div class="card-h">${icon('image')}封面</div><div class="card-b">
        <div class="cover-box">${d.hasCover ? `<img src="${coverUrl({ path: s.path, v: s.sig })}" alt="">` : `<div class="cover-empty">${icon('image')}<span>没有封面</span></div>`}</div>
        <div class="row" style="margin-top:10px"><button class="btn sm needs-idle" data-act="cover-pick">${icon('upload')}${d.hasCover ? '更换图片…' : '选择图片…'}</button>${d.hasCover ? `<button class="btn sm ghost danger needs-idle" data-act="cover-remove">${icon('trash')}移除</button>` : ''}</div>
        <div class="fhint">建议 16:9，几百 KB 以内（离线包总大小不能超过 6 MB）。发布到创意工坊需要封面，且只能是 PNG、JPEG、WebP，不超过 3 MB${d.cover && (!['image/png', 'image/jpeg', 'image/webp'].includes(d.cover.type) || d.cover.size > 3145728) ? '<br><span class="warn-text">当前封面不能用于工坊。</span>' : ''}。</div></div></div>
      ${sideCards(p, s)}
    </div></div>
    <datalist id="known-projects">${S.projects.filter(x => x.id !== p.id).map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</datalist></div>`;
  S.pfCleanup = bindEditor($('#pfcard'), S.pf, {
    changed: () => {
      const st = $('[data-pf-state]'); if (st) st.innerHTML = S.pf.dirty ? icon('dot') + '有未保存的修改' : '';
      $$('[data-act="pf-revert"],[data-act="pf-save"]').forEach(b => { b.disabled = !S.pf.dirty; });
    },
    save: () => savePf(), action: () => {}, syntax: async () => ({ ok: true }),
  });
  $('#pfcard').addEventListener('click', e => { const seg = e.target.closest('[data-seg="pfcat"] button'); if (seg) pickCategory(seg.dataset.v, s); });
}
// 工坊的四种分类：扩展 / 角色 / 开局商店 / 副本。开局商店与副本在服务器上属于“扩展”，由内容里的数据决定（副本优先）
const LIM = { name: 80, summary: 2000, tags: 12, tag: 24, changelog: 2000 };
// 当前的分类：扩展里的具体类型由内容决定，副本数据优先于开局商店目录（与工坊相同）
const curCat = (f, d) => displayCat(f.category, f.category === 'character' ? d.kind : d.hasScenario ? 'scenario' : d.hasStore ? 'store_catalog' : 'extension');
function catField(f, d) {
  const cur = curCat(f, d);
  const seg = `<div class="seg" data-seg="pfcat">${[['extension', '扩展'], ['character', '角色'], ['store_catalog', '开局商店'], ['scenario', '副本']].map(([v, t]) => `<button type="button" data-v="${v}" class="${cur === v ? 'on' : ''}">${t}</button>`).join('')}</div>`;
  const hint = cur === 'character' ? `角色用途：<b>${esc(KIND_LABEL[d.kind] || '世界书角色')}</b>（由内容决定：带 kind 为 opening_character / opening_partner 的数据时是开局角色 / 开局伙伴，否则是世界书角色）`
    : cur === 'scenario' ? '项目里有副本数据（kind 为 scenario 的数据），工坊会把它归为“副本”。在“编辑内容”里打开副本数据，用副本编辑器填写世界与章节；保存时自动生成副本世界书。'
    : cur === 'store_catalog' ? '项目里有开局商店目录（kind 为 store_catalog 的数据），工坊会把它归为“开局商店”。'
      : '通用扩展：世界书、正则、脚本等。';
  return seg + `<div class="fhint">${hint}</div>`;
}
function markPfDirty() {
  S.pf.dirty = stable(S.pf.form) !== stable(S.pf.orig);
  $('[data-pf-state]').innerHTML = S.pf.dirty ? icon('dot') + '有未保存的修改' : '';
  $$('[data-act="pf-revert"],[data-act="pf-save"]').forEach(b => { b.disabled = !S.pf.dirty; });
}
// 没有改分类（被拒绝或取消）时，把分类按钮恢复成当前的分类
function restoreCat() {
  const f = S.pf?.form, d = S.pf?.data; if (!f || !d) return;
  const cur = curCat(f, d);
  $$('[data-seg="pfcat"] button').forEach(b => b.classList.toggle('on', b.dataset.v === cur));
}
async function pickCategory(v, s) {
  const d = S.pf.data;
  if (v === 'character') {
    // 工坊允许角色作品带开局商店目录（按角色显示，安装时目录仍生效），但通常是误操作，先确认
    if (d.hasStore || d.hasScenario) {
      const what = d.hasScenario ? '副本数据' : '开局商店目录';
      const ok = await ask({ title: '项目里有' + what, html: `<p>改为“角色”后，工坊按角色显示这个作品，但安装时${what}仍会生效。</p><p>如果要做角色作品，通常应该先在“编辑内容”里删除那份${what}。</p>`, buttons: [{ label: '取消', value: null }, { label: '仍然改为角色', value: 'ok' }] });
      if (ok !== 'ok') { restoreCat(); return; }
    }
    S.pf.form.category = 'character'; markPfDirty(); renderBody(curProject(), curSrc()); return;
  }
  if (d.hasScenario && (v === 'extension' || v === 'store_catalog')) {
    await ask({ title: '项目里有副本数据', html: '<p>带副本数据（kind 为 scenario 的数据）的扩展，工坊（客户端与服务器）都会归为“副本”，不能作为' + (v === 'extension' ? '通用扩展' : '开局商店') + '。要改分类，请先在“编辑内容”里删除那份副本数据。</p>', buttons: [{ label: '知道了', value: null, primary: true }] });
    restoreCat();
    return;
  }
  if (v === 'scenario' && d.hasScenario) { S.pf.form.category = 'extension'; markPfDirty(); renderBody(curProject(), curSrc()); return; }
  if (v === 'scenario') {
    const ok = await ask({ title: '改为副本', html: '<p>副本需要一份副本数据：会新建数据 artifact“' + esc(S.pf.form.name || '副本') + '.scenario.json”。在“编辑内容”里打开它，用副本编辑器填写世界名称、开局信息与章节；保存时自动生成副本世界书。</p>' + (d.hasStore ? '<p class="warn-text">项目里的开局商店目录仍会在安装时生效，但作品会归为“副本”。</p>' : '') + '<p class="muted small">写法见编写教程“副本”。</p>', buttons: [{ label: '取消', value: null }, { label: '添加副本数据', value: 'ok', primary: true }] });
    if (ok !== 'ok') { restoreCat(); return; }
    if (S.pf.dirty) await savePf();
    busy(true);
    try {
      applyView(await apiOk('edit', { path: s.path, op: { op: 'addArtifact', kind: 'data', name: (S.pf?.form.name || curProject()?.name || '副本') + '.scenario.json', template: 'scenario' } }));
      if (curProject()?.category === 'character') applyView(await apiOk('edit', { path: s.path, op: { op: 'project', fields: { category: 'extension' } } }));
      S.pf = null; toast('已添加副本数据，在“编辑内容”里填写', 'ok');
    } catch (err) { toast(err.message, 'error', 6000); }
    busy(false); render(); return;
  }
  if (v === 'extension' && d.hasStore) {
    await ask({ title: '项目里有开局商店目录', html: '<p>带开局商店目录（kind 为 store_catalog 的数据）的扩展，工坊（客户端与服务器）都会归为“开局商店”，不能作为通用扩展。要改成通用扩展，请先在“编辑内容”里删除那份数据。</p>', buttons: [{ label: '知道了', value: null, primary: true }] });
    restoreCat();
    return;
  }
  if (v === 'store_catalog' && !d.hasStore) {
    const ok = await ask({ title: '改为开局商店', html: '<p>开局商店需要一份开局商店目录：会新建数据 artifact“' + esc(S.pf.form.name || '开局商店') + '.store.json”，里面是空的装备、道具、技能目录，在“编辑内容”里补充商品。</p><p class="muted small">商品字段见编写教程“开局商店”。</p>', buttons: [{ label: '取消', value: null }, { label: '添加开局商店目录', value: 'ok', primary: true }] });
    if (ok !== 'ok') { restoreCat(); return; }
    if (S.pf.dirty) await savePf();
    busy(true);
    try {
      applyView(await apiOk('edit', { path: s.path, op: { op: 'addArtifact', kind: 'data', name: (S.pf?.form.name || curProject()?.name || '开局商店') + '.store.json', template: 'store_catalog' } }));
      if (curProject()?.category === 'character') applyView(await apiOk('edit', { path: s.path, op: { op: 'project', fields: { category: 'extension' } } }));
      S.pf = null; toast('已添加开局商店目录', 'ok');
    } catch (err) { toast(err.message, 'error', 6000); }
    busy(false); render(); return;
  }
  S.pf.form.category = 'extension'; markPfDirty(); renderBody(curProject(), curSrc());
}
function teardownPf(keepState) { if (S.pfCleanup) { S.pfCleanup(); S.pfCleanup = null; } if (!keepState && S.pf && !S.pf.dirty) S.pf = null; }
async function savePf() {
  const pf = S.pf; if (!pf?.dirty) return;
  const f = pf.form, o = pf.orig;
  const fields = {};
  for (const k of ['name', 'category', 'version', 'summary', 'tags', 'dependencies']) if (stable(f[k]) !== stable(o[k])) fields[k] = k === 'dependencies' ? f[k].filter(x => String(x.project_id || '').trim()) : f[k];
  busy(true);
  try {
    if (Object.keys(fields).length) applyView(await apiOk('edit', { path: pf.path, op: { op: 'project', fields } }));
    if (stable(f.overrides) !== stable(o.overrides)) {
      const list = f.overrides.map(r => { const t = { ...r.target }; for (const k of Object.keys(t)) if (t[k] === '' || t[k] == null) delete t[k]; if (r.kind === 'regex') t.scope = 'character'; return { kind: r.kind, state: r.state, target: t }; });
      applyView(await apiOk('edit', { path: pf.path, op: { op: 'overrides', list } }));
    }
    S.pf = null;
    toast('项目资料已保存', 'ok', 1800);
  } catch (e) { toast(e.message, 'error', 6000); }
  busy(false);
  render();
}
function sideCards(p, s) {
  return nextCard(p) + tavernCard(p) + projectCard(p) + versionsCard(p, s) + limitsCard(s);
}
function nextCard(p) {
  const f = p.folders[0], k = p.packs.find(x => !x.draft) || p.packs[0], d = p.packs.find(x => x.draft);
  let steps, cur, cta = '';
  if (d) {
    steps = [['编辑', '在“编辑内容”里修改'], ['保存为新版本', '保存草稿，自动升版本号'], ['导入工坊', '在工坊“本地”页导入，或安装到 SillyTavern']]; cur = 1;
    cta = `<button class="btn primary block needs-idle" data-act="draft-save" data-path="${esc(d.path)}">${icon('save')}保存修改</button>`;
  } else if (f) {
    steps = [['编辑', f.level === 'error' ? '项目文件夹有错误，需要修正' : '直接编辑，或用 VS Code 修改'], ['打包', !k ? '还没有打过包' : f.vsNewest?.same ? '已打包为 ' + k.file : '有未打包的改动'], ['导入工坊', '在工坊“本地”页导入，或安装到 SillyTavern']];
    cur = f.level === 'error' ? 0 : (!k || !f.vsNewest?.same) ? 1 : 2;
    cta = cur === 0 ? `<button class="btn primary block" data-act="tab" data-tab="checks">${icon('alert')}查看问题</button>`
      : cur === 1 ? `<button class="btn primary block needs-idle" data-act="pack" data-path="${esc(f.path)}">${icon('pack')}${bumpOn(f) ? '打包并升为 v' + esc(f.bumpTarget?.version) : '打包 v' + esc(f.version)}</button>`
        : `<button class="btn block" data-act="reveal" data-path="${esc(k.path)}">${icon('external')}显示离线包位置</button>`;
  } else if (k) {
    steps = [['编辑', k.level === 'fix' ? '先修复校验' : '直接编辑内容，或解包后编辑'], ['保存为新版本', '自动升版本号与重算校验'], ['导入工坊', '在工坊“本地”页导入，或安装到 SillyTavern']];
    cur = 0;
    cta = k.level === 'fix' ? `<button class="btn warnb block needs-idle" data-act="fix" data-path="${esc(k.path)}">${icon('wrench')}修复</button>` : `<button class="btn primary block" data-act="tab" data-tab="edit">${icon('pencil')}开始编辑</button>`;
  } else return '';
  return `<div class="card"><div class="card-h">${icon('zap')}下一步</div><div class="card-b"><ol class="vsteps">${steps.map(([t, sub], i) => `<li class="${i < cur ? 'done' : i === cur ? 'cur' : ''}"><span class="vs-n">${i < cur ? icon('check', 'xs') : i + 1}</span><div><b>${t}</b><small>${esc(sub)}</small></div></li>`).join('')}</ol>${cta}</div></div>`;
}
function versionsCard(p, s) {
  const row = x => `<div class="vrow${samePath(x.path, s.path) ? ' sel' : ''}" data-act="src" data-path="${esc(x.path)}" title="${esc(x.path)}">
    ${icon(x.kind === 'folder' ? 'folder' : 'package')}<div class="vr-main"><div class="ell"><b>${esc(x.file)}</b></div><small>${x.kind === 'folder' ? '项目文件夹 · ' : ''}v${esc(x.version ?? '?')} · ${x.kind === 'folder' ? (x.fatal ? '读取出错' : !x.vsNewest ? '尚未打包' : x.vsNewest.same ? '与 ' + esc(x.vsNewest.file) + ' 一致' : '<span class="chg">有未打包的改动</span>') : esc(fmtSize(x.size)) + ' · ' + esc(fmtTime(x.mtime))}</small></div>
    ${srcPill(x)}<button class="btn xs ghost icon" data-act="row-menu" data-path="${esc(x.path)}" title="操作">${icon('more')}</button></div>`;
  return `<div class="card"><div class="card-h">${icon('layers')}版本 <span class="count">${allSrc(p).length}</span></div><div class="vlist">${allSrc(p).map(row).join('')}</div></div>`;
}
function limitsCard(s) {
  const bytes = s.bytes ?? s.size ?? 0;
  const meter = (label, n, max, unit = '') => `<div class="lim"><div class="lim-t"><span>${label}</span><b>${esc(n)}${unit} / ${max}${unit}</b></div><div class="meter ${n > max ? 'over' : n > max * 0.8 ? 'hi' : ''}"><i style="width:${Math.min(100, (n / max) * 100).toFixed(1)}%"></i></div></div>`;
  return `<div class="card"><div class="card-h">${icon('sliders')}体积与限制</div><div class="card-b">
    ${meter('离线包大小', Number((bytes / 1048576).toFixed(2)), 6, ' MB')}
    ${meter('artifact 数量', s.artifactCount ?? 0, 32)}
    </div></div>`;
}

// ---------- 编辑 ----------
async function renderEdit(p, s) {
  const body = $('#pbody');
  if (!body.querySelector('.editor-wrap') || body.querySelector('.editor-wrap').dataset.path !== s.path) {
    teardownEditor();
    body.innerHTML = `<div class="editor-wrap" data-path="${esc(s.path)}"><aside class="nav" id="nav"><div class="nav-tools"><div class="search">${icon('search')}<input class="input" id="navq" placeholder="搜索名称、关键词、正文…" value="${esc(S.navq)}" spellcheck="false"></div><button class="btn icon" data-act="new-menu-edit" title="新建">${icon('plus')}</button></div><div class="nav-list" id="navlist"><div class="loading"><span class="spin"></span></div></div></aside><section class="edpane" id="edpane"></section></div>`;
  }
  const key = s.path + '|' + s.sig;
  if (S.content.key !== key) {
    S.content = { key, loading: true };
    try { const d = await apiOk('content', { path: s.path }); if (S.content.key === key) S.content = { key, data: d }; }
    catch (e) { if (S.content.key === key) S.content = { key, error: e.message }; }
  }
  if (S.tab !== 'edit' || !samePath(curSrc()?.path, s.path)) return;
  renderNav(s);
  const sel = S.edSel[s.path];
  if (S.content.error) {
    teardownEditor();
    $('#edpane').innerHTML = `<div class="ed-empty">${icon('xCircle', 'big err')}<b>现在无法编辑</b><span>${esc(S.content.error)}</span><button class="btn primary" data-act="tab" data-tab="checks">${icon('alert')}查看检查结果</button></div>`;
    return;
  }
  if (!sel) { if (!S.ed) $('#edpane').innerHTML = edEmpty(); return; }
  if (S.ed && samePath(S.ed.path, s.path) && S.ed.a === sel.a && S.ed.key === sel.key && S.ed.mode === sel.mode) { await syncEditor(s); return; }
  await openEditor(s, sel);
}
function edEmpty() {
  return `<div class="ed-empty">${icon('pencil', 'big')}<b>选择左侧的一项开始编辑</b><span>世界书条目、正则、脚本都有对应的表单；正文与代码支持高亮、查找替换（Ctrl+F）。</span>
    <div class="kbd-hints"><span><kbd>Ctrl</kbd>+<kbd>S</kbd> 保存</span><span><kbd>Ctrl</kbd>+<kbd>F</kbd> 查找</span><span><kbd>F5</kbd> 重新检查</span><span><kbd>F1</kbd> 编写教程</span></div>
    <button class="btn" data-act="tutorial">${icon('book')}不知道怎么写？看扩展编写教程</button></div>`;
}
function itemSub(a, it) {
  const s = it.sum || {};
  if (a.kind === 'worldbook') return s.constant ? '常驻' + (s.keys?.length ? ' · ' + s.keys.join('、') : '') : s.keys?.length ? s.keys.join('、') : '没有关键词';
  if (a.kind === 'regex') return s.find || '（未填查找）';
  if (a.kind === 'script') return (it.folder ? it.folder + ' / ' : '') + (s.buttons?.length ? '按钮：' + s.buttons.join('、') : '');
  return s.topKeys?.length ? s.topKeys.join('、') : '';
}
function renderNav(s) {
  const el = $('#navlist'); if (!el) return;
  const d = S.content.data;
  if (!d) { el.innerHTML = S.content.error ? `<div class="nav-err">${icon('xCircle')}读取失败</div>` : '<div class="loading"><span class="spin"></span></div>'; return; }
  const q = S.navq.trim().toLowerCase();
  const issues = new Map();
  for (const w of [...s.errors.map(x => ({ ...x, lv: 'error' })), ...s.warns.map(x => ({ ...x, lv: 'warn' }))]) {
    if (w.art == null) continue;
    const k = w.art + '|' + (w.key ?? '');
    if (!issues.has(k) || w.lv === 'error') issues.set(k, w.lv);
    if (!issues.has(w.art + '|*') || w.lv === 'error') issues.set(w.art + '|*', w.lv);
  }
  const sel = S.edSel[s.path];
  let h = `<button class="nav-proj" data-act="tab" data-tab="overview">${icon('home', 'xs')}项目资料、依赖与原版资源规则${icon('chevRight', 'xs')}</button>`;
  for (const a of d.artifacts) {
    const items = a.items.filter(it => !q || [it.label, it.uid, it.preview, it.folder, it.sum?.find, ...(it.sum?.keys || []), ...(it.sum?.buttons || [])].some(x => x != null && String(x).toLowerCase().includes(q)) || a.name.toLowerCase().includes(q));
    if (q && !items.length) continue;
    const ck = s.path + '|' + a.index, closed = !q && S.navClosed.has(ck);
    const artSel = sel && sel.mode === 'artifact' && sel.a === a.index;
    const iss = issues.get(a.index + '|*');
    h += `<div class="nav-art${closed ? ' closed' : ''}">
      <div class="nav-art-h${artSel ? ' sel' : ''}" data-act="nav-art" data-a="${a.index}">
        ${icon('chevDown', 'xs chev')}<span class="kicon ${a.kind}">${icon(KIND_ICON[a.kind] || 'file', 'xs')}</span><span class="na-name ell" title="${esc(a.name)}">${esc(a.name)}</span>
        ${iss ? `<span class="dot ${iss}"></span>` : ''}<span class="na-count">${a.items.length}</span>
        <span class="na-acts">${['worldbook', 'regex', 'script'].includes(a.kind) && a.format !== 'text' ? `<button class="btn xs ghost icon" data-act="add-item" data-a="${a.index}" title="新建${a.kind === 'worldbook' ? '条目' : a.kind === 'regex' ? '正则' : '脚本'}">${icon('plus')}</button>` : ''}<button class="btn xs ghost icon" data-act="art-settings" data-a="${a.index}" title="artifact 设置">${icon('settings')}</button></span>
      </div>
      <div class="nav-items">${items.map(it => {
        const isSel = sel && sel.mode === 'item' && sel.a === a.index && sel.key === it.key;
        const dirty = isSel && S.ed?.dirty;
        const flags = [];
        const sm = it.sum || {};
        if (a.kind === 'worldbook') { if (sm.disable) flags.push('<span class="flag off">停用</span>'); else if (sm.constant) flags.push('<span class="flag const">常驻</span>'); if (sm.position === 4) flags.push(`<span class="flag">@${esc(sm.depth ?? '')}</span>`); }
        if (a.kind === 'regex') { if (sm.disabled) flags.push('<span class="flag off">停用</span>'); if (sm.page) flags.push('<span class="flag page">页面</span>'); if (sm.promptOnly) flags.push('<span class="flag">仅 AI</span>'); }
        if (a.kind === 'script' && !sm.enabled) flags.push('<span class="flag off">停用</span>');
        const iv = issues.get(a.index + '|' + it.key);
        return `<div class="nav-item${isSel ? ' sel' : ''}${sm.disable || sm.disabled || (a.kind === 'script' && !sm.enabled) ? ' dim' : ''}" data-act="nav-item" data-a="${a.index}" data-key="${esc(it.key)}" title="${esc(it.label)}">
          <div class="ni-main"><div class="ni-label">${dirty ? '<span class="dot draft"></span>' : ''}${a.kind === 'worldbook' && it.uid != null ? `<span class="ni-uid">${esc(it.uid)}</span>` : ''}<span class="ell">${esc(it.label || '（无名称）')}</span></div><div class="ni-sub ell">${esc(itemSub(a, it))}</div></div>
          <div class="ni-flags">${flags.join('')}${iv ? `<span class="dot ${iv}"></span>` : ''}</div></div>`;
      }).join('') || '<div class="nav-none">没有匹配的项</div>'}</div></div>`;
  }
  h += `<button class="nav-new" data-act="new-artifact">${icon('plus', 'xs')}新建 artifact（世界书、正则、脚本…）</button>`;
  const st = el.scrollTop;
  el.innerHTML = h;
  el.scrollTop = st;
}
function edCtx(s) {
  const ed = S.ed;
  const issues = [...s.errors.map(x => ({ ...x, level: 'error' })), ...s.warns.map(x => ({ ...x, level: 'warn' }))].filter(w => w.art === ed.a && (ed.mode === 'artifact' ? w.key == null : w.key === ed.key));
  const file = ed.data.file || ed.data.folder;
  return {
    warns: issues, isFolder: s.kind === 'folder', file, rel: file && s.kind === 'folder' ? file.slice(s.path.length + 1) : '',
    index: ed.a, sample: S.samples[s.path + '|' + ed.a + '|' + ed.key] || '',
    setSample: v => { S.samples[s.path + '|' + ed.a + '|' + ed.key] = v; },
    changed: () => { updateEdFoot(); markNavDirty(); },
    save: () => saveEditor(), syntax: code => api('syntax', { code }),
    action: (act, el) => edAction(act, el),
    ai: (e, cm) => aiAssist({ field: AI_FIELD[e.type === 'raw' && e.data.json ? 'json' : e.type] || '内容', target: cmTarget(cm), context: aiContext(e) }),
  };
}
// AI 帮写：告诉模型正在写哪里，以及所在条目的名称、关键词等
const AI_FIELD = { entry: '世界书条目正文', regex: '正则的替换内容（匹配到的文字会被替换成它）', script: '酒馆助手脚本（JavaScript）', scriptText: '酒馆助手脚本（JavaScript）', raw: '文本内容', json: 'JSON 数据（预设或数据）' };
function aiContext(e) {
  const f = e.form, l = [];
  if (e.type === 'entry') { l.push('条目名称：' + (f.comment || '（未命名）')); l.push(f.constant ? '触发：常驻' : '关键词：' + ((f.key || []).join('，') || '（无）')); }
  if (e.type === 'regex') { l.push('正则名称：' + (f.scriptName || '')); l.push('查找：' + (f.findRegex ?? '')); }
  if (e.type === 'script') { l.push('脚本名称：' + (f.name || '')); if (f.info) l.push('说明：' + f.info); const b = (f.button?.buttons || []).map(x => x?.name).filter(Boolean); if (b.length) l.push('按钮：' + b.join('，')); }
  return l.length ? '【所在条目】\n' + l.join('\n') : '';
}
function teardownEditor() { if (S.edCleanup) { S.edCleanup(); S.edCleanup = null; } S.ed = null; }
async function loadDetail(s, sel) {
  if (sel.mode === 'artifact') return { ...(await apiOk('artifact', { path: s.path, a: sel.a })), type: 'artifact' };
  return apiOk('detail', { path: s.path, a: sel.a, key: sel.key });
}
async function openEditor(s, sel) {
  const pane = $('#edpane'); if (!pane) return;
  teardownEditor();
  pane.innerHTML = '<div class="loading"><span class="spin"></span>读取中…</div>';
  let d;
  try { d = await loadDetail(s, sel); }
  catch (e) { pane.innerHTML = `<div class="ed-empty">${icon('alert', 'big')}<b>无法打开这一项</b><span>${esc(e.message)}</span></div>`; delete S.edSel[s.path]; return; }
  const cur = S.edSel[s.path];
  if (!cur || cur.a !== sel.a || cur.key !== sel.key || cur.mode !== sel.mode) return;
  const ed = makeEd(s.path, sel.a, sel.mode === 'artifact' ? null : sel.key, d);
  ed.mode = sel.mode; ed.sig = d.sig;
  mountEditor(s, ed);
}
function mountEditor(s, ed) {
  const pane = $('#edpane');
  if (S.edCleanup) { S.edCleanup(); S.edCleanup = null; }
  S.ed = ed;
  const ctx = edCtx(s);
  pane.innerHTML = editorHtml(ed, ctx);
  S.edCleanup = bindEditor(pane.firstElementChild, ed, ctx);
}
// 来源变化（保存、外部修改）后同步编辑器
async function syncEditor(s) {
  const ed = S.ed; if (!ed || ed.sig === s.sig) return;
  let d;
  try { d = await loadDetail(s, { a: ed.a, key: ed.key, mode: ed.mode }); } catch { return; }
  if (S.ed !== ed) return;
  const fresh = makeEd(ed.path, ed.a, ed.key, d);
  fresh.mode = ed.mode; fresh.sig = d.sig;
  if (stable(fresh.orig) === stable(ed.orig)) { ed.sig = d.sig; ed.data = { ...ed.data, ...d }; refreshEdWarns(s); return; }
  if (!ed.dirty) { mountEditor(s, fresh); return; }
  // 正在编辑时文件被外部修改：提示而不是覆盖
  const pane = $('#edpane .ed-body');
  if (pane && !$('.ed-conflict', pane)) pane.insertAdjacentHTML('afterbegin', `<div class="ed-conflict">${icon('alert')}<span>这一项刚被外部修改（例如在 VS Code 里保存了文件）。</span><button class="btn xs" data-act="ed-reload">载入外部修改</button><button class="btn xs ghost" data-act="ed-keep">保留我的修改</button></div>`);
  ed.pendingFresh = fresh;
}
function refreshEdWarns(s) {
  const box = $('#edpane .ed-warns'); const ctx = edCtx(s);
  const html = ctx.warns.length ? `<div class="ed-warns">${ctx.warns.map(w => `<div class="ed-warn ${w.level}">${icon(w.level === 'error' ? 'xCircle' : 'alert')}<span>${esc(w.text.replace(/^“.+?”\s*/, ''))}</span></div>`).join('')}</div>` : '';
  if (box) box.outerHTML = html || '<span></span>';
  else if (html) $('#edpane .ed-body')?.insertAdjacentHTML('afterbegin', html);
}
function updateEdFoot() {
  const ed = S.ed, foot = $('#edpane .ed-foot'); if (!ed || !foot) return;
  const s = curSrc(); foot.outerHTML = footHtml(ed, edCtx(s));
}
function markNavDirty() {
  const ed = S.ed; if (!ed || ed.mode !== 'item') return;
  const row = $(`#navlist .nav-item[data-a="${ed.a}"][data-key="${CSS.escape(ed.key)}"] .ni-label`);
  if (!row) return;
  const dot = row.querySelector('.dot.draft');
  if (ed.dirty && !dot) row.insertAdjacentHTML('afterbegin', '<span class="dot draft"></span>');
  if (!ed.dirty && dot) dot.remove();
}
async function confirmLeaveEditor() {
  if (!S.ed?.dirty) return true;
  const v = await ask({ title: '有未保存的修改', html: `<p>“${esc(S.ed.data.label || S.ed.form.comment || S.ed.form.scriptName || S.ed.form.name || '')}”的修改还没有保存。</p>`, buttons: [{ label: '取消', value: null }, { label: '不保存', value: 'drop', danger: true }, { label: '保存', value: 'save', primary: true }] });
  if (v === 'save') return saveEditor();
  if (v === 'drop') { S.ed.dirty = false; return true; }
  return false;
}
async function selectItem(sel) {
  const s = curSrc(); if (!s) return;
  const cur = S.edSel[s.path];
  if (cur && cur.a === sel.a && cur.key === sel.key && cur.mode === sel.mode && S.ed) return;
  if (!(await confirmLeaveEditor())) return;
  S.edSel[s.path] = sel;
  if (S.tab !== 'edit') { S.tab = 'edit'; render(); return; }
  renderNav(s);
  await openEditor(s, sel);
}
async function saveEditor() {
  const ed = S.ed; if (!ed || !ed.dirty || ed.saving) return !ed?.dirty;
  let op;
  try { op = editOp(ed); } catch (e) { toast(e.message, 'error', 5000); return false; }
  ed.saving = true; updateEdFoot();
  let r;
  try { r = await apiOk('edit', { path: ed.path, op }); }
  catch (e) { ed.saving = false; updateEdFoot(); toast(e.message, 'error', 6000); return false; }
  ed.saving = false; ed.dirty = false; ed.savedAt = Date.now();
  if (op.op === 'item' && !['raw', 'scriptText'].includes(ed.type)) ed.form = clone(op.value);
  ed.orig = clone(ed.form);
  const s0 = curSrc();
  if (r.key != null && ed.mode === 'item' && r.key !== ed.key) { ed.key = r.key; if (s0) S.edSel[s0.path] = { ...S.edSel[s0.path], key: r.key }; }
  applyView(r);
  const s = curSrc();
  if (s) { S.edSel[s.path] = { a: ed.a, key: ed.key, mode: ed.mode }; }
  updateEdFoot(); markNavDirty();
  render();
  toast(s?.kind === 'folder' ? '已保存到项目文件夹' : '已保存到草稿', 'ok', 1600);
  return true;
}
async function edAction(act, el) {
  const ed = S.ed, s = curSrc(); if (!ed || !s) return;
  if (act === 'save') return saveEditor();
  if (act === 'revert') { const fresh = makeEd(ed.path, ed.a, ed.key, ed.data); fresh.mode = ed.mode; fresh.sig = ed.sig; fresh.form = clone(ed.orig); fresh.orig = clone(ed.orig); mountEditor(s, fresh); return; }
  if (act === 'preview') return previewPage(ed.form.replaceString, ed.form.scriptName);
  if (act === 'ai-review') return aiReviewFlow(s.path, ed.a);
  if (act === 'duplicate') {
    const v = clone(ed.orig);
    delete v.uid; delete v.id;
    if (ed.type === 'entry') v.comment = (v.comment || '') + '（副本）';
    if (ed.type === 'regex') v.scriptName = (v.scriptName || '') + '（副本）';
    if (ed.type === 'script') v.name = (v.name || '') + '（副本）';
    return addItem(ed.a, v);
  }
  if (act === 'more') {
    const items = [];
    if (ed.data.file && s.kind === 'folder') items.push({ label: '在 VS Code 中打开文件', icon: 'code', onClick: () => api('editor', { path: ed.data.file, root: s.path }).then(r => { if (!r.ok) api('openPath', { path: ed.data.file }); }) });
    if (ed.mode === 'item' && ed.type !== 'raw' && ed.type !== 'scriptText') items.push({ label: '删除这一项', icon: 'trash', danger: true, onClick: () => deleteItem() });
    items.push({ label: 'artifact 设置', icon: 'settings', onClick: () => selectItem({ a: ed.a, key: null, mode: 'artifact' }) });
    menu(el, items, { align: 'right' });
    return;
  }
  if (act === 'move-up' || act === 'move-down') return runEdit({ op: 'moveArtifact', a: ed.a, to: ed.a + (act === 'move-up' ? -1 : 1) }, r => { S.edSel[s.path] = { a: r.a, key: null, mode: 'artifact' }; });
  if (act === 'delete-artifact') {
    const v = await ask({ title: '删除“' + ed.data.name + '”？', html: `<p>${s.kind === 'folder' ? '整个 artifact 文件夹会移到回收站。' : '只从草稿里删除；保存离线包之前都可以撤销。'}</p>`, buttons: [{ label: '取消', value: null }, { label: '删除', value: 'ok', danger: true }] });
    if (v === 'ok') { S.ed.dirty = false; await runEdit({ op: 'deleteArtifact', a: ed.a }, () => { delete S.edSel[s.path]; }); }
  }
}
async function deleteItem() {
  const ed = S.ed, s = curSrc();
  const name = ed.form.comment || ed.form.scriptName || ed.form.name || ed.key;
  const v = await ask({ title: '删除“' + name + '”？', html: `<p>${s.kind === 'folder' ? (ed.type === 'entry' ? '这个条目的 .txt 文件会移到回收站。' : '会从 artifact.json 里删除，它独占的文件移到回收站。') : '只从草稿里删除；保存离线包之前都可以撤销。'}</p>`, buttons: [{ label: '取消', value: null }, { label: '删除', value: 'ok', danger: true }] });
  if (v !== 'ok') return;
  S.ed.dirty = false;
  await runEdit({ op: 'deleteItem', a: ed.a, key: ed.key }, () => { delete S.edSel[s.path]; teardownEditor(); });
}
async function addItem(a, value) {
  if (!(await confirmLeaveEditor())) return;
  const s = curSrc();
  await runEdit({ op: 'addItem', a, value }, r => { if (r.key != null) S.edSel[s.path] = { a, key: r.key, mode: 'item' }; S.navClosed.delete(s.path + '|' + a); S.tab = 'edit'; });
}
async function runEdit(op, after) {
  const s = curSrc(); if (!s) return;
  busy(true);
  try {
    const r = await apiOk('edit', { path: s.path, op });
    applyView(r);
    after?.(r);
    if (S.ed && S.edSel[s.path] && (S.ed.a !== S.edSel[s.path].a || S.ed.key !== S.edSel[s.path].key || S.ed.mode !== S.edSel[s.path].mode)) teardownEditor();
  } catch (e) { toast(e.message, 'error', 6000); }
  busy(false);
  render();
}
async function newArtifactFlow() {
  const s = curSrc(); if (!s) return;
  const r = await form({ title: '新建 artifact', intro: '每个 artifact 是包里的一份世界书、一组正则或一个脚本。', fields: [
    { key: 'kind', label: '类型', type: 'seg', value: 'worldbook', options: [['worldbook', '世界书'], ['regex', '正则'], ['script', '脚本'], ['preset', '预设'], ['data', '数据']] },
    { key: 'name', label: '名称', value: '', placeholder: '例如：我的扩展-世界书', autofocus: true },
  ], okLabel: '新建', validate: v => (!v.name.trim() ? '请填写名称' : null) });
  if (!r) return;
  await runEdit({ op: 'addArtifact', kind: r.kind, name: r.name.trim() }, x => { if (x.a != null && x.a >= 0) S.edSel[s.path] = { a: x.a, key: null, mode: 'artifact' }; S.tab = 'edit'; });
}
async function previewPage(text, label) {
  const html = pageOf(text);
  if (!html) { toast('替换内容不是 HTML 页面', 'warn'); return; }
  const { url } = await api('preview', { html });
  const m = modal({ cls: 'wide', title: '预览页面 · ' + esc(label || ''), body: `<div class="fhint" style="margin:0 0 8px">在隔离的沙箱里显示，读取不到酒馆与 MVU 变量，也调用不了作品脚本；$1 等占位符保持原样。需要脚本或变量的页面请用页头的“模拟预览”。</div><iframe class="preview" sandbox="allow-scripts" src="${esc(url)}"></iframe>` });
  m.body.classList.add('col');
}

// ---------- 检查结果 ----------
function aiReviewCard(s) {
  const ps = aiState()?.profiles || [];
  return `<div class="ai-card">${icon('sparkles')}<div class="bb"><div class="bt">AI 审查</div><div class="bs">上面的检查只看格式与工坊规则。让 AI 通读整个作品，找出设定矛盾、错别字、世界书触发问题、正则与脚本的错误${ps.length ? '' : '（需要先设置 AI 接口）'}。内容会发送给你设置的 AI 接口。</div></div><button class="btn" data-act="ai-review" data-path="${esc(s.path)}">${icon('sparkles')}AI 审查整个作品</button></div>`;
}
function fatalHtml(msg) {
  const m = /^([\s\S]*?)（第 (\d+) 行第 (\d+) 列附近：…([\s\S]*)…）\s*$/.exec(msg);
  if (!m) return esc(msg);
  return `${esc(m[1])}<span class="where">第 ${m[2]} 行第 ${m[3]} 列附近</span><code class="snippet">…${esc(m[4])}…</code>`;
}
function probItem(cls, ic, html, acts = '') { return `<li class="pi ${cls}">${icon(ic)}<div class="tx">${html}</div>${acts ? `<div class="acts">${acts}</div>` : ''}</li>`; }
function itemActs(x, s) {
  let h = '';
  if (x.art != null) h += `<button class="btn sm" data-act="jump" data-a="${x.art}" data-key="${esc(x.key ?? '')}" title="到“编辑内容”里修改">${icon('pencil')}去修改</button>`;
  if (x.file && s.kind === 'folder') h += `<button class="btn sm ghost" data-act="code" data-path="${esc(x.file)}" data-root="${esc(s.path)}" data-line="${x.line || 1}" data-col="${x.col || 1}" title="${esc(x.file)}">${icon('code')}VS Code</button>`;
  return h;
}
function problemsHtml(s) {
  const isF = s.kind === 'folder';
  let h = '';
  const bytes = s.bytes ?? s.size ?? 0;
  const stats = s.fatal ? '' : `<div class="stats"><span>artifact<b>${s.artifactCount ?? '?'}</b> / 32</span><span>${isF ? '打包后大小' : '大小'}<b>${fmtSize(bytes)}</b> / 6 MB <span class="meter inline ${bytes > MAX_BYTES ? 'over' : bytes > MAX_BYTES * 0.8 ? 'hi' : ''}"><i style="width:${Math.min(100, (bytes / MAX_BYTES) * 100).toFixed(1)}%"></i></span></span>${isF ? `<span>文件<b>${s.fileCount ?? '?'}</b></span>` : ''}</div>`;
  const draft = s.draft ? '（按未保存的草稿检查）' : '';
  if (s.level === 'ok') h += `<div class="banner ok">${icon('checkCircle')}<div class="bb"><div class="bt">${isF ? '检查通过，可以打包' : '校验通过：工坊可以导入和安装'}${draft}</div><div class="bs">${isF ? '与打包时同一套检查：导入格式、安装检查、世界书 uid、引用文件等都没有问题。' : '大小、SHA-256、清单与内容一致，安装检查与常见问题检查都没有发现问题。'}</div></div></div>`;
  else if (s.level === 'warn') h += `<div class="banner warn">${icon('alert')}<div class="bb"><div class="bt">${isF ? '可以打包' : '可以导入'}，有 ${s.warns.length} 条提示值得看一下${draft}</div><div class="bs">提示不会阻止${isF ? '打包' : '导入'}，但通常意味着某些内容不会按预期工作。点“去修改”直接跳到对应的条目。</div></div></div>`;
  else if (s.level === 'fix') h += `<div class="banner fix">${icon('wrench')}<div class="bb"><div class="bt">需要修复才能导入</div><div class="bs">校验信息与内容对不上（手动改过 .rwpack 时常见），工坊导入会报“大小校验失败 / SHA-256 校验失败”。修复会重算校验并覆盖原文件${S.settings.backup !== false ? '，原文件另存为 .bak' : ''}。</div>
      <div class="ba"><button class="btn warnb sm needs-idle" data-act="fix" data-path="${esc(s.path)}">${icon('wrench')}修复</button><button class="btn sm needs-idle" data-act="fix-bump" data-path="${esc(s.path)}">${icon('arrowUp')}修复并升版本号（另存为 v${(s.version || 0) + 1}）</button></div></div></div>`;
  else if (s.fatal) h += `<div class="banner error">${icon('xCircle')}<div class="bb"><div class="bt">${isF ? '读取项目文件夹时出错，无法打包' : s.draft ? '草稿有问题，暂时无法保存' : '工坊导入时会失败'}</div><div class="bs">${isF ? '按下面的提示改好后保存，这里会自动重新检查。' : s.draft ? '可以撤销最近的修改，或在“编辑内容”里改正。' : '这个文件的内容有问题，修复工具也无法自动处理。'}</div>
      ${s.loc ? `<div class="ba"><button class="btn sm primary" data-act="code" data-path="${esc(s.loc.file)}" data-root="${esc(isF ? s.path : '')}" data-line="${s.loc.line}" data-col="${s.loc.col}">${icon('code')}在 VS Code 中打开 ${esc(s.loc.rel)}${s.loc.line > 1 ? '（第 ' + s.loc.line + ' 行）' : ''}</button></div>` : ''}</div></div>`;
  else h += `<div class="banner error">${icon('xCircle')}<div class="bb"><div class="bt">${isF ? '工坊安装时会失败，打包会被拦下' : '工坊安装时会失败'}${draft}</div><div class="bs">下面 ${s.errors.length} 个问题需要先改好。</div></div></div>`;
  h += stats;
  if (s.fatal) h += `<div class="group-h">${icon('xCircle', 'xs')}错误</div><ul class="plist">${probItem('error', 'xCircle', fatalHtml(s.fatal), s.loc ? itemActs({ file: s.loc.file, line: s.loc.line, col: s.loc.col }, s) : '')}</ul>`;
  if (s.errors.length) h += `<div class="group-h">${icon('xCircle', 'xs')}会让工坊安装失败</div><ul class="plist">${s.errors.map(e => probItem('error', 'xCircle', esc(e.text), itemActs(e, s))).join('')}</ul>`;
  if (s.notes.length) h += `<div class="group-h">${icon('info', 'xs')}${isF ? '打包时会自动处理' : s.needFix ? '修复时会处理' : '读取时已自动处理'}</div><ul class="plist">${s.notes.map(n => probItem(s.needFix ? 'fix' : 'note', s.needFix ? 'wrench' : 'info', esc(n))).join('')}</ul>`;
  if (s.warns.length) {
    const groups = new Map();
    for (const w of s.warns) { const k = w.art ?? -1; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(w); }
    for (const [k, list] of groups) {
      const name = k >= 0 ? (/^“(.+?)”/.exec(list[0].text)?.[1] || '') : '';
      h += `<div class="group-h">${icon('alert', 'xs')}提示${name ? ' · ' + esc(name) : ''} <span class="muted">${list.length}</span></div><ul class="plist">${list.map(w => probItem('warn', 'alert', (w.label ? `<b>${esc(w.label)}</b>：` : '') + esc(w.text.replace(/^“.+?”\s*/, '').replace(/^（.+?）\s*/, '').replace(/^条目「.+?」/, '')), itemActs(w, s))).join('')}</ul>`;
    }
  }
  return h;
}

// ---------- 改动对比 ----------
function changesHtml(p, s) {
  const others = allSrc(p).filter(x => !samePath(x.path, s.path));
  const opts = [];
  if (s.draft) opts.push({ path: s.path, saved: true, file: s.file + '（已保存的版本）', version: savedVersion(p, s), sig: 'saved' });
  for (const x of others) opts.push({ path: x.path, file: x.file, version: x.version, sig: x.sig, kind: x.kind });
  if (!opts.length) return `<div class="empty">${icon('compare', 'big')}<b>没有可以对比的版本</b>同一项目的其他离线包或项目文件夹出现后，这里会列出它们之间的差异。</div>`;
  const pick = S.base[s.path];
  let base = opts.find(o => o.path === pick?.path && !!o.saved === !!pick?.saved);
  if (!base) base = s.draft ? opts[0] : s.kind === 'folder' ? opts.find(o => o.kind !== 'folder') || opts[0] : opts.find(o => o.version < s.version && o.kind !== 'folder') || opts[0];
  const bar = `<div class="cmp-bar"><span class="muted">从</span><select class="input" data-act="base">${opts.map((o, i) => `<option value="${i}" ${o === base ? 'selected' : ''}>${o.saved ? '💾 ' : o.kind === 'folder' ? '📁 ' : '📦 '}${esc(o.file)}（v${esc(o.version ?? '?')}）</option>`).join('')}</select>${icon('arrowRight', 'muted')}<b>${esc(s.file)}</b><span class="muted">${s.draft ? '（含未保存的修改）' : '（当前）'}</span></div>`;
  S.cmpOpts = opts;
  const key = base.path + '|' + (base.saved ? 'saved' : base.sig) + '|' + s.path + '|' + s.sig;
  if (S.diff.key !== key) { loadDiff(base, s, key); return bar + '<div class="loading"><span class="spin"></span>正在比较…</div>'; }
  if (S.diff.loading) return bar + '<div class="loading"><span class="spin"></span>正在比较…</div>';
  if (S.diff.error) return bar + `<div class="banner error">${icon('xCircle')}<div class="bb"><div class="bt">无法比较</div><div class="bs">${fatalHtml(S.diff.error)}</div></div></div>`;
  return bar + diffHtml(S.diff.data, key, S.dopen, true);
}
async function loadDiff(base, s, key) {
  S.diff = { key, loading: true };
  try { const d = await apiOk('diff', { a: base.path, b: s.path, aSaved: !!base.saved }); if (S.diff.key === key) S.diff = { key, data: d }; }
  catch (e) { if (S.diff.key === key) S.diff = { key, error: e.message }; }
  if (S.tab === 'changes') renderBody(curProject(), curSrc());
}
function logHtml(p) {
  const list = S.logs.filter(l => l.pid === p.id).slice().reverse();
  if (!list.length) return `<div class="empty">${icon('list', 'big')}<b>还没有操作</b>这里保留本次打开以来，对这个项目做过的修复、解包、打包、保存等操作及完整输出（与命令行相同的格式）。</div>`;
  return `<div class="row" style="justify-content:flex-end;margin-bottom:10px"><button class="btn sm" data-act="copy-log">${icon('copy')}复制全部</button></div>` + list.map(l => `<div class="logitem"><div class="logitem-h">${icon(l.ok ? 'checkCircle' : 'xCircle')}<b>${esc(l.title)}</b><span class="muted">${esc(new Date(l.time).toLocaleTimeString())}</span></div><pre>${esc(l.text)}</pre></div>`).join('');
}

// ---------- 操作 ----------
let refreshTimer = null;
async function refresh() { try { applyView(await api('projects')); render(); projectsChanged(); } catch (e) { console.warn(e); } }
const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); };
async function select(id) {
  if (S.view === 'workshop') { S.view = 'project'; if (id !== S.sel) { S.sel = id; S.result = S.result?.pid === id ? S.result : null; teardownEditor(); S.pf = null; S.diff = { key: null }; } render(); return; }
  if (id === S.sel) return;
  if (!(await confirmLeaveEditor())) return;
  if (S.pf?.dirty && !(await confirmLeavePf())) return;
  S.sel = id; S.result = S.result?.pid === id ? S.result : null; teardownEditor(); S.pf = null; S.diff = { key: null };
  render();
}
async function confirmLeavePf() {
  const v = await ask({ title: '项目资料还没有保存', html: '<p>离开前要保存吗？</p>', buttons: [{ label: '取消', value: null }, { label: '不保存', value: 'drop', danger: true }, { label: '保存', value: 'save', primary: true }] });
  if (v === 'save') { await savePf(); return true; }
  if (v === 'drop') { S.pf = null; return true; }
  return false;
}
async function setSource(path) {
  const f = findByPath(path); if (!f) return;
  if (samePath(curSrc(f.p)?.path, path)) return;
  if (!(await confirmLeaveEditor())) return;
  if (S.pf?.dirty && !(await confirmLeavePf())) return;
  S.sel = f.p.id; S.src[f.p.id] = f.s.path; teardownEditor(); S.pf = null; S.diff = { key: null };
  if (f.s.level === 'error' || f.s.level === 'fix') S.tab = 'checks';
  render();
}
async function openPaths(paths) {
  if (!paths?.length) return;
  busy(true);
  try {
    const r = await api('open', { paths });
    applyView(r);
    for (const e of r.errors || []) toast(e.message, 'warn', 6000);
    const first = r.opened?.find(x => x.id);
    if (first) { S.view = 'project'; S.sel = first.id; S.src[first.id] = first.path; teardownEditor(); S.pf = null; const f = findByPath(first.path); S.tab = f?.s.level === 'error' || f?.s.level === 'fix' ? 'checks' : 'overview'; }
    render();
    if (r.opened?.length) toast(r.opened.length > 1 ? `已打开 ${r.opened.length} 项` : '已打开 ' + baseName(r.opened[0].path), 'ok', 2000);
  } catch (e) { toast(e.message, 'error'); }
  busy(false);
}
async function pick(kind, extra = {}) { const r = await api('pick', { kind, ...extra }); return r.paths || []; }
async function runAction(action, path, opts = {}) {
  const before = findByPath(path), pid = before?.p.id || S.sel;
  const TITLE = { check: '检查', fix: opts.bump ? '修复并升版本号' : '修复', unpack: '解包', pack: opts.bump ? '打包并升版本号' : '打包', example: '生成示例', new: '新建项目' };
  if ((action === 'pack' || action === 'unpack' || action === 'fix') && !(await confirmLeaveEditor())) return;
  busy(true);
  let r;
  try { r = await api('action', { action, path, opts }); } catch (e) { busy(false); toast(e.message, 'error'); return; }
  busy(false);
  applyView(r);
  if (r.confirm) return confirmFlow(action, path, opts, r.confirm);
  const res = r.result || {};
  const reveal = p => `<button class="btn sm" data-act="reveal" data-path="${esc(p)}">${icon('external')}显示位置</button>`;
  const cp = p => `<button class="btn sm ghost" data-act="copy" data-text="${esc(p)}">${icon('copy')}复制路径</button>`;
  let pidAfter = pid;
  const focus = p => { const f = findByPath(p); if (f) { S.view = 'project'; S.sel = f.p.id; S.src[f.p.id] = f.s.path; pidAfter = f.p.id; teardownEditor(); S.pf = null; } };
  if (!r.ok) {
    S.result = { pid, ok: false, title: TITLE[action] + '失败', lines: [r.error], actions: r.loc ? [`<button class="btn sm primary" data-act="code" data-path="${esc(r.loc.file)}" data-root="${esc(path)}" data-line="${r.loc.line}" data-col="${r.loc.col}">${icon('code')}打开 ${esc(r.loc.rel)}</button>`] : [] };
    if (S.tab === 'edit') S.tab = 'checks';
    toast(TITLE[action] + '失败', 'error');
  } else if (action === 'check') {
    S.result = null;
    toast(({ ok: '检查通过', warn: '检查通过，有提示', fix: '需要修复', error: '检查未通过' })[res.level] || '已检查', res.level === 'ok' ? 'ok' : res.level === 'warn' ? 'warn' : 'error', 2000);
  } else if (action === 'fix') {
    if (res.target) focus(res.target);
    S.result = { pid: pidAfter, ok: true, title: res.wrote ? (opts.bump ? '已修复并另存为 v' + res.version : '已修复，校验通过') : '校验通过，无需修复', lines: [res.wrote ? '→ ' + res.target : '', res.backup ? '原文件备份为 ' + baseName(res.backup) : ''].filter(Boolean), actions: res.target ? [reveal(res.target), cp(res.target)] : [] };
    S.tab = 'checks'; toast(S.result.title, 'ok');
  } else if (action === 'unpack') {
    focus(res.dir);
    S.result = { pid: pidAfter, ok: true, title: `已解包为项目文件夹（${res.files} 个文件）`, lines: ['→ ' + res.dir, '可以在“编辑内容”里直接改，也可以用 VS Code 打开；保存文件后这里自动重新检查。'], actions: [`<button class="btn sm primary" data-act="tab" data-tab="edit">${icon('pencil')}开始编辑</button>`, `<button class="btn sm" data-act="code" data-path="${esc(res.dir)}">${icon('code')}用 VS Code 打开</button>`, `<button class="btn sm ghost" data-act="open-path" data-path="${esc(res.dir)}">${icon('folderOpen')}打开文件夹</button>`] };
    S.tab = 'overview'; toast('解包完成', 'ok');
  } else if (action === 'pack') {
    delete S.bump[path];
    S.result = { pid, ok: true, title: res.same ? '内容与已有文件相同，未改写' : `已打包 v${res.version}，通过校验`, lines: ['→ ' + res.target + '（' + fmtSize(res.size) + '）', res.bak ? '原文件备份为 ' + baseName(res.bak) : '', res.warns?.length ? res.warns.length + ' 条提示，见“检查结果”' : '', res.same ? '' : '下一步：在工坊“本地”页导入这个离线包。'].filter(Boolean), actions: [reveal(res.target), cp(res.target)] };
    if (S.tab === 'edit') S.tab = 'overview';
    toast(S.result.title, 'ok');
  } else if (action === 'example' || action === 'new') {
    focus(res.dir);
    S.result = action === 'example'
      ? { pid: pidAfter, ok: true, title: '已生成示例扩展“回声茶馆”', lines: ['项目文件夹 → ' + res.dir, '离线包 → ' + res.target], actions: [`<button class="btn sm primary" data-act="tab" data-tab="edit">${icon('pencil')}看看怎么写</button>`, reveal(res.target)] }
      : { pid: pidAfter, ok: true, title: '已新建项目', lines: ['→ ' + res.dir, '先在“概览”里填好名称、简介和封面，再到“编辑内容”里添加世界书、正则与脚本。'], actions: [`<button class="btn sm primary" data-act="tab" data-tab="edit">${icon('pencil')}开始编辑</button>`] };
    S.tab = 'overview'; toast(S.result.title, 'ok');
  }
  logEntry(pidAfter, TITLE[action] + ' · ' + baseName(path || res.dir || ''), r);
  render();
}
async function confirmFlow(action, path, opts, c) {
  if (c.kind === 'overwrite') {
    const v = await ask({ title: '目标文件已存在', html: `<p>应保存为 <b>${esc(c.file)}</b>，但这个文件已经存在。</p><p>${S.settings.backup !== false ? '覆盖前会把它另存为 .bak。' : '当前设置为不保留备份，覆盖后无法找回。'}</p>`, buttons: [{ label: '取消', value: null }, { label: '覆盖', value: 'ok', primary: true }] });
    if (v === 'ok') return action === 'draft' ? saveDraft(path, { ...opts, overwrite: true }) : runAction(action, path, { ...opts, overwrite: true });
  } else if (c.kind === 'unpack-exists') {
    const v = await ask({ title: '这个项目已经解包过', html: `<p>已有项目文件夹：</p>${c.folders.map(x => `<div class="choice static">${icon('folder')}<div><b>${esc(x.file)}</b> <span class="muted">v${esc(x.version)}</span><div class="small muted">${esc(x.path)}</div></div></div>`).join('')}<p>再次解包会新建一个文件夹（名称后加“(2)”），不会覆盖已有文件夹。</p>`, buttons: [{ label: '取消', value: null }, { label: '查看已有文件夹', value: 'show' }, { label: '仍然解包', value: 'go', primary: true }] });
    if (v === 'show') setSource(c.folders[0].path);
    if (v === 'go') return runAction(action, path, { ...opts, force: true });
  }
}
async function saveDraft(path, opts = {}) {
  if (!(await confirmLeaveEditor())) return;
  const f = findByPath(path), pid = f?.p.id || S.sel;
  busy(true);
  let r;
  try { r = await api('draft.save', { path, mode: 'version', ...opts }); } catch (e) { busy(false); toast(e.message, 'error'); return; }
  busy(false);
  applyView(r);
  if (r.confirm) return confirmFlow('draft', path, opts, r.confirm);
  if (!r.ok) { toast(r.error, 'error', 8000); S.result = { pid, ok: false, title: '保存失败', lines: [r.error] }; S.tab = 'checks'; render(); return; }
  const res = r.result;
  const g = findByPath(res.target);
  if (g) { S.sel = g.p.id; S.src[g.p.id] = g.s.path; }
  teardownEditor(); S.pf = null;
  S.result = { pid, ok: true, title: res.same ? '内容与已有文件相同，未改写' : `已保存为 v${res.version}，通过校验`, lines: ['→ ' + res.target, res.bak ? '原文件备份为 ' + baseName(res.bak) : '', res.warns?.length ? res.warns.length + ' 条提示，见“检查结果”' : '', '下一步：在工坊“本地”页导入这个离线包。'].filter(Boolean), actions: [`<button class="btn sm" data-act="reveal" data-path="${esc(res.target)}">${icon('external')}显示位置</button>`] };
  logEntry(pid, '保存修改 · ' + baseName(res.target), r);
  S.tab = 'overview';
  toast(S.result.title, 'ok');
  render();
}
async function exampleFlow() {
  const r = await form({ title: '生成示例扩展', intro: '生成一个能直接导入的小扩展“回声茶馆”：5 条世界书（常驻、关键词、按深度插入、EJS 读取变量、停用）、一个酒馆助手脚本按钮、3 条正则（聊天里的 HTML 页面、文字美化、只改发给 AI 的内容）和封面。', fields: [
    { key: 'dest', label: '生成到', type: 'folder', value: S.env.lastDir || S.app.documents || '' },
  ], okLabel: '生成', pickFolder: async cur => (await pick('folder', { title: '选择生成示例的位置', defaultPath: cur }))[0], validate: v => (!v.dest.trim() ? '请选择位置' : null) });
  if (r) runAction('example', null, { dest: r.dest.trim() });
}
async function newProjectFlow() {
  const r = await form({ title: '新建项目', intro: '会新建一个项目文件夹，里面有一份带一条常驻条目的世界书。之后可以在这里直接编辑，并打包成 .rwpack。', fields: [
    { key: 'name', label: '项目名称', value: '', placeholder: '例如：我的新扩展', autofocus: true },
    { key: 'category', label: '分类', type: 'seg', value: 'extension', options: [['extension', '扩展'], ['character', '角色'], ['store_catalog', '开局商店'], ['scenario', '副本']], hint: '开局商店会带一份空的开局商店目录，在“编辑内容”里补充商品；副本会带一份副本数据，用副本编辑器填写世界与章节，保存时生成副本世界书。' },
    { key: 'dir', label: '放在', type: 'folder', value: S.env.lastDir || S.app.documents || '' },
  ], okLabel: '新建', pickFolder: async cur => (await pick('folder', { title: '选择放项目文件夹的位置', defaultPath: cur }))[0], validate: v => (!v.name.trim() ? '请填写项目名称' : v.name.trim().length > LIM.name ? `项目名称不能超过 ${LIM.name} 个字` : !v.dir.trim() ? '请选择位置' : null) });
  if (r) runAction('new', null, { name: r.name.trim(), category: r.category, dir: r.dir.trim() });
}
async function removeFlow(id) {
  const p = S.projects.find(x => x.id === id);
  const v = await ask({ title: '从列表移除“' + (p?.name || '') + '”？', html: `<p>只是不再在这里显示，<b>不会删除任何文件</b>。以后重新打开它的离线包或项目文件夹，就会回到列表里。</p>${p?.drafts ? '<p class="warn-text">这个项目有未保存的草稿，移除后草稿会丢失。</p>' : ''}`, buttons: [{ label: '取消', value: null }, { label: '移除', value: 'ok', primary: true }] });
  if (v !== 'ok') return;
  try { teardownEditor(); S.pf = null; applyView(await api('remove', { id })); S.sel = S.projects[0]?.id || null; render(); } catch (e) { toast(e.message, 'error'); }
}
function openMenu(anchor) {
  menu(anchor, [
    { label: '打开离线包…', icon: 'package', kbd: 'Ctrl+O', onClick: async () => openPaths(await pick('packs')) },
    { label: '打开项目文件夹…', icon: 'folderOpen', kbd: 'Ctrl+Shift+O', onClick: async () => openPaths(await pick('folders')) },
    '-',
    { label: '新建项目…', icon: 'folderPlus', kbd: 'Ctrl+N', onClick: newProjectFlow },
    { label: '生成示例扩展…', icon: 'sparkles', onClick: exampleFlow },
  ], { width: 230 });
}
function srcMenu(anchor) {
  const p = curProject(), s = curSrc(p);
  const row = x => ({ label: x.file, icon: x.kind === 'folder' ? 'folder' : 'package', hint: (x.kind === 'folder' ? '项目文件夹 · ' : '离线包 · ') + 'v' + (x.version ?? '?') + (x.draft ? ' · 未保存' : x.level !== 'ok' ? ' · ' + LV[x.level].t : ''), checked: samePath(x.path, s?.path), onClick: () => setSource(x.path) });
  const items = [];
  if (p.folders.length) items.push({ header: '项目文件夹' }, ...p.folders.map(row));
  if (p.packs.length) items.push({ header: '离线包' }, ...p.packs.map(row));
  menu(anchor, items, { align: 'right', width: 320 });
}
function rowMenu(anchor, path) {
  const f = findByPath(path); if (!f) return;
  const s = f.s, items = [{ label: '查看与编辑', icon: 'pencil', onClick: () => setSource(path) }, '-'];
  if (s.kind === 'folder') {
    items.push({ label: '打包', icon: 'pack', onClick: () => runAction('pack', path, { bump: false }) }, { label: '打包并升版本号', icon: 'arrowUp', onClick: () => runAction('pack', path, { bump: true }) }, { label: '重新检查', icon: 'refresh', onClick: () => runAction('check', path) }, '-',
      { label: '用 VS Code 打开', icon: 'code', disabled: !S.env.editor, onClick: () => api('editor', { path }) }, { label: '打开文件夹', icon: 'folderOpen', onClick: () => api('openPath', { path }) });
  } else {
    if (s.draft) items.push({ label: '保存修改', icon: 'save', onClick: () => saveDraft(path) }, { label: '放弃修改', icon: 'trash', danger: true, onClick: () => discardDraft(path) }, '-');
    items.push({ label: '修复', icon: 'wrench', disabled: s.level !== 'fix', onClick: () => runAction('fix', path) }, { label: s.level === 'fix' ? '修复并升版本号' : '升版本号另存', icon: 'arrowUp', disabled: !!s.fatal, onClick: () => runAction('fix', path, { bump: true }) },
      { label: '解包', icon: 'unpack', disabled: !!s.fatal, onClick: () => runAction('unpack', path) }, { label: '重新检查', icon: 'refresh', onClick: () => runAction('check', path) }, '-', { label: '显示位置', icon: 'external', onClick: () => api('reveal', { path }) });
  }
  items.push('-', { label: '安装到 SillyTavern', icon: 'tavern', disabled: !!s.draft || !!s.fatal || s.level === 'error', hint: s.draft ? '先保存修改' : s.level === 'error' ? '先修正错误' : '', onClick: () => installFlow(path) });
  menu(anchor, items, { align: 'right', width: 220 });
}
async function discardDraft(path) {
  const v = await ask({ title: '放弃所有未保存的修改？', html: '<p>草稿里的修改都会丢失，离线包保持原样。</p>', buttons: [{ label: '取消', value: null }, { label: '放弃修改', value: 'ok', danger: true }] });
  if (v !== 'ok') return;
  teardownEditor(); S.pf = null;
  applyView(await api('draft.discard', { path }));
  render();
}
function settingsFlow() {
  const s = S.settings, rk = S.env.rwkit;
  const m = modal({ cls: 'mid', title: '设置', body: `
    <div class="set-sec"><h4>备份</h4>${F.toggle('backup', s.backup !== false, '覆盖已有的 .rwpack 时保留 .bak 备份')}<div class="fhint">修复、打包、保存新版本时生效（对应命令行的 --no-backup）。</div></div>
    <div class="set-sec"><h4>外观</h4><div class="seg" data-theme-seg>${[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([k, t]) => `<button type="button" class="${(s.theme || 'auto') === k ? 'on' : ''}" data-v="${k}">${t}</button>`).join('')}</div></div>
    <div class="set-sec"><h4>rwkit.mjs</h4><div class="kv"><div class="k">正在使用</div><div class="v"><span class="pill ${rk.ok ? 'ok' : 'error'}">${esc(rk.label || '')}</span> <span class="mono small" style="word-break:break-all">${esc(rk.file || '')}</span></div>${rk.error ? `<div class="k">问题</div><div class="v" style="color:var(--err)">${esc(rk.error)}</div>` : ''}</div>
      <div class="fhint">所有检查、修复与打包都直接调用 rwkit.mjs。工具包更新后，可以选择新的 rwkit.mjs，或把它放在程序旁边。</div>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-set="pick-rwkit">${icon('file')}选择 rwkit.mjs…</button>${s.rwkitPath ? `<button class="btn sm ghost" data-set="reset-rwkit">${icon('undo')}恢复内置版本</button>` : ''}</div></div>
    <div class="set-sec"><h4>创意工坊</h4><div class="kv"><div class="k">服务器</div><div class="v"><span class="mono small">${esc(workshopState().st?.base || '')}</span></div><div class="k">账号</div><div class="v">${workshopState().st?.user ? esc(workshopState().st.user.name) + '（Discord）' : '未登录'}</div></div>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-set="ws-server">${icon('globe')}服务器与下载位置…</button>${workshopState().st?.user ? '' : `<button class="btn sm discord" data-set="ws-login">${icon('discord')}使用 Discord 登录</button>`}</div></div>
    <div class="set-sec"><h4>AI 帮写</h4><div class="kv"><div class="k">接口</div><div class="v">${(() => { const a = aiState(); const p = a?.profiles.find(x => x.id === a.active); return p ? esc(p.name) + ' <span class="mono small muted">' + esc(p.model) + '</span>' + (a.profiles.length > 1 ? ' <span class="muted small">（共 ' + a.profiles.length + ' 个）</span>' : '') : '未设置'; })()}</div></div>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-set="ai">${icon('sparkles')}接口与提示词…</button></div><div class="fhint">在编辑器、简介、更新说明等位置点“AI”，润色、代写、修改或审查内容。支持 OpenAI 兼容接口、Anthropic Claude 与 Google Gemini。</div></div>
    <div class="set-sec"><h4>模拟酒馆</h4><div class="kv"><div class="k">版本</div><div class="v">${S.sim?.ok ? `SillyTavern ${esc(S.sim.versions.sillytavern)} · 酒馆助手 ${esc(S.sim.versions.tavernHelper)}` : `<span style="color:var(--err)">${esc(S.sim?.error || '不可用')}</span>`}</div></div>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-set="sim-reset" ${S.sim?.ok ? '' : 'disabled'}>${icon('trash')}清空模拟酒馆的数据…</button></div><div class="fhint">作品页的“模拟预览”在单独的窗口里运行随 rwkit 附带的官方 SillyTavern 前端与酒馆助手，数据与你自己的酒馆分开保存。</div></div>
    <div class="set-sec"><h4>SillyTavern</h4><div class="kv"><div class="k">安装桥</div><div class="v">${tavernState().st?.running ? (tavernState().st.connected ? '已连接' + (tavernState().st.client?.character ? '（当前角色：' + esc(tavernState().st.client.character) + '）' : '') : '已启用，等待 SillyTavern 连接') : '未启用'} <span class="muted small">127.0.0.1:${esc(tavernState().st?.port || '')}</span></div></div>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-set="st-setup">${icon('tavern')}连接设置…</button></div><div class="fhint">通过酒馆助手脚本“rwkit 安装桥”，把离线包交给 SillyTavern 里的创意工坊安装。</div></div>
    <div class="set-sec"><h4>关于</h4><div class="kv">
      <div class="k">版本</div><div class="v">rwkit 离线包工具 ${esc(S.app.version)} · Electron ${esc(S.app.electron)} · Node ${esc(S.app.node)}</div>
      <div class="k">编辑器</div><div class="v">${S.env.editor ? '已找到 VS Code' : '没有找到 VS Code（“用 VS Code 打开”会改用系统默认程序）'}</div>
      <div class="k">数据文件夹</div><div class="v"><span class="mono small">${esc(S.app.userData)}</span> <button class="btn xs ghost" data-set="open-data">${icon('folderOpen')}打开</button></div></div>
      <div class="row" style="margin-top:10px"><button class="btn sm" data-set="up-check">${icon('arrowUp')}检查更新…</button></div></div>`,
    foot: '<div class="spacer"></div><button class="btn primary" data-m="close">完成</button>' });
  m.el.addEventListener('change', async e => { if (e.target.dataset.bind === 'backup') { S.settings = (await api('settings', { backup: e.target.checked })).settings; render(); } });
  m.el.addEventListener('click', async e => {
    const b = e.target.closest('[data-theme-seg] button');
    if (b) { S.settings = (await api('settings', { theme: b.dataset.v })).settings; $$('[data-theme-seg] button', m.el).forEach(x => x.classList.toggle('on', x === b)); return; }
    const a = e.target.closest('[data-set]'); if (!a) return;
    if (a.dataset.set === 'pick-rwkit') { const p = (await pick('rwkit'))[0]; if (!p) return; const r = await api('settings', { rwkitPath: p }); S.settings = r.settings; S.env.rwkit = r.rwkit; m.close(); toast(r.rwkit.ok ? '已改用 ' + p : 'rwkit.mjs 载入失败：' + r.rwkit.error, r.rwkit.ok ? 'ok' : 'error', 5000); await refresh(); }
    if (a.dataset.set === 'reset-rwkit') { const r = await api('settings', { rwkitPath: '' }); S.settings = r.settings; S.env.rwkit = r.rwkit; m.close(); toast('已恢复内置的 rwkit.mjs', 'ok'); await refresh(); }
    if (a.dataset.set === 'open-data') api('openPath', { path: S.app.userData });
    if (a.dataset.set === 'ws-server') { m.close(); serverFlow(); }
    if (a.dataset.set === 'st-setup') { m.close(); setupFlow(); }
    if (a.dataset.set === 'up-check') { m.close(); updateFlow(); }
    if (a.dataset.set === 'ws-login') { m.close(); loginFlow(); }
    if (a.dataset.set === 'ai') { m.close(); aiSettingsFlow(); }
    if (a.dataset.set === 'sim-reset') {
      const v = await ask({ title: '清空模拟酒馆的数据？', html: '<p>导入的角色卡、聊天记录、世界书与设置都会删除（模拟酒馆会关闭），你自己的 SillyTavern 不受影响。</p>', buttons: [{ label: '取消', value: null }, { label: '清空', value: 'ok', danger: true }] });
      if (v === 'ok') { const r = await api('sim.reset'); toast(r.ok === false ? r.error : '已清空模拟酒馆的数据', r.ok === false ? 'error' : 'ok'); }
    }
  });
}
async function simOpen(path) {
  const r = await api('sim.open', { project: path });
  if (r.ok === false) toast(r.error, 'error', 6000);
}
function helpFlow() {
  modal({ cls: 'mid', title: '使用说明', body: `
    <h4>两种改包方式</h4>
    <ul><li><b>直接编辑离线包</b>：打开 .rwpack，在“编辑内容”里修改。修改先保存在草稿里（页面底部会提示），点“保存为新版本”时自动升版本号、重算校验，生成 名称-v新版本.rwpack，原文件不动。</li>
    <li><b>解包后编辑</b>：适合大量修改或想用 VS Code。项目文件夹里的修改（无论在这里还是在 VS Code 里）保存后立即写入文件，约 1.5 秒内自动重新检查；改完点“打包”。</li></ul>
    <h4>编辑器</h4>
    <ul><li>世界书条目、正则、脚本都有对应的表单；正文与代码支持高亮、行号、查找替换（Ctrl+F）。</li>
    <li>正则自带测试区：粘贴一段聊天文字，实时显示匹配位置与替换结果；HTML 页面可以直接预览。</li>
    <li>脚本保存前会检查语法，出错时点提示跳到对应行。</li>
    <li>“检查结果”里的每条提示都可以点“去修改”，直接跳到对应的条目。</li></ul>
    <h4>模拟酒馆</h4>
    <ul><li>作品页右上角的“模拟预览”打开模拟酒馆：随 rwkit 附带的官方 SillyTavern 前端与酒馆助手，数据与你自己的酒馆分开。</li>
    <li>先在模拟酒馆里导入并打开轮回战场角色卡（允许它的脚本），再在右侧面板点“安装到模拟酒馆”。草稿也能安装，可以设为保存后自动重装。</li>
    <li>面板里可以一键插入触发正则页面的消息、实时修改 MVU 与酒馆助手变量、查看页面的错误日志；选择 AI 帮写的接口后还能直接生成回复试玩。</li>
    <li>也可以在面板顶部改用你自己正在运行的 SillyTavern（会直接改动它的数据）。</li></ul>
    <h4>AI 帮写</h4>
    <ul><li>在 设置 → AI 帮写 里添加接口：OpenAI、Google Gemini、Anthropic Claude，或任何 OpenAI 兼容接口（DeepSeek、OpenRouter、硅基流动、Ollama 等）。API key 用系统加密保存在本机。</li>
    <li>编辑器里的“AI”按钮与简介、更新说明里的“AI”小按钮可以润色、代写、修改或审查；先选中一部分再点，只处理选中的文字。结果可以先修改、查看改动再写入。</li>
    <li>“检查结果”页底部可以让 AI 审查整个作品。每种操作的提示词都可以在设置里修改。</li></ul>
    <h4>创意工坊（在线）</h4>
    <ul><li>左侧“创意工坊”可以浏览、搜索工坊作品，下载为 .rwpack 后直接在这里打开查看与修改。下载不会执行其中的脚本。</li>
    <li>用 Discord 登录后，可以把本地项目发布到工坊、为自己的作品上传新版本、提交审核、更换封面、下架或删除。首次发布需要审核；已通过审核的作品，之后上传的新版本会立即发布。</li>
    <li>打开的项目如果在工坊上有更新的版本，项目列表里会显示 ${icon('arrowUp', 'xs')} 标记，概览页的“创意工坊”卡片可以一键下载。</li>
    <li>工坊上传内容不超过 4 MB，封面只支持 PNG / JPEG / WebP 且不超过 3 MB。</li></ul>
    <h4>安装到 SillyTavern</h4>
    <ul><li>先在“连接设置”里保存“rwkit 安装桥”脚本，在 SillyTavern 的酒馆助手 → 脚本库 → 全局脚本里导入并启用；SillyTavern 页面开着时，左下角显示“已连接”。</li>
    <li>概览页的“SillyTavern”卡片、版本菜单与工坊作品页都可以“安装到 SillyTavern”：离线包交给 SillyTavern 里的创意工坊导入、检查并安装，与在工坊里点“安装”相同，之后也能在工坊“本地”页管理。</li>
    <li>已经安装过的作品会先卸载旧版本再安装；工坊里缓存了更高版本时，需要先提高本地项目的版本号。</li></ul>
    <h4>状态的含义</h4>
    <table class="tbl"><tr><td>${pill('ok')}</td><td>工坊可以导入和安装。</td></tr><tr><td>${pill('warn', '有提示')}</td><td>能导入，但内容可能不会按预期工作，例如条目永远不会触发、正则页面会被酒馆改写。</td></tr>
    <tr><td>${pill('fix')}</td><td>大小 / SHA-256 等校验与内容不一致，点“修复”即可。</td></tr><tr><td>${pill('error', '有错误')}</td><td>格式不对或工坊安装会失败，需要改正。</td></tr>
    <tr><td><span class="pill draft">${icon('pencil')}未保存</span></td><td>离线包有还没写入文件的修改。</td></tr></table>
    <h4>快捷键</h4>
    <table class="tbl"><tr><td><kbd>Ctrl</kbd>+<kbd>S</kbd></td><td>保存当前编辑的条目 / 项目资料</td></tr><tr><td><kbd>Ctrl</kbd>+<kbd>O</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd></td><td>打开离线包 / 项目文件夹</td></tr>
    <tr><td><kbd>Ctrl</kbd>+<kbd>N</kbd></td><td>新建项目</td></tr><tr><td><kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>5</kbd></td><td>切换页签</td></tr><tr><td><kbd>Ctrl</kbd>+<kbd>B</kbd></td><td>显示 / 隐藏项目列表</td></tr><tr><td><kbd>F5</kbd></td><td>重新检查当前版本</td></tr></table>
    <h4>工坊的限制</h4>
    <p>离线包不超过 6 MB；artifact 最多 32 个；单个世界书最多 500 条；依赖最多 12 个；原版资源规则最多 300 条。</p>
    <p>发布到创意工坊时另有限制：名称 80 字、简介 2000 字、更新说明 2000 字；标签最多 12 个、每个 24 字；artifact 名称 100 字；每个正则 artifact 最多 200 条、脚本最多 100 个（文件夹不能嵌套）；原版冲突声明 100 条；上传内容 4 MB；封面必填，PNG / JPEG / WebP 且不超过 3 MB。超出时“检查结果”里会有提示。</p>`, foot: '<div class="spacer"></div><button class="btn primary" data-m="close">知道了</button>' });
}

// ---------- 编写教程（docs/扩展编写教程.md，构建时放进 vendor/） ----------
let tutorialHtml = null;
async function tutorialFlow(anchor) {
  try {
    if (!tutorialHtml) {
      const [{ marked }, md] = await Promise.all([import('../vendor/marked.js'), fetch('vendor/tutorial.md').then(r => { if (!r.ok) throw new Error('找不到教程文件'); return r.text(); })]);
      tutorialHtml = marked.parse(md, { gfm: true });
    }
  } catch (e) { toast('无法打开编写教程：' + e.message, 'error'); return; }
  const m = modal({ cls: 'wide doc', title: `${icon('book')}<span>扩展编写教程</span>`, body: `<div class="doc-wrap"><nav class="doc-toc"></nav><article class="md-body">${tutorialHtml}</article></div>` });
  m.body.classList.add('nopad');
  const art = $('.md-body', m.el), toc = $('.doc-toc', m.el);
  // 二级标题用前面 <a id> 的锚点（与 GitHub 上的链接一致），三级标题按顺序编号
  let n2 = 0, n3 = 0, cur = '';
  const heads = [];
  for (const h of $$('h2, h3', art)) {
    if (h.tagName === 'H2') {
      const prev = h.previousElementSibling;
      const a = prev?.matches?.('a[id]') ? prev : prev?.querySelector?.('a[id]');
      cur = a?.id || 'sec-' + (++n2); n3 = 0;
      if (a) a.removeAttribute('id');
      h.id = cur;
    } else h.id = cur + '-' + (++n3);
    heads.push(h);
  }
  // 段落中间的 <a id>（如 regex-page）保留为跳转目标
  toc.innerHTML = '<div class="toc-h">目录</div>' + heads.map(h => `<a class="toc-i ${h.tagName === 'H3' ? 'sub' : ''}" href="#${esc(h.id)}">${esc(h.textContent)}</a>`).join('');
  // 跳到锚点；段落里的 <a id> 紧跟标题时，对齐到那个标题
  const target = id => {
    let el = art.querySelector('#' + CSS.escape(id));
    const next = el?.tagName === 'A' ? (el.parentElement !== art ? el.parentElement : el).nextElementSibling : null;
    if (next && /^H[23]$/.test(next.tagName)) el = next;
    return el;
  };
  const go = id => { const el = target(id); if (el) { art.scrollTop = Math.max(0, el.offsetTop - 12); spy(); } };
  m.el.addEventListener('click', e => {
    const a = e.target.closest('a[href]'); if (!a) return;
    const href = a.getAttribute('href');
    if (href.startsWith('#')) { e.preventDefault(); go(decodeURIComponent(href.slice(1))); }
    else if (/^https:\/\//.test(href)) { e.preventDefault(); window.open(href); }
  });
  // 滚动时高亮当前章节
  const spy = () => {
    let active = heads[0];
    for (const h of heads) { if (h.offsetTop - art.scrollTop <= 60) active = h; else break; }
    $$('.toc-i', toc).forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + active?.id));
  };
  art.addEventListener('scroll', debounce(spy, 50));
  requestAnimationFrame(() => { if (anchor) go(anchor); else spy(); });
}

// ---------- 事件 ----------
document.addEventListener('click', async e => {
  if (workshopSeg(e)) return;
  const t = e.target.closest('[data-act]');
  if (!t || t.disabled) return;
  const act = t.dataset.act, p = curProject();
  if (act.startsWith('up-') && updatesClick(act)) return;
  if (act.startsWith('st-') && await tavernClick(act, t, e)) return;
  if (act.startsWith('ws-')) {
    // 离开项目页前确认未保存的编辑
    if (S.view !== 'workshop' && ['ws-open', 'ws-detail', 'ws-goto-mine'].includes(act)) {
      if (!(await confirmLeaveEditor())) return;
      if (S.pf?.dirty && !(await confirmLeavePf())) return;
    }
    if (await workshopClick(act, t, e)) return;
  }
  switch (act) {
    case 'toggle-sidebar': S.settings = (await api('settings', { sidebar: S.settings.sidebar === false })).settings; render(); break;
    case 'open-menu': openMenu(t); break;
    case 'open-packs': openPaths(await pick('packs')); break;
    case 'open-folders': openPaths(await pick('folders')); break;
    case 'new-project': newProjectFlow(); break;
    case 'example': exampleFlow(); break;
    case 'help': menu(t, [{ label: '扩展编写教程', icon: 'book', kbd: 'F1', hint: '世界书、正则、脚本、预设、数据等全部内容的写法', onClick: () => tutorialFlow() }, { label: '使用说明', icon: 'help', onClick: helpFlow }, '-', { label: '检查更新…', icon: 'arrowUp', hint: '当前版本 v' + (S.app?.version || ''), onClick: () => updateFlow() }], { align: 'right', width: 300 }); break;
    case 'tutorial': tutorialFlow(t.dataset.sec); break;
    case 'settings': settingsFlow(); break;
    case 'sim': simOpen(t.dataset.path); break;
    case 'ai-review': aiReviewFlow(t.dataset.path); break;
    case 'ai-settings': aiSettingsFlow(); break;
    case 'select': select(t.dataset.id); break;
    case 'select-loose': S.view = 'project'; S.sel = t.dataset.path; render(); break;
    case 'remove-loose': applyView(await api('remove', { path: t.dataset.path })); S.sel = null; render(); break;
    case 'src-menu': srcMenu(t); break;
    case 'src': if (!e.target.closest('[data-act="row-menu"]')) setSource(t.dataset.path); break;
    case 'row-menu': e.stopPropagation(); rowMenu(t, t.dataset.path); break;
    case 'tab': {
      if (S.tab === t.dataset.tab) break;
      if (S.tab === 'edit' && !(await confirmLeaveEditor())) break;
      if (S.tab === 'overview' && S.pf?.dirty && !(await confirmLeavePf())) break;
      S.tab = t.dataset.tab; render(); break;
    }
    case 'dismiss': S.result = null; render(); break;
    case 'copy': copyText(t.dataset.text); break;
    case 'reveal': api('reveal', { path: t.dataset.path }); break;
    case 'open-path': api('openPath', { path: t.dataset.path }); break;
    case 'code': { const r = await api('editor', { path: t.dataset.path, root: t.dataset.root || undefined, line: Number(t.dataset.line) || undefined, col: Number(t.dataset.col) || undefined }); if (r.ok) toast('正在用 VS Code 打开…', 'info', 1500); else { api('openPath', { path: t.dataset.path }); toast('没有找到 VS Code，已用默认程序打开', 'info'); } break; }
    case 'check': runAction('check', t.dataset.path); break;
    case 'fix': runAction('fix', t.dataset.path); break;
    case 'fix-bump': runAction('fix', t.dataset.path, { bump: true }); break;
    case 'unpack': runAction('unpack', t.dataset.path); break;
    case 'pack': { const f = findByPath(t.dataset.path)?.s; runAction('pack', t.dataset.path, { bump: f ? bumpOn(f) : false }); break; }
    case 'pack-menu': {
      const f = findByPath(t.dataset.path)?.s; if (!f) break;
      menu(t, [
        { label: '打包（版本号不变）', icon: 'pack', hint: f.target ? '→ ' + f.target.file + (f.target.exists ? '（覆盖）' : '') : '', onClick: () => runAction('pack', f.path, { bump: false }) },
        { label: '打包并升版本号', icon: 'arrowUp', hint: f.bumpTarget ? '→ ' + f.bumpTarget.file + '，并写回 project.json' : '', onClick: () => runAction('pack', f.path, { bump: true }) },
        '-', { label: '重新检查', icon: 'refresh', kbd: 'F5', onClick: () => runAction('check', f.path) },
      ], { align: 'right', width: 300 });
      break;
    }
    case 'more-menu': {
      const s = curSrc(p); if (!s) break;
      const items = [];
      if (s.kind === 'folder') items.push({ label: '用 VS Code 打开', icon: 'code', disabled: !S.env.editor, onClick: () => api('editor', { path: s.path }) }, { label: '打开文件夹', icon: 'folderOpen', onClick: () => api('openPath', { path: s.path }) });
      else {
        items.push({ label: s.level === 'fix' ? '修复并升版本号' : '升版本号另存', icon: 'arrowUp', disabled: !!s.fatal || !!s.draft, onClick: () => runAction('fix', s.path, { bump: true }) });
        if (s.draft) items.push({ label: '解包（不含未保存的修改）', icon: 'unpack', onClick: () => runAction('unpack', s.path) });
        items.push({ label: '显示位置', icon: 'external', onClick: () => api('reveal', { path: s.path }) });
      }
      const ins = installSource(p);
      items.push({ label: '重新检查', icon: 'refresh', kbd: 'F5', onClick: () => runAction('check', s.path) }, '-', { label: '安装到 SillyTavern', icon: 'tavern', disabled: !ins, hint: ins ? ins.file : '先保存修改或修正错误', onClick: () => installFlow(ins.path) }, '-', { label: '从列表移除项目', icon: 'x', onClick: () => removeFlow(p.id) });
      menu(t, items, { align: 'right', width: 240 });
      break;
    }
    case 'draft-save': saveDraft(t.dataset.path); break;
    case 'draft-overwrite': {
      const v = await ask({ title: '覆盖原文件？', html: `<p>修改会直接写回 <b>${esc(baseName(t.dataset.path))}</b>，版本号不变${S.settings.backup !== false ? '（原文件另存为 .bak）' : ''}。</p><p class="warn-text">如果工坊里已经安装了这个版本，导入时需要先卸载旧版。通常建议“保存为新版本”。</p>`, buttons: [{ label: '取消', value: null }, { label: '覆盖原文件', value: 'ok', primary: true }] });
      if (v === 'ok') saveDraft(t.dataset.path, { mode: 'overwrite' });
      break;
    }
    case 'draft-menu': menu(t, [{ label: '保存为新版本（推荐）', icon: 'save', onClick: () => saveDraft(t.dataset.path) }, { label: '覆盖原文件', icon: 'file', onClick: () => $(`[data-act="draft-overwrite"]`)?.click() }, '-', { label: '撤销上一处修改', icon: 'undo', onClick: () => api('draft.undo', { path: t.dataset.path }).then(r => { if (r.ok === false) toast(r.error, 'warn'); else { applyView(r); teardownEditor(); render(); } }) }, { label: '放弃所有修改', icon: 'trash', danger: true, onClick: () => discardDraft(t.dataset.path) }], { align: 'right', width: 230 }); break;
    case 'draft-undo': { const r = await api('draft.undo', { path: t.dataset.path }); if (r.ok === false) toast(r.error, 'warn'); else { applyView(r); teardownEditor(); S.pf = null; render(); toast('已撤销上一处修改', 'ok', 1400); } break; }
    case 'draft-discard': discardDraft(t.dataset.path); break;
    case 'pf-save': savePf(); break;
    case 'pf-revert': S.pf = null; render(); break;
    case 'cover-pick': { const s = curSrc(p), f = (await pick('image'))[0]; if (f && s) { busy(true); try { applyView(await apiOk('edit', { path: s.path, op: { op: 'cover', file: f } })); S.pf = S.pf?.dirty ? S.pf : null; toast('封面已更换', 'ok', 1500); } catch (err) { toast(err.message, 'error', 6000); } busy(false); render(); } break; }
    case 'cover-remove': { const s = curSrc(p); busy(true); try { applyView(await apiOk('edit', { path: s.path, op: { op: 'cover', file: null } })); S.pf = S.pf?.dirty ? S.pf : null; } catch (err) { toast(err.message, 'error'); } busy(false); render(); break; }
    case 'nav-art': {
      if (e.target.closest('.na-acts')) break;
      const s = curSrc(p), k = s.path + '|' + t.dataset.a;
      S.navClosed.has(k) ? S.navClosed.delete(k) : S.navClosed.add(k);
      t.parentElement.classList.toggle('closed');
      break;
    }
    case 'nav-item': selectItem({ a: Number(t.dataset.a), key: t.dataset.key, mode: 'item' }); break;
    case 'art-settings': e.stopPropagation(); selectItem({ a: Number(t.dataset.a), key: null, mode: 'artifact' }); break;
    case 'add-item': e.stopPropagation(); addItem(Number(t.dataset.a), {}); break;
    case 'new-artifact': newArtifactFlow(); break;
    case 'new-menu-edit': {
      const d = S.content.data; if (!d) break;
      const items = d.artifacts.filter(a => ['worldbook', 'regex', 'script'].includes(a.kind) && a.format !== 'text').map(a => ({ label: (a.kind === 'worldbook' ? '新条目 → ' : a.kind === 'regex' ? '新正则 → ' : '新脚本 → ') + a.name, icon: KIND_ICON[a.kind], onClick: () => addItem(a.index, {}) }));
      menu(t, [...items, ...(items.length ? ['-'] : []), { label: '新建 artifact…', icon: 'plus', onClick: newArtifactFlow }], { width: 280 });
      break;
    }
    case 'jump': selectItem(t.dataset.key ? { a: Number(t.dataset.a), key: t.dataset.key, mode: 'item' } : { a: Number(t.dataset.a), key: null, mode: 'artifact' }); break;
    case 'dopen': { const k = t.dataset.k; S.dopen.has(k) ? S.dopen.delete(k) : S.dopen.add(k); renderBody(p, curSrc(p)); break; }
    case 'copy-log': copyText(S.logs.filter(l => l.pid === p.id).map(l => l.text).join('\n\n')); break;
    case 'ed-reload': { const s = curSrc(p); if (S.ed?.pendingFresh) mountEditor(s, S.ed.pendingFresh); break; }
    case 'ed-keep': { $('.ed-conflict')?.remove(); if (S.ed) { S.ed.sig = curSrc(p)?.sig; S.ed.pendingFresh = null; } break; }
  }
});
document.addEventListener('change', e => {
  if (workshopChange(e)) return;
  const t = e.target;
  if (t.dataset.act === 'base') { const s = curSrc(); const o = S.cmpOpts?.[Number(t.value)]; if (s && o) { S.base[s.path] = { path: o.path, saved: !!o.saved }; renderBody(curProject(), s); } }
});
document.addEventListener('input', e => {
  workshopInput(e);
  const t = e.target; if (t.dataset?.max) { const c = t.parentElement?.querySelector('[data-cnt]'); if (c) { const n = t.value.trim().length, m = Number(t.dataset.max); c.textContent = n + ' / ' + m; c.classList.toggle('over', n > m); } }
});
document.addEventListener('input', debounce(e => {
  if (e.target.id === 'navq') { S.navq = e.target.value; const s = curSrc(); if (s) renderNav(s); }
}, 120));
document.addEventListener('keydown', e => {
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') { closeMenu(); if (layers.length) { const m = layers[layers.length - 1]; if (m.closable) m.close(null); } return; }
  if (layers.length) return;
  if (e.key === 'Enter' && e.target.matches?.('.wcard')) { e.preventDefault(); e.target.click(); return; }
  if (mod && k === 's') { e.preventDefault(); if (S.tab === 'edit' && S.ed) saveEditor(); else if (S.tab === 'overview' && S.pf?.dirty) savePf(); return; }
  if (mod && k === 'o') { e.preventDefault(); (async () => openPaths(await pick(e.shiftKey ? 'folders' : 'packs')))(); return; }
  if (mod && k === 'n') { e.preventDefault(); newProjectFlow(); return; }
  if (e.key === 'F1') { e.preventDefault(); tutorialFlow(); return; }
  if (mod && k === 'b') { e.preventDefault(); $('[data-act="toggle-sidebar"]')?.click(); return; }
  if (mod && /^[1-5]$/.test(e.key) && curProject() && S.view !== 'workshop') { e.preventDefault(); $(`[data-act="tab"][data-tab="${['overview', 'edit', 'checks', 'changes', 'log'][Number(e.key) - 1]}"]`)?.click(); return; }
  if (e.key === 'F5') { e.preventDefault(); const s = curSrc(); if (s && !S.busy) runAction('check', s.path); }
});

// ---------- 拖放 ----------
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#dropov').classList.add('on'); });
window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropov').classList.remove('on'); });
window.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('#dropov').classList.remove('on');
  // 图片拖到封面区域：直接设为封面
  const files = [...e.dataTransfer.files];
  const paths = files.map(f => host.pathFor(f)).filter(Boolean);
  if (e.target.closest?.('.cover-box') && paths.length === 1 && /\.(jpe?g|png|webp|gif|avif|svg)$/i.test(paths[0])) {
    const s = curSrc(); if (s) apiOk('edit', { path: s.path, op: { op: 'cover', file: paths[0] } }).then(r => { applyView(r); S.pf = S.pf?.dirty ? S.pf : null; render(); toast('封面已更换', 'ok'); }).catch(err => toast(err.message, 'error'));
    return;
  }
  if (paths.length) openPaths(paths); else toast('无法读取拖入的文件', 'warn');
});

// ---------- 启动 ----------
host.on(async (type, data) => {
  if (type === 'changed') refreshSoon();
  if (type === 'workshop') onWorkshopEvent(data);
  if (type === 'tavern') onTavernEvent(data);
  if (type === 'update') onUpdateEvent(data);
  if (type === 'ai') onAIEvent(data);
  if (type === 'opened') {
    await refresh();
    if (data?.select) { if (await confirmLeaveEditor()) { S.view = 'project'; S.sel = data.select; if (data.path) S.src[data.select] = data.path; teardownEditor(); S.pf = null; S.tab = 'overview'; render(); } }
    for (const x of data?.errors || []) toast(x.message, 'warn', 6000);
  }
  if (type === 'close-request') {
    api('closeAck');
    const drafts = data?.drafts || [];
    const dirtyForm = S.ed?.dirty || S.pf?.dirty;
    if (!drafts.length && !dirtyForm) { api('quit'); return; }
    const lines = [...(dirtyForm ? ['正在编辑的内容还没有保存'] : []), ...drafts.map(d => baseName(d.path) + '：' + d.count + ' 处未保存的修改')];
    const v = await ask({ title: '还有未保存的修改', html: `<ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul><p>退出后这些修改会丢失。</p>`, buttons: [{ label: '取消', value: null }, { label: '不保存，退出', value: 'quit', danger: true }] });
    if (v === 'quit') api('quit');
  }
});
async function init() {
  try {
    const [st, appInfo, pending] = await Promise.all([api('state'), api('appInfo'), api('pending')]);
    S.env = st; S.app = appInfo; S.settings = st.settings || {};
    api('sim.available').then(v => { S.sim = v; }).catch(() => {});
    applyView(st);
    if (pending?.select) { S.sel = pending.select; if (pending.path) S.src[pending.select] = pending.path; }
    for (const x of pending?.errors || []) toast(x.message, 'warn', 6000);
    render();
    const ctx = { S, api, apiOk, render, renderSide, renderMain, allSrc, curSrc, curProject, findByPath, pick, applyView, busy, select: id => select(id) };
    initTavern(ctx).then(render);
    initUpdates(ctx);
    initAI(ctx);
    initWorkshop(ctx).then(render);
  } catch (e) {
    $('#main').innerHTML = `<div class="welcome"><h1>启动失败</h1><p>${esc(e.message)}</p></div>`;
  }
}
init();
