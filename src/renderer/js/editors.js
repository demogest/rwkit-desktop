// 编辑表单：世界书条目、正则、脚本、其他内容与 artifact 设置
import { esc, icon, clone, stable, isObj, debounce, KIND, KIND_ICON, POS, ROLE, PLACE, LOGIC, SCOPE, $, $$ } from './util.js';
import { createEditor } from '../vendor/cm.js';

// ---------- 路径读写 ----------
const splitPath = p => String(p).split('.').map(x => (/^\d+$/.test(x) ? Number(x) : x));
export const getPath = (o, p) => splitPath(p).reduce((v, k) => (v == null ? undefined : v[k]), o);
export function setPath(o, p, v) {
  const ks = splitPath(p); let cur = o;
  for (let i = 0; i < ks.length - 1; i++) { if (cur[ks[i]] == null) cur[ks[i]] = typeof ks[i + 1] === 'number' ? [] : {}; cur = cur[ks[i]]; }
  cur[ks[ks.length - 1]] = v;
}

// ---------- 字段 ----------
const F = {
  text: (p, v, ph = '', cls = '') => `<input class="input ${cls}" data-bind="${p}" data-type="text" value="${esc(v ?? '')}" placeholder="${esc(ph)}" spellcheck="false">`,
  num: (p, v, ph = '', type = 'num') => `<input class="input num" type="number" data-bind="${p}" data-type="${type}" value="${esc(v ?? '')}" placeholder="${esc(ph)}">`,
  toggle: (p, on, label, type = 'bool', hint = '') => `<label class="toggle" ${hint ? `title="${esc(hint)}"` : ''}><input type="checkbox" data-bind="${p}" data-type="${type}" ${on ? 'checked' : ''}><span class="sw"></span><span>${label}</span></label>`,
  select: (p, v, options, type = 'text') => `<select class="input" data-bind="${p}" data-type="${type}">${options.map(([val, t]) => `<option value="${esc(val)}" ${String(v ?? '') === String(val) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`,
  tri: (p, v) => F.select(p, v === null || v === undefined ? '' : String(v), [['', '跟随全局设置'], ['true', '是'], ['false', '否']], 'tri'),
  chips: (p, list, ph) => `<div class="chips" data-chips="${p}">${chipItems(list)}<input class="chip-in" placeholder="${esc(ph)}" spellcheck="false"></div>`,
  field: (label, body, hint = '', attrs = '') => `<div class="field" ${attrs}><label class="flabel">${label}</label><div class="fval">${body}${hint ? `<div class="fhint">${hint}</div>` : ''}</div></div>`,
};
export { F };
// 可增删的列表：每种列表的行模板与新行
const LISTS = {
  'button.buttons': {
    row: (b, i) => `<div class="list-row"><input class="input" data-bind="button.buttons.${i}.name" data-type="text" value="${esc(b?.name ?? '')}" placeholder="按钮名称">${F.toggle('button.buttons.' + i + '.visible', b?.visible !== false, '显示', 'bool')}<button class="btn ghost icon sm" data-list-del="button.buttons" data-i="${i}" title="删除">${icon('trash')}</button></div>`,
    add: () => ({ name: '新按钮', visible: true }), label: '添加按钮',
  },
  conflicts: {
    row: (c, i, ed) => `<div class="list-row wrap">
      ${F.select('conflicts.' + i + '.action', c.action, [['disable', '停用原版'], ['replace', '替换原版']])}
      ${ed.data.kind === 'script' ? F.select('conflicts.' + i + '.target.scope', c.target?.scope || 'character', Object.entries(SCOPE)) + `<input class="input" data-bind="conflicts.${i}.target.id" data-type="text" value="${esc(c.target?.id ?? '')}" placeholder="原版脚本 id">`
        : `<input class="input num" data-bind="conflicts.${i}.target.uid" data-type="text" value="${esc(c.target?.uid ?? '')}" placeholder="原版条目 uid">`}
      <input class="input" data-bind="conflicts.${i}.target.name" data-type="text" value="${esc(c.target?.name ?? '')}" placeholder="名称">
      <button class="btn ghost icon sm" data-list-del="conflicts" data-i="${i}" title="删除">${icon('trash')}</button></div>`,
    add: ed => ({ action: 'disable', target: ed.data.kind === 'script' ? { scope: 'character', id: '', name: '' } : { uid: '', name: '' } }), label: '添加冲突声明',
  },
  dependencies: {
    row: (d, i, ed) => `<div class="list-row">
      <input class="input mono grow" data-bind="dependencies.${i}.project_id" data-type="text" value="${esc(d.project_id ?? '')}" placeholder="被依赖项目的 id" list="known-projects">
      <span class="dep-name muted small">${esc(ed.names?.[d.project_id] || '')}</span>
      <label class="inline-f">最低版本 <input class="input num" type="number" min="1" data-bind="dependencies.${i}.min_version" data-type="num" value="${esc(d.min_version ?? 1)}"></label>
      <button class="btn ghost icon sm" data-list-del="dependencies" data-i="${i}" title="删除">${icon('trash')}</button></div>`,
    add: () => ({ project_id: '', min_version: 1 }), label: '添加依赖',
  },
  overrides: {
    row: (r, i) => {
      const t = r.target || {}, k = r.kind;
      const tf = (key, ph, cls = '') => `<input class="input ${cls}" data-bind="overrides.${i}.target.${key}" data-type="text" value="${esc(t[key] ?? '')}" placeholder="${ph}">`;
      const target = k === 'worldbook' ? tf('worldbook', '世界书名（可选）') + tf('uid', 'uid', 'num') + tf('name', '条目名称')
        : k === 'script' ? F.select('overrides.' + i + '.target.scope', t.scope || 'character', Object.entries(SCOPE)) + tf('id', '脚本 id') + tf('name', '脚本名称')
          : tf('id', '正则 id') + tf('name', '正则名称');
      return `<div class="list-row wrap ov-row">
        ${F.select('overrides.' + i + '.kind', k, [['worldbook', '世界书条目'], ['regex', '正则'], ['script', '脚本']])}
        ${F.select('overrides.' + i + '.state', r.state, [['disabled', '停用'], ['enabled', '启用']])}
        ${target}
        <button class="btn ghost icon sm" data-list-del="overrides" data-i="${i}" title="删除">${icon('trash')}</button></div>`;
    },
    add: () => ({ kind: 'worldbook', state: 'disabled', target: { worldbook: '', uid: '', name: '' } }), label: '添加规则',
  },
};
export function listInner(p, ed) {
  const L = LISTS[p], list = getPath(ed.form, p) || [];
  return list.map((x, i) => L.row(x, i, ed)).join('') + `<button class="btn sm ghost" data-list-add="${p}">${icon('plus')}${L.label}</button>`;
}
export const listHtml = (p, ed, attrs = '') => `<div class="list" data-list="${p}" ${attrs}>${listInner(p, ed)}</div>`;
const chipItems = list => (Array.isArray(list) ? list : []).map((c, i) => `<span class="chip">${esc(c)}<button type="button" data-chip-del="${i}" tabindex="-1" title="移除">${icon('x')}</button></span>`).join('');
const COND = {
  pos4: f => Number(f.position) === 4,
  pos7: f => Number(f.position) === 7,
  useProb: f => f.useProbability !== false,
  keysHint: f => !!f.constant,
  hasKeys2: f => Array.isArray(f.keysecondary) && f.keysecondary.length > 0,
  btnOn: f => f.button?.enabled !== false,
};

// ---------- 表头与表尾 ----------
function head(ed, ctx, titlePath, titlePh, actions) {
  const d = ed.data, crumb = ed.type === 'artifact' ? 'artifact 设置' : d.artifact?.name || '';
  return `<div class="ed-head">
    <div class="ed-crumb">${icon(KIND_ICON[d.kind] || 'file', 'xs')}<span>${esc(KIND[d.kind] || d.kind)}</span><span class="sep">/</span><span class="ell">${esc(crumb)}</span>${ed.key != null && ed.type !== 'artifact' ? `<span class="sep">/</span><span class="mono muted">${esc(ed.type === 'entry' ? 'uid ' + (ed.form.uid ?? '') : ed.key)}</span>` : ''}</div>
    <div class="ed-titlebar">
      ${titlePath ? `<input class="title-input" data-bind="${titlePath}" data-type="text" value="${esc(getPath(ed.form, titlePath) ?? '')}" placeholder="${esc(titlePh)}" spellcheck="false">` : `<div class="title-static">${esc(d.label)}</div>`}
      <div class="ed-actions">${actions}</div>
    </div></div>`;
}
function warnsHtml(ctx) {
  const list = ctx.warns || [];
  if (!list.length) return '';
  return `<div class="ed-warns">${list.map(w => `<div class="ed-warn ${w.level}">${icon(w.level === 'error' ? 'xCircle' : 'alert')}<span>${esc(w.text.replace(/^“.+?”\s*/, ''))}</span></div>`).join('')}<div class="fhint">以上是上次保存后的检查结果，保存后会重新检查。</div></div>`;
}
export function footHtml(ed, ctx) {
  const where = ctx.isFolder ? '保存后直接写入项目文件夹' + (ctx.file ? '：' + ctx.rel : '') : '保存到草稿；点页面底部的“保存为新版本”后才写入 .rwpack';
  return `<div class="ed-foot">
    <span class="ed-state ${ed.dirty ? 'dirty' : ''}">${ed.dirty ? icon('dot') + '有未保存的修改' : ed.savedAt ? icon('check') + '已保存' : ''}</span>
    <span class="ed-where" title="${esc(where)}">${esc(where)}</span>
    <button class="btn" data-ed="revert" ${ed.dirty ? '' : 'disabled'}>${icon('undo')}还原</button>
    <button class="btn primary" data-ed="save" ${ed.dirty && !ed.saving ? '' : 'disabled'}>${ed.saving ? '<span class="spin sm"></span>' : icon('save')}保存<kbd>Ctrl+S</kbd></button>
  </div>`;
}
function moreBtn(ed, ctx) {
  return `<button class="btn ghost icon" data-ed="more" title="更多">${icon('more')}</button>`;
}
function dupBtn(label) { return `<button class="btn ghost sm" data-ed="duplicate" title="以当前内容新建一项（不含未保存的修改以外的内容）">${icon('duplicate')}${label}</button>`; }

// ---------- 世界书条目 ----------
function entryHtml(ed, ctx) {
  const f = ed.form;
  const posOpts = Object.entries(POS).map(([k, t]) => [k, t]);
  return head(ed, ctx, 'comment', '条目名称（必填，工坊安装时必须有）', dupBtn('复制为新条目') + moreBtn(ed, ctx)) + `<div class="ed-body" data-scroll>
    ${warnsHtml(ctx)}
    <div class="ed-toggles">
      ${F.toggle('disable', !f.disable, '启用', 'boolnot', '关闭后这条不会发送给 AI（disable）')}
      ${F.toggle('constant', !!f.constant, '常驻', 'bool', '每次都发送，不需要关键词（constant）')}
      <div class="grow"></div>
      <label class="inline-f">uid ${F.num('uid', f.uid, '', 'num')}</label>
    </div>
    <section class="ed-sec">
      <h4>${icon('zap', 'xs')}触发</h4>
      ${F.field('关键词', F.chips('key', f.key, '输入关键词后按回车；可一次粘贴多个，用逗号分隔'), `<span data-show="keysHint">已设为常驻：每次都会发送，关键词不起作用。</span><span data-show="!keysHint">聊天里出现任意一个关键词时发送。</span>`)}
      ${F.field('次要关键词', F.chips('keysecondary', f.keysecondary, '可选'), '')}
      <div class="field" data-show="hasKeys2"><label class="flabel">次要关键词逻辑</label><div class="fval">${F.select('selectiveLogic', f.selectiveLogic ?? 0, Object.entries(LOGIC), 'num')}</div></div>
      <div class="field"><label class="flabel">触发概率</label><div class="fval row">${F.toggle('useProbability', f.useProbability !== false, '按概率触发')}<span data-show="useProb" class="row">${F.num('probability', f.probability ?? 100)}<span class="muted">%</span></span></div></div>
    </section>
    <section class="ed-sec">
      <h4>${icon('layers', 'xs')}插入</h4>
      <div class="grid4">
        <div><label class="flabel">位置</label>${F.select('position', f.position ?? 0, posOpts, 'num')}</div>
        <div data-show="pos4"><label class="flabel">深度</label>${F.num('depth', f.depth ?? 4)}<div class="fhint">插在倒数第几条消息处</div></div>
        <div data-show="pos4"><label class="flabel">身份</label>${F.select('role', f.role ?? 0, Object.entries(ROLE), 'num')}</div>
        <div data-show="pos7"><label class="flabel">出口名称</label>${F.text('outletName', f.outletName)}</div>
        <div><label class="flabel">顺序</label>${F.num('order', f.order ?? 100)}<div class="fhint">越小越靠前</div></div>
      </div>
    </section>
    <section class="ed-sec code">
      <h4>${icon('file', 'xs')}正文 <span class="muted small" data-live="chars"></span><span class="grow"></span>
        <button class="btn xs ghost" data-ed="find" title="查找与替换（Ctrl+F）">${icon('search')}查找</button>
        <label class="toggle sm"><input type="checkbox" data-ed-wrap="content" checked><span class="sw"></span>自动换行</label></h4>
      <div class="cm-host" data-cm="content" data-lang="worldbook" data-autoh="220,560" data-hint="在这里写条目正文。支持 EJS（&lt;% %&gt;）与酒馆宏（{{user}} 等）。"></div>
    </section>
    <details class="ed-sec adv">
      <summary>${icon('sliders', 'xs')}高级设置</summary>
      <div class="adv-grid">
        ${F.toggle('excludeRecursion', !!f.excludeRecursion, '不被其他条目递归触发', 'bool')}
        ${F.toggle('preventRecursion', !!f.preventRecursion, '不递归触发其他条目', 'bool')}
        ${F.toggle('delayUntilRecursion', !!f.delayUntilRecursion, '延迟到递归时才触发', 'bool')}
        ${F.toggle('selective', f.selective !== false, '启用次要关键词（selective）', 'bool')}
      </div>
      <div class="grid4">
        <div><label class="flabel">扫描深度</label>${F.num('scanDepth', f.scanDepth, '全局', 'numnull')}</div>
        <div><label class="flabel">区分大小写</label>${F.tri('caseSensitive', f.caseSensitive)}</div>
        <div><label class="flabel">全词匹配</label>${F.tri('matchWholeWords', f.matchWholeWords)}</div>
        <div><label class="flabel">分组</label>${F.text('group', f.group)}</div>
        <div><label class="flabel">分组权重</label>${F.num('groupWeight', f.groupWeight ?? 100)}</div>
        <div><label class="flabel">粘性（轮）</label>${F.num('sticky', f.sticky ?? 0)}</div>
        <div><label class="flabel">冷却（轮）</label>${F.num('cooldown', f.cooldown ?? 0)}</div>
        <div><label class="flabel">延迟（轮）</label>${F.num('delay', f.delay ?? 0)}</div>
      </div>
      <div class="adv-grid">${F.toggle('groupOverride', !!f.groupOverride, '分组优先', 'bool')}${F.toggle('useGroupScoring', !!f.useGroupScoring, '分组评分', 'bool')}${F.toggle('addMemo', f.addMemo !== false, '显示备注（addMemo）', 'bool')}</div>
      <details class="raw"><summary>查看全部字段（JSON，只读）</summary><pre class="code" data-live="json"></pre></details>
    </details>
  </div>`;
}

// ---------- 正则 ----------
export function toRegExp(src) {
  const m = String(src).match(/^\/([\s\S]*)\/([dgimsuvy]*)$/);
  return m ? new RegExp(m[1], m[2]) : new RegExp(String(src));
}
const pageOf = text => { const m = /^```html\s*\n([\s\S]*?)\n?```\s*$/.exec(text || ''); return m ? m[1] : /^\s*<!DOCTYPE html/i.test(text || '') ? text : null; };
export const isPage = text => pageOf(text) != null;
export { pageOf };
function regexHtml(ed, ctx) {
  const f = ed.form, page = isPage(f.replaceString);
  const scope = f.promptOnly ? 'prompt' : f.markdownOnly ? 'display' : 'both';
  return head(ed, ctx, 'scriptName', '正则名称', dupBtn('复制为新正则') + moreBtn(ed, ctx)) + `<div class="ed-body" data-scroll>
    ${warnsHtml(ctx)}
    <div class="ed-toggles">${F.toggle('disabled', !f.disabled, '启用', 'boolnot')}${F.toggle('runOnEdit', !!f.runOnEdit, '编辑消息时也运行', 'bool')}</div>
    <section class="ed-sec">
      <h4>${icon('search', 'xs')}查找</h4>
      <div class="regex-in">${F.text('findRegex', f.findRegex ?? f.find_regex ?? '', '例如 /<告示>([\\s\\S]*?)<\\/告示>/g，或直接写文字', 'mono')}<span class="regex-state" data-live="rx"></span></div>
      <div class="fhint">写成 /…/标志 的形式（如 /…/g），或直接写要找的文字。替换内容里用 $1、$2 引用捕获组，{{match}} 代表整段匹配。</div>
    </section>
    <section class="ed-sec code">
      <h4>${icon('pencil', 'xs')}替换为 <span class="pill acc sm" data-live="pagebadge" ${page ? '' : 'hidden'}>HTML 页面</span><span class="muted small" data-live="chars"></span><span class="grow"></span>
        <button class="btn xs" data-ed="preview" ${page ? '' : 'hidden'}>${icon('eye')}预览页面</button>
        <button class="btn xs ghost" data-ed="find" title="查找与替换（Ctrl+F）">${icon('search')}查找</button>
        <label class="toggle sm"><input type="checkbox" data-ed-wrap="replaceString" checked><span class="sw"></span>自动换行</label></h4>
      <div class="cm-host" data-cm="replaceString" data-autoh="110,460" data-lang="${page ? 'html' : 'text'}" data-hint="匹配到的文字会被替换成这里的内容；留空表示删除匹配内容。整段写成 \`\`\`html … \`\`\` 时会渲染成页面。"></div>
    </section>
    <section class="ed-sec">
      <h4>${icon('layers', 'xs')}作用范围</h4>
      ${F.field('作用于', `<div class="chk-group">${Object.entries(PLACE).map(([k, t]) => `<label class="chk"><input type="checkbox" data-arr="placement" data-v="${k}" ${(f.placement || []).map(Number).includes(Number(k)) ? 'checked' : ''}>${t}</label>`).join('')}</div>`)}
      ${F.field('改动哪里', `<div class="seg" data-seg="scope">${[['both', '显示与发给 AI 都改'], ['display', '只改显示'], ['prompt', '只改发给 AI']].map(([v, t]) => `<button type="button" data-v="${v}" class="${scope === v ? 'on' : ''}">${t}</button>`).join('')}</div>`, '“只改显示”不影响 AI 看到的内容（markdownOnly）；“只改发给 AI”不影响聊天里的显示（promptOnly）。')}
      ${F.field('楼层范围', `<div class="row">从倒数第 ${F.num('minDepth', f.minDepth, '不限', 'numnull')} 层 到第 ${F.num('maxDepth', f.maxDepth, '不限', 'numnull')} 层</div>`, '留空表示不限。')}
    </section>
    <section class="ed-sec tester">
      <h4>${icon('flask', 'xs')}测试<span class="grow"></span><span class="muted small" data-live="rxcount"></span></h4>
      <textarea class="input mono" data-test rows="4" placeholder="在这里粘贴一段聊天文字，下面会实时显示匹配位置与替换结果">${esc(ctx.sample || '')}</textarea>
      <div class="test-out" data-live="rxout"></div>
    </section>
    <details class="ed-sec adv">
      <summary>${icon('sliders', 'xs')}高级设置</summary>
      ${F.field('裁剪文字', F.chips('trimStrings', f.trimStrings, '替换前从匹配内容里去掉的文字'), '')}
      ${F.field('查找中的宏', F.select('substituteRegex', f.substituteRegex ?? 0, [['0', '不替换宏'], ['1', '替换为原文'], ['2', '替换为转义后的文字']], 'num'), '查找内容里出现 {{user}} 等酒馆宏时如何处理。')}
      <details class="raw"><summary>查看全部字段（JSON，只读）</summary><pre class="code" data-live="json"></pre></details>
    </details>
  </div>`;
}

// ---------- 脚本 ----------
function scriptHtml(ed, ctx) {
  const f = ed.form;
  if (ed.type === 'scriptText') {
    return head(ed, ctx, null, '', moreBtn(ed, ctx)) + `<div class="ed-body" data-scroll>${warnsHtml(ctx)}
      <section class="ed-sec code tall"><h4>${icon('fileCode', 'xs')}脚本正文<span class="grow"></span><span class="syntax" data-live="syntax"></span><button class="btn xs ghost" data-ed="find">${icon('search')}查找</button></h4>
      <div class="cm-host" data-cm="text" data-lang="js" data-nowrap></div></section></div>`;
  }
  const btns = f.button?.buttons || [];
  return head(ed, ctx, 'name', '脚本名称', dupBtn('复制为新脚本') + moreBtn(ed, ctx)) + `<div class="ed-body" data-scroll>
    ${warnsHtml(ctx)}
    <div class="ed-toggles">${F.toggle('enabled', f.enabled !== false, '启用', 'bool')}${f.type === 'folder' ? '' : ''}</div>
    <section class="ed-sec">
      ${F.field('说明', F.text('info', f.info, '可选：这个脚本做什么'))}
      <div class="field"><label class="flabel">按钮</label><div class="fval">
        ${F.toggle('button.enabled', f.button?.enabled !== false, '在输入框上方显示按钮', 'bool')}
        ${listHtml('button.buttons', ed, 'data-show="btnOn"')}
        <div class="fhint">脚本里用 eventOn(getButtonEvent('按钮名称'), 回调) 响应点击，按钮名称要与这里一致。</div></div></div>
    </section>
    <section class="ed-sec code tall">
      <h4>${icon('fileCode', 'xs')}脚本正文<span class="grow"></span><span class="syntax" data-live="syntax"></span><button class="btn xs ghost" data-ed="find">${icon('search')}查找</button></h4>
      <div class="cm-host" data-cm="content" data-lang="js" data-nowrap></div>
    </section>
    <details class="ed-sec adv"><summary>${icon('sliders', 'xs')}其他字段</summary>
      ${F.field('脚本 id', `<span class="mono small">${esc(f.id ?? '（无）')}</span>`)}
      <details class="raw"><summary>查看全部字段（JSON，只读）</summary><pre class="code" data-live="json"></pre></details>
    </details>
  </div>`;
}

// ---------- 预设、数据等整体内容 ----------
function rawHtml(ed, ctx) {
  return head(ed, ctx, null, '', moreBtn(ed, ctx)) + `<div class="ed-body" data-scroll>${warnsHtml(ctx)}
    <section class="ed-sec code tall"><h4>${icon('database', 'xs')}${ed.data.json ? '内容（JSON）' : '内容'}<span class="grow"></span><span class="syntax" data-live="jsonok"></span><button class="btn xs ghost" data-ed="find">${icon('search')}查找</button></h4>
    <div class="cm-host" data-cm="text" data-lang="${ed.data.json ? 'json' : 'text'}" data-nowrap></div></section></div>`;
}

// ---------- artifact 设置 ----------
function artifactHtml(ed, ctx) {
  const f = ed.form, d = ed.data;
  const canConf = d.kind === 'worldbook' || d.kind === 'script';
  return head(ed, ctx, 'name', 'artifact 名称', '') + `<div class="ed-body" data-scroll>
    <section class="ed-sec">
      <div class="kv">
        <div class="k">类型</div><div class="v"><span class="kind ${d.kind}">${esc(KIND[d.kind] || d.kind)}</span> <span class="muted small">格式 ${esc(d.format)}</span></div>
        <div class="k">包含</div><div class="v">${d.count} ${d.kind === 'worldbook' ? '条条目' : d.kind === 'regex' ? '条正则' : d.kind === 'script' ? '个脚本' : '项'}</div>
        ${d.folder ? `<div class="k">文件夹</div><div class="v mono small ell" title="${esc(d.folder)}">${esc(d.folder)}</div>` : ''}
      </div>
    </section>
    ${d.kind === 'script' ? `<section class="ed-sec">${F.field('作用域', `<div class="seg" data-seg="artscope">${Object.entries(SCOPE).map(([v, t]) => `<button type="button" data-v="${v}" class="${(f.scope || 'character') === v ? 'on' : ''}">${t}</button>`).join('')}</div>`, '角色脚本跟随角色卡；预设脚本跟随预设；全局脚本始终运行。')}</section>` : ''}
    ${canConf ? `<section class="ed-sec"><h4>${icon('link', 'xs')}原版冲突声明</h4>
      <div class="fhint" style="margin-bottom:8px">声明这个 ${esc(KIND[d.kind])} 与原版的哪些${d.kind === 'script' ? '脚本' : '世界书条目'}冲突：安装时停用或替换它们，卸载时恢复。目标至少填 ${d.kind === 'script' ? 'id' : 'uid'} 或名称。</div>
      ${listHtml('conflicts', ed)}</section>` : ''}
    <section class="ed-sec">
      <h4>${icon('sliders', 'xs')}整理</h4>
      <div class="row">
        <button class="btn" data-ed="move-up" ${ctx.index === 0 ? 'disabled' : ''}>${icon('arrowUp')}上移</button>
        <button class="btn" data-ed="move-down" ${ctx.index >= d.total - 1 ? 'disabled' : ''}>${icon('arrowDown')}下移</button>
        <div class="grow"></div>
        <button class="btn danger" data-ed="delete-artifact" ${d.total <= 1 ? 'disabled' : ''}>${icon('trash')}删除这个 artifact</button>
      </div>
      <div class="fhint">${ctx.isFolder ? '删除会把整个 artifact 文件夹移到回收站。' : '删除只影响草稿，保存离线包前都可以撤销。'}</div>
    </section>
  </div>`;
}

// ---------- 渲染与绑定 ----------
export function editorHtml(ed, ctx) {
  const body = { entry: entryHtml, regex: regexHtml, script: scriptHtml, scriptText: scriptHtml, raw: rawHtml, artifact: artifactHtml }[ed.type](ed, ctx);
  return `<div class="ed" data-type="${ed.type}">${body}${footHtml(ed, ctx)}</div>`;
}
// 把表单与 ed.form 绑定；返回清理函数。ctx.changed(ed) 在每次修改后调用
export function bindEditor(root, ed, ctx) {
  const cms = new Map();
  const changed = () => { ed.dirty = stable(ed.form) !== stable(ed.orig); refresh(); ctx.changed(ed); };
  const refresh = () => {
    for (const el of $$('[data-show]', root)) { const n = el.dataset.show, neg = n.startsWith('!'), fn = COND[neg ? n.slice(1) : n]; if (fn) el.hidden = neg ? fn(ed.form) : !fn(ed.form); }
    live();
  };
  // 实时信息：字数、正则状态、测试结果、JSON 预览、语法检查
  const live = () => {
    const f = ed.form, set = (k, html) => { const el = $(`[data-live="${k}"]`, root); if (el) el.innerHTML = html; };
    const textKey = ed.type === 'entry' ? 'content' : ed.type === 'regex' ? 'replaceString' : ed.type === 'script' ? 'content' : null;
    if (textKey) set('chars', '· ' + String(f[textKey] ?? '').length + ' 字');
    if (ed.type === 'regex') {
      let re = null, err = null;
      try { re = toRegExp(f.findRegex ?? ''); } catch (e) { err = e.message; }
      set('rx', f.findRegex ? (err ? `<span class="bad">${icon('xCircle')}无法编译：${esc(err)}</span>` : `<span class="good">${icon('checkCircle')}有效${re.flags ? ' · 标志 ' + esc(re.flags) : ''}</span>`) : `<span class="bad">${icon('alert')}不能为空</span>`);
      const page = isPage(f.replaceString);
      const badge = $('[data-live="pagebadge"]', root); if (badge) badge.hidden = !page;
      const pv = $('[data-ed="preview"]', root); if (pv) pv.hidden = !page;
      const cm = cms.get('replaceString');
      if (cm && cm.lang !== (page ? 'html' : 'text')) { cm.lang = page ? 'html' : 'text'; cm.setLang(cm.lang); }
      tester(re, err);
    }
    if ($('[data-live="json"]', root)) set('json', esc(JSON.stringify(ed.type === 'artifact' ? f : f, null, 2)));
  };
  const tester = (re, err) => {
    const ta = $('[data-test]', root); if (!ta) return;
    const sample = ta.value; ctx.setSample?.(sample);
    const out = $('[data-live="rxout"]', root), cnt = $('[data-live="rxcount"]', root);
    if (!sample) { out.innerHTML = '<div class="muted small">输入测试文字后显示结果。</div>'; cnt.textContent = ''; return; }
    if (err || !re) { out.innerHTML = `<div class="bad small">${esc(err || '查找内容为空')}</div>`; cnt.textContent = ''; return; }
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let html = '', last = 0, n = 0, m;
    while ((m = g.exec(sample)) && n < 500) { html += esc(sample.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>'; last = m.index + m[0].length; n++; if (!m[0].length) g.lastIndex++; }
    html += esc(sample.slice(last));
    cnt.textContent = n ? '匹配 ' + n + ' 处' : '没有匹配';
    let result = '';
    const rep = String(ed.form.replaceString ?? '').replace(/\{\{match\}\}/gi, '$$&');
    if (n) {
      if (isPage(ed.form.replaceString)) result = '<div class="muted small">匹配到的文字会被替换成 HTML 页面，点上方“预览页面”查看。</div>';
      else { try { result = `<div class="test-res"><div class="muted small">替换后</div><pre class="code">${esc(sample.replace(re, rep))}</pre></div>`; } catch (e) { result = `<div class="bad small">${esc(e.message)}</div>`; } }
    }
    out.innerHTML = `<div class="test-hl"><div class="muted small">匹配位置</div><pre class="code">${html}</pre></div>${result}`;
  };
  const syntax = debounce(async code => {
    const el = $('[data-live="syntax"]', root); if (!el) return;
    const r = await ctx.syntax(code);
    el.innerHTML = r.ok ? `<span class="good">${icon('checkCircle')}语法正确</span>` : `<button class="btn xs danger-ghost" data-goto="${r.line || 1}">${icon('xCircle')}第 ${r.line ?? '?'} 行：${esc(r.message)}</button>`;
  }, 400);
  const jsonCheck = text => {
    const el = $('[data-live="jsonok"]', root); if (!el || !ed.data.json) return;
    try { JSON.parse(text); el.innerHTML = `<span class="good">${icon('checkCircle')}JSON 有效</span>`; } catch (e) { el.innerHTML = `<span class="bad">${icon('xCircle')}${esc(e.message)}</span>`; }
  };

  // CodeMirror
  for (const host of $$('[data-cm]', root)) {
    const key = host.dataset.cm;
    const doc = String(getPath(ed.form, key) ?? '');
    const cm = createEditor({
      parent: host, doc, lang: host.dataset.lang, wrap: !('nowrap' in host.dataset), hint: host.dataset.hint || '',
      onChange: text => { setPath(ed.form, key, text); if (host.dataset.lang === 'js') syntax(text); if (key === 'text') jsonCheck(text); changed(); },
      onSave: () => ctx.save(),
    });
    cm.lang = host.dataset.lang;
    cms.set(key, cm);
    // 按内容调整高度（仍可拖动右下角改变）
    if (host.dataset.autoh) {
      const [min, max] = host.dataset.autoh.split(',').map(Number);
      requestAnimationFrame(() => requestAnimationFrame(() => { host.style.height = Math.max(min, Math.min(max, Math.ceil(cm.view.contentHeight) + 26)) + 'px'; }));
    }
    if (host.dataset.lang === 'js') syntax(doc);
    if (key === 'text') jsonCheck(doc);
  }
  ed.cms = cms;

  const readVal = el => {
    const t = el.dataset.type;
    if (t === 'bool') return el.checked;
    if (t === 'boolnot') return !el.checked;
    if (t === 'num') return el.value === '' ? 0 : Number(el.value);
    if (t === 'numnull') return el.value === '' ? null : Number(el.value);
    if (t === 'tri') return el.value === '' ? null : el.value === 'true';
    return el.value;
  };
  const rerenderList = p => { const box = $(`[data-list="${p}"]`, root); if (box) box.innerHTML = listInner(p, ed); };
  const onInput = e => {
    const el = e.target;
    if (el.matches('[data-test]')) { live(); return; }
    const b = el.dataset.bind;
    if (!b) return;
    setPath(ed.form, b, readVal(el));
    // 原版资源规则换了类型：目标字段跟着换
    let m;
    if ((m = /^overrides\.(\d+)\.kind$/.exec(b))) {
      const r = ed.form.overrides[Number(m[1])];
      r.target = r.kind === 'worldbook' ? { worldbook: '', uid: '', name: '' } : r.kind === 'script' ? { scope: 'character', id: '', name: '' } : { scope: 'character', id: '', name: '' };
      rerenderList('overrides');
    }
    if ((m = /^dependencies\.(\d+)\.project_id$/.exec(b))) { const span = el.closest('.list-row')?.querySelector('.dep-name'); if (span) span.textContent = ed.names?.[el.value.trim()] || ''; }
    changed();
  };
  root.addEventListener('input', onInput);
  root.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.edWrap) { cms.get(el.dataset.edWrap)?.setWrap(el.checked); return; }
    if (el.dataset.arr) {
      const cur = new Set((getPath(ed.form, el.dataset.arr) || []).map(Number));
      if (el.checked) cur.add(Number(el.dataset.v)); else cur.delete(Number(el.dataset.v));
      setPath(ed.form, el.dataset.arr, [...cur].sort((a, b) => a - b));
      changed(); return;
    }
    if (el.dataset.bind && (el.tagName === 'SELECT' || el.type === 'checkbox')) onInput(e);
  });
  // 标签输入
  const renderChips = box => { const list = getPath(ed.form, box.dataset.chips) || []; $$('.chip', box).forEach(c => c.remove()); box.insertAdjacentHTML('afterbegin', chipItems(list)); };
  const addChips = (box, text) => {
    const parts = String(text).split(/[,，、\n]/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) return false;
    const list = (getPath(ed.form, box.dataset.chips) || []).slice();
    for (const p of parts) if (!list.includes(p)) list.push(p);
    setPath(ed.form, box.dataset.chips, list); renderChips(box); changed();
    return true;
  };
  root.addEventListener('keydown', e => {
    const inp = e.target.closest('.chip-in'); if (!inp) return;
    const box = inp.closest('[data-chips]');
    if ((e.key === 'Enter' || e.key === ',' || e.key === '，' || e.key === 'Tab') && inp.value.trim()) { e.preventDefault(); addChips(box, inp.value); inp.value = ''; }
    else if (e.key === 'Backspace' && !inp.value) { const list = (getPath(ed.form, box.dataset.chips) || []).slice(); if (list.length) { list.pop(); setPath(ed.form, box.dataset.chips, list); renderChips(box); changed(); } }
  });
  root.addEventListener('paste', e => {
    const inp = e.target.closest('.chip-in'); if (!inp) return;
    const t = e.clipboardData.getData('text');
    if (/[,，、\n]/.test(t)) { e.preventDefault(); addChips(inp.closest('[data-chips]'), inp.value + t); inp.value = ''; }
  });
  root.addEventListener('focusout', e => { const inp = e.target.closest?.('.chip-in'); if (inp && inp.value.trim()) { addChips(inp.closest('[data-chips]'), inp.value); inp.value = ''; } });
  root.addEventListener('click', e => {
    const del = e.target.closest('[data-chip-del]');
    if (del) { const box = del.closest('[data-chips]'); const list = (getPath(ed.form, box.dataset.chips) || []).slice(); list.splice(Number(del.dataset.chipDel), 1); setPath(ed.form, box.dataset.chips, list); renderChips(box); changed(); return; }
    if (e.target.closest('.chips') && !e.target.closest('button')) { e.target.closest('.chips').querySelector('.chip-in')?.focus(); }
    const seg = e.target.closest('[data-seg] button');
    if (seg) {
      const k = seg.parentElement.dataset.seg, v = seg.dataset.v;
      $$('button', seg.parentElement).forEach(b => b.classList.toggle('on', b === seg));
      if (k === 'scope') { ed.form.markdownOnly = v === 'display'; ed.form.promptOnly = v === 'prompt'; }
      if (k === 'artscope') ed.form.scope = v;
      changed(); return;
    }
    const la = e.target.closest('[data-list-add]');
    if (la) { const p = la.dataset.listAdd, list = (getPath(ed.form, p) || []).slice(); list.push(LISTS[p].add(ed)); setPath(ed.form, p, list); rerenderList(p); changed(); $$('input,select', $(`[data-list="${p}"]`, root)).filter(x => x.closest('.list-row')).at(-1)?.focus(); return; }
    const ld = e.target.closest('[data-list-del]');
    if (ld) { const p = ld.dataset.listDel, list = (getPath(ed.form, p) || []).slice(); list.splice(Number(ld.dataset.i), 1); setPath(ed.form, p, list); rerenderList(p); changed(); return; }
    const g = e.target.closest('[data-goto]');
    if (g) { const cm = cms.get('content') || cms.get('text'); cm?.gotoLine(Number(g.dataset.goto)); return; }
    const a = e.target.closest('[data-ed]');
    if (!a) return;
    const act = a.dataset.ed;
    if (act === 'find') { const cm = cms.get('content') || cms.get('replaceString') || cms.get('text'); cm?.search(); return; }
    ctx.action(act, a);
  });
  refresh();
  return () => { for (const cm of cms.values()) cm.destroy(); cms.clear(); };
}

// 由详情生成编辑用的表单数据
export function makeEd(path, a, key, detail) {
  if (detail.type === 'artifact') {
    const form = { name: detail.name, scope: detail.scope, conflicts: clone(detail.conflicts || []) };
    return { type: 'artifact', path, a, key: null, data: detail, form, orig: clone(form), dirty: false };
  }
  let type, form;
  if (detail.whole) { type = 'raw'; form = { text: detail.text }; }
  else if (detail.textOnly) { type = 'scriptText'; form = { text: detail.text }; }
  else { type = { worldbook: 'entry', regex: 'regex', script: 'script' }[detail.kind] || 'raw'; form = clone(detail.value); if (type === 'raw') form = { text: detail.text }; }
  if (type === 'entry') { if (!Array.isArray(form.key)) form.key = []; if (!Array.isArray(form.keysecondary)) form.keysecondary = []; }
  if (type === 'regex') { if (!Array.isArray(form.placement)) form.placement = []; if (!Array.isArray(form.trimStrings)) form.trimStrings = []; }
  if (type === 'script' && !isObj(form.button)) form.button = { enabled: true, buttons: [] };
  if (type === 'script' && !Array.isArray(form.button.buttons)) form.button.buttons = [];
  return { type, path, a, key, data: detail, form, orig: clone(form), dirty: false };
}
// 生成保存用的编辑操作
export function editOp(ed) {
  if (ed.type === 'artifact') {
    const conflicts = (ed.form.conflicts || []).map(c => {
      const t = { ...c.target };
      for (const k of Object.keys(t)) if (t[k] === '' || t[k] == null) delete t[k];
      if (t.uid != null && /^\d+$/.test(String(t.uid))) t.uid = String(t.uid);
      return { action: c.action, target: t };
    });
    return { op: 'artifactMeta', a: ed.a, meta: { name: ed.form.name, scope: ed.form.scope, conflicts } };
  }
  if (ed.type === 'raw') {
    let value = ed.form.text;
    if (ed.data.json) { try { value = JSON.parse(ed.form.text); } catch (e) { throw new Error('JSON 格式不正确：' + e.message); } }
    return { op: 'item', a: ed.a, key: ed.key, value };
  }
  if (ed.type === 'scriptText') return { op: 'item', a: ed.a, key: ed.key, value: ed.form.text };
  let value = clone(ed.form);
  if (ed.type === 'script' && Array.isArray(value.button?.buttons)) value.button.buttons = value.button.buttons.filter(b => String(b?.name || '').trim());
  if (ed.type === 'entry') value = syncEntry(value);
  return { op: 'item', a: ed.a, key: ed.key, value };
}
// 与主进程一致：世界书条目里与顶层字段重复的 extensions 字段保持同步
const EXT_MIRROR = [['position', 'position'], ['depth', 'depth'], ['role', 'role'], ['probability', 'probability'], ['useProbability', 'useProbability'], ['selectiveLogic', 'selectiveLogic'],
  ['excludeRecursion', 'exclude_recursion'], ['preventRecursion', 'prevent_recursion'], ['delayUntilRecursion', 'delay_until_recursion'], ['scanDepth', 'scan_depth'], ['caseSensitive', 'case_sensitive'],
  ['matchWholeWords', 'match_whole_words'], ['group', 'group'], ['groupOverride', 'group_override'], ['groupWeight', 'group_weight'], ['useGroupScoring', 'use_group_scoring'], ['sticky', 'sticky'],
  ['cooldown', 'cooldown'], ['delay', 'delay'], ['automationId', 'automation_id'], ['outletName', 'outlet_name'], ['vectorized', 'vectorized'], ['ignoreBudget', 'ignore_budget'], ['displayIndex', 'display_index']];
export function syncEntry(e) {
  if (!isObj(e) || !isObj(e.extensions)) return e;
  const ext = { ...e.extensions };
  for (const [a, b] of EXT_MIRROR) if (a in e && b in ext) ext[b] = clone(e[a]);
  return { ...e, extensions: ext };
}
