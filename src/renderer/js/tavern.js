// 安装到 SillyTavern：安装桥的设置、连接状态、安装 / 卸载流程
import { $, esc, icon, toast, copyText, modal, ask } from './util.js';

let X = null;
const T = { st: null, watchers: new Set() };
const api = (r, b) => X.api(r, b);
const STEPS = [['sent', '交给 SillyTavern'], ['download', '读取离线包'], ['uninstall', '卸载已安装的版本'], ['import', '导入创意工坊'], ['preflight', '安装检查'], ['apply', '安装到酒馆']];

export async function initTavern(ctx) {
  X = ctx;
  try { T.st = await api('st.state'); } catch { T.st = null; }
}
export function onTavernEvent(d) {
  if (d?.type === 'state') {
    const before = JSON.stringify([T.st?.connected, T.st?.client?.character, T.st?.client?.installed]);
    T.st = d.state;
    for (const w of T.watchers) w();
    if (JSON.stringify([T.st?.connected, T.st?.client?.character, T.st?.client?.installed]) !== before) X.render();
  }
  if (d?.type === 'job') for (const w of T.watchers) w(d.job);
}
const connected = () => !!T.st?.connected;
const client = () => T.st?.client || null;
const recordOf = id => client()?.installed?.find(r => r.id === id) || null;
// 可以安装的来源：当前查看的版本优先，其次项目文件夹、最新的离线包
export function installSource(p) {
  const ok = s => s && !s.draft && !s.fatal && s.level !== 'error';
  return [X.curSrc(p), ...p.folders, ...p.packs].find(ok) || null;
}

// ---------- 侧栏底部的连接状态 ----------
export function sideStatus(collapsed) {
  const st = T.st;
  if (!st) return '';
  const on = st.running && st.connected, c = client();
  const text = !st.enabled ? 'SillyTavern：未设置安装桥' : !st.running ? 'SillyTavern：安装桥未启动' : on ? 'SillyTavern 已连接' + (c?.character ? ' · ' + c.character : '') : 'SillyTavern：等待连接';
  if (collapsed) return `<span class="dot ${on ? 'ok' : 'off'}" data-act="st-setup" title="${esc(text)}"></span>`;
  return `<div class="row st-side" data-act="st-setup" title="安装到 SillyTavern 的连接设置"><span class="dot ${on ? 'ok' : st.enabled && st.running ? 'wait' : 'off'}"></span><span class="ell">${esc(text)}</span></div>`;
}

// ---------- 概览页卡片 ----------
export function tavernCard(p) {
  if (!T.st) return '';
  const s = installSource(p), rec = recordOf(p.id), on = connected(), c = client();
  const v = Number(s?.version) || 0;
  let state = '';
  if (on && c?.installed) {
    if (rec?.applied) state = `<div class="wp-row"><span class="pill ok">${icon('check')}已安装 v${esc(rec.appliedVersion)}</span><span class="muted small ell">角色：${esc(rec.targetCharacterName || '（不需要角色）')}</span></div>`;
    else if (rec) state = `<div class="wp-row"><span class="pill plain">已在工坊缓存 v${esc(rec.version)}</span><span class="muted small">尚未安装</span></div>`;
    else state = `<div class="wp-row"><span class="pill plain">未安装</span><span class="muted small ell">当前角色：${esc(c.character || '（没有打开角色卡）')}</span></div>`;
  } else state = `<p class="small muted" style="margin:0 0 10px">${T.st.enabled ? '等待 SillyTavern 连接：打开 SillyTavern 页面，并确认“rwkit 安装桥”脚本已启用。' : '通过酒馆助手脚本“rwkit 安装桥”，把这个项目交给 SillyTavern 里的创意工坊安装，与在工坊里点“安装”相同。'}</p>`;
  const label = rec?.applied ? (v > rec.appliedVersion ? `更新到 v${v}` : '重新安装') : '安装到 SillyTavern';
  return `<div class="card"><div class="card-h">${icon('tavern')}SillyTavern<span class="grow"></span><span class="st-conn ${on ? 'on' : ''}">${on ? '已连接' : '未连接'}</span></div><div class="card-b">${state}
    <button class="btn ${on ? 'primary' : ''} block needs-idle" data-act="st-install" data-pid="${esc(p.id)}" ${s ? '' : 'disabled title="没有可以安装的版本：先保存草稿或修正错误"'}>${icon('tavern')}${label}</button>
    <div class="row" style="margin-top:6px">${rec?.applied && on ? `<button class="btn sm ghost danger needs-idle" data-act="st-uninstall" data-pid="${esc(p.id)}">${icon('trash')}从酒馆卸载</button>` : ''}<button class="btn sm ghost" data-act="st-setup">${icon('settings')}连接设置</button></div>
    ${s && s.kind === 'folder' ? `<div class="fhint">将按项目文件夹当前的内容安装（v${esc(v)}）。</div>` : ''}</div></div>`;
}

