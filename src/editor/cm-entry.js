// CodeMirror 6 打包入口：由 esbuild 打成 src/renderer/vendor/cm.js，界面通过 createEditor 使用
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, placeholder } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, search, openSearchPanel } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { syntaxHighlighting, HighlightStyle, bracketMatching, foldGutter, foldKeymap, indentOnInput, StreamLanguage } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';

// 世界书正文：EJS 代码块、<标签>、{{宏}}、行首“键:”与 Markdown 标题
const worldbook = StreamLanguage.define({
  name: 'worldbook',
  startState: () => ({ ejs: false }),
  token(stream, st) {
    if (st.ejs) {
      if (stream.skipTo('%>')) { stream.match(/%>/); st.ejs = false; } else stream.skipToEnd();
      return 'processingInstruction';
    }
    if (stream.match(/<%[_=-]?/)) { st.ejs = true; return 'processingInstruction'; }
    if (stream.match(/\{\{[^{}]*\}\}/)) return 'macroName';
    if (stream.match(/<\/?[^\s<>%!][^<>\n]{0,40}?>/)) return 'tagName';
    if (stream.sol() && stream.match(/#{1,6}\s.*/)) return 'heading';
    if (stream.sol() && stream.match(/\s*(?:-\s+)?[^\s:：<>{}\-][^:：<>{}\n]{0,24}[:：](?=\s|$)/)) return 'propertyName';
    stream.next();
    return null;
  },
});

const style = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--cm-keyword)' },
  { tag: [t.string, t.special(t.string), t.attributeValue], color: 'var(--cm-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--cm-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--cm-tag)' },
  { tag: t.attributeName, color: 'var(--cm-attr)' },
  { tag: t.propertyName, color: 'var(--cm-prop)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--cm-fn)' },
  { tag: t.definition(t.variableName), color: 'var(--cm-def)' },
  { tag: [t.typeName, t.className], color: 'var(--cm-type)' },
  { tag: t.regexp, color: 'var(--cm-regexp)' },
  { tag: t.processingInstruction, color: 'var(--cm-ejs)', backgroundColor: 'var(--cm-ejs-bg)' },
  { tag: t.macroName, color: 'var(--cm-macro)', fontWeight: '600' },
  { tag: t.heading, color: 'var(--cm-heading)', fontWeight: '700' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--cm-punct)' },
  { tag: t.invalid, color: 'var(--err)' },
]);

const theme = EditorView.theme({
  '&': { fontSize: '13px', height: '100%', backgroundColor: 'var(--cm-bg)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.65' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '10px 0' },
  '.cm-line': { padding: '0 14px 0 8px' },
  '.cm-gutters': { backgroundColor: 'var(--cm-gutter)', color: 'var(--muted)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '34px', fontSize: '12px' },
  '.cm-activeLine': { backgroundColor: 'var(--cm-active)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--cm-active)', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--cm-sel) !important' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-searchMatch': { backgroundColor: 'var(--cm-match)', outline: '1px solid var(--cm-match-line)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--cm-match-cur)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--cm-selmatch)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--cm-match)', outline: 'none' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--sunken)', border: 'none', color: 'var(--muted)', padding: '0 6px', borderRadius: '4px' },
  '.cm-panels': { backgroundColor: 'var(--panel2)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '8px 10px', fontFamily: 'var(--font)', fontSize: '12.5px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: 'var(--font)', fontSize: '12.5px' },
  '.cm-textfield': { border: '1px solid var(--border2)', borderRadius: '6px', background: 'var(--panel)', color: 'var(--text)', padding: '3px 7px' },
  '.cm-button': { backgroundImage: 'none', background: 'var(--panel)', border: '1px solid var(--border2)', borderRadius: '6px', color: 'var(--text)', padding: '3px 9px' },
  '.cm-placeholder': { color: 'var(--muted)', fontStyle: 'italic' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--border)', borderRadius: '8px' },
});

const phrases = EditorState.phrases.of({
  'Find': '查找', 'Replace': '替换', 'next': '下一个', 'previous': '上一个', 'all': '全部', 'match case': '区分大小写',
  'regexp': '正则', 'by word': '全词匹配', 'replace': '替换', 'replace all': '全部替换', 'close': '关闭',
  'Go to line': '跳到行', 'go': '跳转', 'Folded lines': '已折叠', 'Unfolded lines': '已展开', 'to': '到',
  'folded code': '已折叠的代码', 'unfold': '展开', 'Fold line': '折叠', 'Unfold line': '展开',
  'current match': '当前匹配', 'on line': '第几行', 'replaced match on line $': '已替换第 $ 行的匹配', 'replaced $ matches': '已替换 $ 处',
});

const LANGS = { js: () => javascript(), html: () => html({ autoCloseTags: false }), json: () => json(), worldbook: () => worldbook, text: () => [] };

export function createEditor({ parent, doc = '', lang = 'text', wrap = true, readOnly = false, onChange, onSave, hint = '' }) {
  const langC = new Compartment(), wrapC = new Compartment(), roC = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
        EditorState.allowMultipleSelections.of(true), indentOnInput(), syntaxHighlighting(style), bracketMatching(), closeBrackets(),
        rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(), search({ top: true }),
        keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { onSave?.(); return true; } }, indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap]),
        langC.of((LANGS[lang] || LANGS.text)()), wrapC.of(wrap ? EditorView.lineWrapping : []), roC.of(EditorState.readOnly.of(readOnly)),
        hint ? placeholder(hint) : [],
        theme, phrases,
        EditorView.updateListener.of(u => { if (u.docChanged) onChange?.(u.state.doc.toString()); }),
      ],
    }),
  });
  return {
    view,
    get: () => view.state.doc.toString(),
    setLang: l => view.dispatch({ effects: langC.reconfigure((LANGS[l] || LANGS.text)()) }),
    setWrap: w => view.dispatch({ effects: wrapC.reconfigure(w ? EditorView.lineWrapping : []) }),
    focus: () => view.focus(),
    search: () => openSearchPanel(view),
    gotoLine(n) {
      const line = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines)));
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
      view.focus();
    },
    destroy: () => view.destroy(),
  };
}
