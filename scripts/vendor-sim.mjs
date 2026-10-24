// 准备“模拟酒馆”的运行文件：官方 SillyTavern 前端 + 官方酒馆助手，放在 vendor/sim/（打包时一起带上）
// 用法：node scripts/vendor-sim.mjs [--force] [--lib <已编译的 lib.js>]
//   --lib：直接使用同一版本 SillyTavern 启动时编译好的 lib.js（在它的 data/_webpack/*/output/ 里），不再安装依赖与编译
//   下载 SillyTavern 与酒馆助手的发布版本 → 在缓存文件夹里安装 SillyTavern 的依赖并用它自己的 webpack 配置编译 lib.js
//   → 只复制前端需要的文件。下载与依赖缓存在 vendor/.cache/，再次运行会复用。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ST_VERSION = '1.19.0';
export const TH_VERSION = '4.11.3';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'vendor', '.cache');
const OUT = path.join(ROOT, 'vendor', 'sim');
const force = process.argv.includes('--force');
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const prebuilt = arg('--lib');

const say = msg => console.log('[vendor-sim] ' + msg);
function run(cmd, args, cwd) {
  say(`${cmd} ${args.join(' ')}`);
  // npm 在 Windows 上是 npm.cmd，需要经过命令行解释器；其他命令直接运行
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' });
  if (r.status !== 0) throw new Error(`${cmd} 失败（${r.status}）`);
}
async function download(url, file) {
  if (fs.existsSync(file) && !force) return file;
  say('下载 ' + url);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`下载失败 ${r.status}：${url}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.part', Buffer.from(await r.arrayBuffer()));
  fs.renameSync(file + '.part', file);
  return file;
}
// GitHub 的源码压缩包解开后只有一层文件夹
function extract(zip, dir) {
  if (fs.existsSync(dir) && !force) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  const tmp = dir + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  // Windows 自带的 tar（bsdtar）能解 zip；Git Bash 里的 GNU tar 会把“E:”当成远程主机
  const winTar = process.platform === 'win32' && path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  run(winTar && fs.existsSync(winTar) ? winTar : 'tar', ['-xf', zip, '-C', tmp], ROOT);
  const [top] = fs.readdirSync(tmp);
  fs.renameSync(path.join(tmp, top), dir);
  fs.rmSync(tmp, { recursive: true, force: true });
  return dir;
}
const copy = (from, to, filter) => fs.cpSync(from, to, { recursive: true, filter: filter || (() => true) });

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  // ---------- SillyTavern ----------
  const stZip = await download(`https://codeload.github.com/SillyTavern/SillyTavern/zip/refs/tags/${ST_VERSION}`, path.join(CACHE, `SillyTavern-${ST_VERSION}.zip`));
  const st = extract(stZip, path.join(CACHE, `SillyTavern-${ST_VERSION}`));
  const lib = prebuilt ? { dir: path.dirname(path.resolve(prebuilt)), file: path.basename(prebuilt) } : buildLib(st);
  if (!fs.existsSync(path.join(lib.dir, lib.file))) throw new Error('找不到 ' + path.join(lib.dir, lib.file));
  await vendor(st, lib);
}
function buildLib(st) {
  if (!fs.existsSync(path.join(st, 'node_modules', 'webpack'))) run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], st);
  // 与 SillyTavern 启动时相同：用它的 webpack 配置把前端用到的库打包成 /lib.js
  const builder = path.join(st, '.rwkit-build-lib.mjs');
  fs.writeFileSync(builder, `import webpack from 'webpack';
import getConfig from './webpack.config.js';
const config = getConfig({ forceDist: true });
const stats = await new Promise((res, rej) => webpack(config).run((e, s) => (e ? rej(e) : res(s))));
if (stats.hasErrors()) { console.error(stats.toString('errors-only')); process.exit(1); }
console.log(JSON.stringify({ dir: config.output.path, file: config.output.filename }));
`);
  const r = spawnSync(process.execPath, [builder], { cwd: st, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('编译 lib.js 失败：\n' + r.stderr + r.stdout);
  say('lib.js 编译完成');
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

async function vendor(st, lib) {
  // ---------- 酒馆助手 ----------
  const thZip = await download(`https://codeload.github.com/N0VI028/JS-Slash-Runner/zip/refs/tags/${TH_VERSION}`, path.join(CACHE, `JS-Slash-Runner-${TH_VERSION}.zip`));
  const th = extract(thZip, path.join(CACHE, `JS-Slash-Runner-${TH_VERSION}`));

  // ---------- 输出 ----------
  fs.rmSync(OUT, { recursive: true, force: true });
  const out = p => path.join(OUT, p);
  // 前端：public/ 原样复制（第三方扩展文件夹除外）
  copy(path.join(st, 'public'), out('st/public'), src => !/[\\/]scripts[\\/]extensions[\\/]third-party[\\/]./.test(src));
  fs.copyFileSync(path.join(lib.dir, lib.file), out('st/lib.js'));
  if (fs.existsSync(path.join(lib.dir, lib.file + '.LICENSE.txt'))) fs.copyFileSync(path.join(lib.dir, lib.file + '.LICENSE.txt'), out('st/lib.js.LICENSE.txt'));
  // 默认内容：设置、主题、提示词模板（不含示例角色、背景图、工作流与其他后端的预设）
  const keep = new Set(['settings', 'theme', 'openai_preset', 'context', 'instruct', 'sysprompt', 'reasoning', 'avatar', 'moving_ui', 'quick_replies']);
  const index = JSON.parse(fs.readFileSync(path.join(st, 'default/content/index.json'), 'utf8')).filter(x => keep.has(x.type));
  for (const x of index) { fs.mkdirSync(path.dirname(out('st/default/' + x.filename)), { recursive: true }); fs.copyFileSync(path.join(st, 'default/content', x.filename), out('st/default/' + x.filename)); }
  fs.writeFileSync(out('st/default/index.json'), JSON.stringify(index, null, 2));
  fs.copyFileSync(path.join(st, 'LICENSE'), out('st/LICENSE'));
  // 酒馆助手：运行只需要清单、dist、lib 与 i18n
  for (const p of ['manifest.json', 'LICENSE', 'dist/index.js', 'dist/index.css', 'lib', 'i18n']) copy(path.join(th, p), out('th/' + p));
  fs.writeFileSync(out('versions.json'), JSON.stringify({ sillytavern: ST_VERSION, tavernHelper: TH_VERSION, built: new Date().toISOString() }, null, 2));
  fs.writeFileSync(out('NOTICE.txt'), `rwkit 模拟酒馆使用以下第三方软件（未经修改），均以各自的许可证发布：

SillyTavern ${ST_VERSION}
  许可证：GNU AGPL v3（见 st/LICENSE）
  源代码：https://github.com/SillyTavern/SillyTavern/tree/${ST_VERSION}
  st/lib.js 由该版本的 webpack 配置从其依赖编译而成，依赖的许可证见 st/lib.js.LICENSE.txt。

酒馆助手（JS-Slash-Runner）${TH_VERSION}
  许可证：PolyForm Noncommercial 1.0.0（见 th/LICENSE），仅限非商业用途
  源代码：https://github.com/N0VI028/JS-Slash-Runner/tree/${TH_VERSION}
`);
  const size = dir => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
  say(`完成：${OUT}（${(size(OUT) / 1048576).toFixed(1)} MB）`);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e); process.exit(1); });
