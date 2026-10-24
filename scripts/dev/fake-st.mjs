// 开发用：把内置的模拟酒馆当成一个普通的本机 SillyTavern 运行（http://127.0.0.1:端口），用来测试“本机 SillyTavern”模式，
// 不会碰到真正的 SillyTavern。用法：node scripts/dev/fake-st.mjs [端口] [数据文件夹]
// 另外提供 /__rwkit/devfile?p=本机路径，自测时用来读取要导入的角色卡（只监听 127.0.0.1）。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../src/main/sim-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = Number(process.argv[2]) || 18800;
const dataDir = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'rwkit-fake-st-'));
const vendorDir = path.join(ROOT, 'vendor', 'sim');
const versions = JSON.parse(fs.readFileSync(path.join(vendorDir, 'versions.json'), 'utf8'));
const srv = createServer({ vendorDir, dataDir, version: versions, log: m => console.log(m) });

http.createServer(async (req, res) => {
  const url = 'http://127.0.0.1:' + port + req.url;
  if (new URL(url).pathname === '/__rwkit/devfile') {
    try { res.end(fs.readFileSync(new URL(url).searchParams.get('p'))); } catch { res.writeHead(404); res.end(); }
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await srv.handle(new Request(url, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  if (r.body) for await (const c of r.body) res.write(c);
  res.end();
}).listen(port, '127.0.0.1', () => console.log(`fake SillyTavern on http://127.0.0.1:${port}/ (data: ${dataDir})`));
