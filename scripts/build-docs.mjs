// 把编写教程与 Markdown 渲染器放进界面目录，程序内离线查看（只有 docs/扩展编写教程.md 一份源文件）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'renderer', 'vendor');
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'docs', '扩展编写教程.md'), path.join(OUT, 'tutorial.md'));
await build({
  stdin: { contents: "export { marked } from 'marked';", resolveDir: ROOT, loader: 'js' },
  bundle: true, format: 'esm', minify: true, target: 'chrome130', outfile: path.join(OUT, 'marked.js'), logLevel: 'warning',
});
console.log('编写教程已放入 ' + path.relative(ROOT, OUT));