// ---------- 设置安装桥 ----------
export function setupFlow({ onReady } = {}) {
  const m = modal({ cls: 'mid', title: `${icon('tavern')}<span>连接 SillyTavern</span>`, body: '<div data-st="body"></div>', foot: '<div class="spacer"></div><button class="btn" data-m="close">关闭</button>' + (onReady ? '<button class="btn primary" data-st-go disabled>继续安装</button>' : '') });
  m.body.classList.add('st-setup');
  let script = null;
  const draw = () => {
    const st = T.st || {}, c = client(), on = st.running && st.connected;
    $('[data-st="body"]', m.el).innerHTML = `
      <div class="st-status ${on ? 'on' : st.error ? 'err' : ''}">${on ? icon('checkCircle') : st.error ? icon('xCircle') : '<span class="spin"></span>'}<div>
        <b>${on ? '已连接 SillyTavern' : st.error ? esc(st.error) : st.running ? '等待 SillyTavern 连接…' : '安装桥没有启动'}</b>
        <small>${on ? `当前角色：${esc(c?.character || '（没有打开角色卡）')} · 创意工坊 ${c?.workshop ? 'v' + esc(c.workshop) : '<span class="warn-text">没有加载</span>'}${c?.installed ? ' · 工坊里有 ' + c.installed.length + ' 个作品' : ''}` : st.running ? `安装桥在本机 127.0.0.1:${esc(st.port)} 等待 SillyTavern 页面里的脚本连接。` : '启用后才会在本机监听。'}</small></div></div>
      <ol class="st-steps">
        <li><b>把“rwkit 安装桥”脚本加入酒馆助手</b><span>SillyTavern → 酒馆助手 → 脚本库 → <b>全局脚本</b> → 导入，选择下面保存的脚本文件；也可以新建脚本，把脚本内容粘贴进去。然后启用它。</span>
          <div class="row"><button class="btn sm primary" data-st="save">${icon('download')}保存脚本文件…</button><button class="btn sm" data-st="copy">${icon('copy')}复制脚本内容</button></div></li>
        <li><b>保持 SillyTavern 页面打开</b><span>并打开一张带“创意工坊”脚本的轮回战场角色卡。安装世界书、正则或角色脚本时，会装到 SillyTavern 当前打开的角色上（与在工坊里点“安装”相同）。</span></li>
        <li><b>回到这里点“安装到 SillyTavern”</b><span>离线包会交给 SillyTavern 里的创意工坊：导入、安装检查、安装；之后在工坊的“本地”页也能看到、更新或卸载。</span></li>
      </ol>
      <div class="st-adv">
        <label class="toggle sm"><input type="checkbox" data-st="enable" ${st.enabled ? 'checked' : ''}><span class="sw"></span><span>启用安装桥</span></label>
        <span class="muted small">端口</span><input class="input num sm" data-st="port" value="${esc(st.port)}"><button class="btn xs" data-st="port-apply">应用</button>
        <span class="grow"></span><button class="btn xs ghost" data-st="regen">${icon('refresh')}重新生成配对码</button>
      </div>
      <div class="fhint">安装桥只监听本机 127.0.0.1，凭脚本里的配对码通信，不连接外网；SillyTavern 页面需要在这台电脑的浏览器里打开。改端口或重新生成配对码后，需要重新导入脚本。</div>`;
    const go = $('[data-st-go]', m.el); if (go) go.disabled = !on;
  };
  const watch = () => { if (m.closed) T.watchers.delete(watch); else draw(); };
  T.watchers.add(watch);
  m.el.addEventListener('click', async e => {
    const a = e.target.closest('[data-st]'), go = e.target.closest('[data-st-go]');
    if (go && !go.disabled) { m.close(); onReady?.(); return; }
    if (!a) return;
    const k = a.dataset.st;
    if (k === 'save') { const r = await api('st.saveScript'); if (r.ok) toast('已保存：' + r.path, 'ok', 4000); }
    if (k === 'copy') { script = script || await api('st.script'); copyText(script.content); }
    if (k === 'port-apply') { const r = await api('st.port', { port: Number($('[data-st="port"]', m.el).value) }); if (r.ok === false) toast(r.error, 'error'); else { T.st = r; script = null; draw(); toast('端口已更改，请重新导入安装桥脚本', 'warn', 5000); } }
    if (k === 'regen') { const v = await ask({ title: '重新生成配对码？', html: '<p>旧的“rwkit 安装桥”脚本会失效，需要在 SillyTavern 里重新导入。</p>', buttons: [{ label: '取消', value: null }, { label: '重新生成', value: 'ok', primary: true }] }); if (v === 'ok') { T.st = await api('st.regen'); script = null; draw(); } }
  });
  m.el.addEventListener('change', async e => { if (e.target.dataset.st === 'enable') { T.st = await api('st.enable', { enabled: e.target.checked }); draw(); X.render(); } });
  draw();
  // 打开设置即启用安装桥
  if (!T.st?.enabled || !T.st?.running) api('st.enable', { enabled: true }).then(r => { T.st = r; if (!m.closed) draw(); X.render(); });
  return m;
}

