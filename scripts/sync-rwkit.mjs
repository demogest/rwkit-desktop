// 把工具包里最新的 rwkit.mjs 复制到 resources/，作为桌面版内置的版本
//   npm run sync-rwkit -- "<工具包文件夹>"
// 复制前先确认它能被桌面版载入（命令行入口与所需函数都在）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2] || process.env.RWKIT_TOOLKIT;
if (!arg) { console.log('用法：npm run sync-rwkit -- <工具包文件夹或 rwkit.mjs 路径>'); process.exit(1); }
const src = fs.statSync(arg).isDirectory() ? path.join(arg, 'rwkit.mjs') : arg;
const text = fs.readFileSync(src, 'utf8');
const need = ['fixFile', 'unpackFile', 'packDir', 'makeExample', 'loadPack', 'verifyManifest', 'installCheck', 'lint', 'buildFromDir', 'validateBundle', 'rebuildManifest', 'PackError', 'safeName', 'MAX_OFFLINE_BYTES'];
const editing = ['writePack', 'writeSource', 'freeDir', 'parseLoose', 'entryText', 'Writer', 'artifactContent', 'escapeLiterals'];
const has = n => new RegExp('^(?:async\\s+)?(?:function|class|const|let)\\s+' + n + '\\b', 'm').test(text);
if (!/^process\.exitCode\s*=\s*main\(process\.argv\.slice\(2\)\);?[ \t]*$/m.test(text)) { console.log('✗ 找不到命令行入口，桌面版无法载入这个 rwkit.mjs'); process.exit(1); }
const missing = need.filter(n => !has(n));
if (missing.length) { console.log('✗ 缺少 ' + missing.join('、') + '，桌面版无法载入'); process.exit(1); }
const noEdit = editing.filter(n => !has(n));
if (noEdit.length) console.log('⚠ 缺少 ' + noEdit.join('、') + '：检查与打包可用，直接编辑不可用');
const dest = path.join(ROOT, 'resources', 'rwkit.mjs');
const same = fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === text;
if (!same) fs.writeFileSync(dest, text);
console.log(same ? '✓ 内置的 rwkit.mjs 已是最新' : '✓ 已更新内置的 rwkit.mjs ← ' + src);
