// 差异显示：逐行比较（Myers 算法），配对的增删行再标出行内差异
import { esc, icon, KIND } from './util.js';

function myers(a, b) {
  const n = a.length, m = b.length, max = n + m, off = max + 1, v = new Int32Array(2 * max + 3), trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > 2500) return null;
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1, y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) {
        const out = []; let X = n, Y = m;
        for (let D = d; D >= 0; D--) {
          const t = trace[D], g = kk => t[kk + D + 1], K = X - Y;
          const pk = (K === -D || (K !== D && g(K - 1) < g(K + 1))) ? K + 1 : K - 1, px = g(pk), py = px - pk;
          while (X > px && Y > py) { out.push(['=', a[X - 1]]); X--; Y--; }
          if (D > 0) { if (X === px) out.push(['+', b[Y - 1]]); else out.push(['-', a[X - 1]]); }
          X = px; Y = py;
        }
        return out.reverse();
      }
    }
  }
  return null;
}
function diffLines(A, B) {
  const a = A.split('\n'), b = B.split('\n');
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length; while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const mid = myers(a.slice(s, ea), b.slice(s, eb));
  if (!mid) return null;
  return [...a.slice(0, s).map(l => ['=', l]), ...mid, ...a.slice(ea).map(l => ['=', l])];
}
function inline(x, y) {
  let p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let sx = x.length, sy = y.length; while (sx > p && sy > p && x[sx - 1] === y[sy - 1]) { sx--; sy--; }
  const fix = (str, i) => (i > 0 && i < str.length && /[\uDC00-\uDFFF]/.test(str[i]) ? i - 1 : i);
  p = Math.min(fix(x, p), fix(y, p));
  const wrap = (str, a, b) => esc(str.slice(0, a)) + (b > a ? '<mark>' + esc(str.slice(a, b)) + '</mark>' : '') + esc(str.slice(b));
  return [wrap(x, p, sx), wrap(y, p, sy)];
}
export function textDiff(A, B) {
  const ops = diffLines(A, B);
  if (!ops) return `<div class="dskip">差异太大，无法逐行比较（原来 ${A.length} 字，现在 ${B.length} 字）</div>`;
  const html = ops.map(o => esc(o[1]));
  for (let i = 0; i < ops.length;) {
    if (ops[i][0] !== '-') { i++; continue; }
    let j = i; while (j < ops.length && ops[j][0] === '-') j++;
    let k = j; while (k < ops.length && ops[k][0] === '+') k++;
    const pairs = Math.min(j - i, k - j);
    for (let q = 0; q < pairs; q++) { const [x, y] = inline(ops[i + q][1], ops[j + q][1]); html[i + q] = x; html[j + q] = y; }
    i = k;
  }
  const show = new Uint8Array(ops.length);
  ops.forEach((o, i) => { if (o[0] !== '=') for (let j = Math.max(0, i - 3); j <= Math.min(ops.length - 1, i + 3); j++) show[j] = 1; });
  let h = '', skip = 0;
  ops.forEach((o, i) => {
    if (!show[i]) { skip++; return; }
    if (skip) { h += `<div class="dskip">⋯ ${skip} 行相同</div>`; skip = 0; }
    h += `<div class="dl${o[0] === '+' ? ' add' : o[0] === '-' ? ' del' : ''}">${html[i] || ' '}</div>`;
  });
  if (skip) h += `<div class="dskip">⋯ ${skip} 行相同</div>`;
  return h || '<div class="dskip">文本没有变化</div>';
}
const SIGN = { added: '+', removed: '−', changed: '~' };
const STXT = { added: '新增', removed: '删除', changed: '修改', same: '无变化' };
export function ftable(list) { return `<table class="ftable"><tr><th style="width:170px">字段</th><th>原来</th><th>现在</th></tr>${list.map(f => `<tr><td class="mono">${esc(f.name)}</td><td class="a mono">${esc(f.a)}</td><td class="b mono">${esc(f.b)}</td></tr>`).join('')}</table>`; }
// open: 已展开的项（Set），canJump: 能否跳到编辑页
export function diffHtml(d, dkey, open, canJump) {
  const changed = d.artifacts.filter(a => a.status !== 'same'), same = d.artifacts.filter(a => a.status === 'same');
  if (!d.project.length && !d.overrides && !changed.length) return `<div class="banner ok">${icon('checkCircle')}<div class="bb"><div class="bt">内容完全相同</div><div class="bs">除版本号外，两者的项目资料与全部内容都一致。</div></div></div>`;
  const cnt = { added: 0, removed: 0, changed: 0 };
  for (const a of changed) for (const it of a.items) cnt[it.status]++;
  let h = `<div class="dsum"><span class="pill acc">${changed.length} 个 artifact 有变化</span>${cnt.changed ? `<span class="pill warn">~ ${cnt.changed} 处修改</span>` : ''}${cnt.added ? `<span class="pill ok">+ ${cnt.added} 处新增</span>` : ''}${cnt.removed ? `<span class="pill error">− ${cnt.removed} 处删除</span>` : ''}${d.project.length ? '<span class="pill plain">项目资料有改动</span>' : ''}${d.overrides ? '<span class="pill plain">原版资源规则有改动</span>' : ''}</div>`;
  if (d.project.length) h += `<div class="dart"><div class="dart-h"><span class="nm">项目资料</span></div>${ftable(d.project)}</div>`;
  if (d.overrides) h += `<div class="dart"><div class="dart-h"><span class="nm">原版资源规则</span><span class="muted">${d.overrides.a} 条 → ${d.overrides.b} 条</span></div></div>`;
  changed.forEach((a, ai) => {
    h += `<div class="dart"><div class="dart-h"><span class="sign ${a.status}">${SIGN[a.status] || '~'}</span><span class="kind ${a.kind}">${esc(KIND[a.kind] || a.kind)}</span><span class="nm">${esc(a.name)}</span><span class="muted">${STXT[a.status]}${a.items.length ? ' · ' + a.items.length + ' 项' : ''}</span></div>`;
    if (a.meta?.length) h += ftable(a.meta);
    a.items.forEach((it, ii) => {
      const k = dkey + '|' + ai + '|' + ii, hasText = it.textChanged || (it.status !== 'changed' && (it.aText || it.bText));
      const can = hasText || it.fields?.length, isOpen = open.has(k);
      const jump = canJump && it.status !== 'removed' && a.bi != null && it.key != null ? `<button class="btn xs ghost" data-act="jump" data-a="${a.bi}" data-key="${esc(it.key)}" title="到编辑页修改这一项">${icon('pencil')}编辑</button>` : '';
      h += `<div class="ditem"><div class="ditem-h${can ? ' click' : ''}" ${can ? `data-act="dopen" data-k="${esc(k)}"` : ''}><span class="sign ${it.status}">${SIGN[it.status]}</span><span class="dl-label">${esc(it.label || '（无名称）')}</span>
        <span class="fchips">${it.textChanged ? '<span class="fchip">正文</span>' : ''}${(it.fields || []).slice(0, 6).map(f => `<span class="fchip">${esc(f.name)}</span>`).join('')}${(it.fields || []).length > 6 ? `<span class="fchip">+${it.fields.length - 6}</span>` : ''}</span>${jump}${can ? icon(isOpen ? 'chevDown' : 'chevRight', 'xs muted') : ''}</div>`;
      if (isOpen && can) h += `<div class="dbody">${it.fields?.length ? ftable(it.fields) : ''}${hasText ? textDiff(it.status === 'added' ? '' : it.aText || '', it.status === 'removed' ? '' : it.bText || '') : ''}</div>`;
      h += '</div>';
    });
    h += '</div>';
  });
  if (same.length) h += `<div class="same-line">无变化：${same.map(a => esc(a.name)).join('、')}</div>`;
  return h;
}