// ---------- 安装 ----------
export async function installFlow(path) {
  if (!connected()) { setupFlow({ onReady: () => installFlow(path) }); return; }
  const f = X.findByPath(path);
  const name = f?.s.project?.name || f?.p.name || '';
  const id = f?.p.id, v = Number(f?.s.version) || 0;
  const c = client(), rec = recordOf(id);
  if (rec && Number(rec.version) > v && !rec.applied) {
    await ask({ title: 'SillyTavern 里已有更高版本', html: `<p>创意工坊里已经缓存了“${esc(rec.name)}” <b>v${esc(rec.version)}</b>，不会被较旧的 v${esc(v)} 覆盖。</p><p>把本地项目的版本号提高到 v${esc(Number(rec.version) + 1)} 或以上（“保存为新版本”或“打包并升版本号”），再安装；或者先在 SillyTavern 工坊的“本地”页删除这个作品。</p>`, buttons: [{ label: '知道了', value: null, primary: true }] });
    return;
  }
  const lines = [];
  let replace = false;
  if (rec?.applied) {
    replace = true;
    lines.push(`<p>SillyTavern 里已经安装了 <b>v${esc(rec.appliedVersion)}</b>${rec.targetCharacterName ? `（角色“${esc(rec.targetCharacterName)}”）` : ''}：会先卸载旧版本，再安装 v${esc(v)}。卸载会恢复它改动过的原版内容。</p>`);
    if (Number(rec.version) > v) lines.push(`<p class="warn-text">工坊里缓存的是 v${esc(rec.version)}，比要安装的 v${esc(v)} 新，导入会被拒绝：请先提高本地项目的版本号。</p>`);
    if (rec.targetCharacterName && c?.character !== rec.targetCharacterName) lines.push(`<p class="warn-text">SillyTavern 当前打开的是“${esc(c?.character || '（没有角色卡）')}”，旧版本装在“${esc(rec.targetCharacterName)}”上：请先在 SillyTavern 里切回那个角色，否则卸载会失败。</p>`);
  } else {
    lines.push(`<p>把 <b>${esc(name)} v${esc(v)}</b> 交给 SillyTavern 里的创意工坊安装：导入 → 安装检查 → 安装，与在工坊“本地”页点“安装”相同。</p>`);
    lines.push(c?.character ? `<p>世界书、正则与角色脚本会装到 SillyTavern 当前打开的角色 <b>“${esc(c.character)}”</b> 上。</p>` : '<p class="warn-text">SillyTavern 里还没有打开角色卡：安装世界书、正则或角色脚本时需要先打开角色卡。</p>');
  }
  if (!c?.workshop) lines.push('<p class="warn-text">SillyTavern 里没有检测到轮回战场创意工坊：请打开带“创意工坊”脚本的轮回战场角色卡。</p>');
  const ok = await ask({ title: '安装到 SillyTavern', html: lines.join(''), buttons: [{ label: '取消', value: null }, { label: replace ? '卸载旧版本并安装' : '安装', value: 'ok', primary: true }] });
  if (ok !== 'ok') return;
  return runJob(await api('st.install', { path, replace }), name, replace);
}
export function uninstallFlow(p) {
  const rec = recordOf(p.id);
  if (!rec?.applied) return;
  const c = client();
  ask({ title: `从 SillyTavern 卸载“${rec.name}”？`, html: `<p>交给 SillyTavern 里的创意工坊卸载 v${esc(rec.appliedVersion)}：移除它安装的世界书条目、正则与脚本，并恢复它改动过的原版内容。工坊“本地”页里的缓存保留。</p>${rec.targetCharacterName && c?.character !== rec.targetCharacterName ? `<p class="warn-text">它装在角色“${esc(rec.targetCharacterName)}”上，SillyTavern 当前打开的是“${esc(c?.character || '（没有角色卡）')}”：请先切回那个角色。</p>` : ''}`, buttons: [{ label: '取消', value: null }, { label: '卸载', value: 'ok', danger: true }] })
    .then(async v => { if (v === 'ok') runJob(await api('st.uninstall', { projectId: p.id, name: rec.name }), rec.name, false, true); });
}
// 显示任务进度，直到 SillyTavern 返回结果
async function runJob(r, name, replace, uninstall = false) {
  if (r.ok === false) { toast(r.error, 'error', 7000); return; }
  const id = r.job.id;
  const steps = uninstall ? [['sent', '交给 SillyTavern'], ['uninstall', '卸载']] : STEPS.filter(([k]) => replace || k !== 'uninstall');
  const m = modal({ title: `${icon('tavern')}<span>${uninstall ? '卸载' : '安装'} · ${esc(name)}</span>`, body: `<ol class="vsteps up-steps" data-st="steps">${steps.map(([k, t], i) => `<li data-k="${k}"><span class="vs-n">${i + 1}</span><div><b>${t}</b><small></small></div></li>`).join('')}</ol><div data-st="result"></div>`, foot: '<div class="spacer"></div><button class="btn" data-st-cancel>取消</button>', closable: false });
  let cur = 'queued';
  const paint = job => {
    if (job) cur = job.step || cur;
    const idx = steps.findIndex(([k]) => k === cur);
    steps.forEach(([k], i) => {
      const li = $(`[data-k="${k}"]`, m.el); if (!li) return;
      const done = idx > i || job?.state === 'done', now = idx === i && !job?.finished && job?.state !== 'done' && job?.state !== 'failed';
      li.className = job?.state === 'failed' && idx === i ? 'bad' : done ? 'done' : now ? 'cur' : '';
      $('.vs-n', li).innerHTML = li.className === 'done' ? icon('check', 'xs') : li.className === 'cur' ? '<span class="spin"></span>' : li.className === 'bad' ? icon('x', 'xs') : i + 1;
    });
    if (cur === 'queued' || cur === 'sent') {
      const li = $('[data-k="sent"]', m.el), failed = job?.state === 'failed';
      li.className = failed ? 'bad' : cur === 'sent' ? 'done' : 'cur';
      $('.vs-n', li).innerHTML = failed ? icon('x', 'xs') : cur === 'sent' ? icon('check', 'xs') : '<span class="spin"></span>';
      $('small', li).textContent = cur === 'queued' && !failed ? '等待 SillyTavern 领取…' : '';
    }
  };
  const watch = job => { if (job?.id === id) paint(job); };
  T.watchers.add(watch);
  m.el.addEventListener('click', e => { if (e.target.closest('[data-st-cancel]')) api('st.cancel', { id }); });
  m.foot.querySelector('[data-st-cancel]').title = '停止等待（已交给 SillyTavern 的任务可能仍在进行）';
  paint(r.job);
  const { job } = await api('st.wait', { id });
  T.watchers.delete(watch);
  paint(job);
  const res = job.result || {};
  if (job.state === 'done') {
    $$set(m, `<div class="banner ok">${icon('checkCircle')}<div class="bb"><div class="bt">${uninstall ? '已从 SillyTavern 卸载' : `已安装到 SillyTavern${res.record?.targetCharacterName ? '（角色“' + esc(res.record.targetCharacterName) + '”）' : ''}`}</div>${res.warnings?.length ? `<div class="bs">${res.warnings.map(w => '· ' + esc(w)).join('<br>')}</div>` : ''}${res.record?.restoreWarnings ? `<div class="bs warn-text">有 ${res.record.restoreWarnings} 条原版内容的恢复提示，请在工坊“本地”页查看。</div>` : ''}</div></div>`);
    toast(uninstall ? '已从 SillyTavern 卸载' : '已安装到 SillyTavern', 'ok');
  } else {
    const hint = res.code === 'not_connected' ? '<div class="ba"><button class="btn sm" data-st-setup>打开连接设置</button></div>' : '';
    $$set(m, `<div class="banner error">${icon('xCircle')}<div class="bb"><div class="bt">${uninstall ? '卸载失败' : '安装失败'}</div><div class="bs">${esc(res.error || '未知错误')}</div>${hint}</div></div>`);
    m.el.addEventListener('click', e => { if (e.target.closest('[data-st-setup]')) { m.close(); setupFlow(); } });
  }
  m.foot.innerHTML = '<div class="spacer"></div><button class="btn primary" data-m="close">完成</button>';
}
const $$set = (m, html) => { $('[data-st="result"]', m.el).innerHTML = html; };

export async function tavernClick(act, t) {
  switch (act) {
    case 'st-setup': setupFlow(); return true;
    case 'st-install': {
      const p = X.S.projects.find(x => x.id === t.dataset.pid) || X.curProject();
      const s = t.dataset.path ? { path: t.dataset.path } : p && installSource(p);
      if (!s) { toast('没有可以安装的版本：先保存草稿或修正错误', 'warn'); return true; }
      installFlow(s.path); return true;
    }
    case 'st-uninstall': { const p = X.S.projects.find(x => x.id === t.dataset.pid); if (p) uninstallFlow(p); return true; }
  }
  return false;
}
export const tavernState = () => T;
