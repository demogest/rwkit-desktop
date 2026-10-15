// 检查更新：版本比较、按安装方式挑选下载文件、下载时按 GitHub 提供的 SHA-256 校验
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as updater from '../src/main/updater.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rwkit-up-test-'));
const payload = crypto.randomBytes(300_000);
const sha = crypto.createHash('sha256').update(payload).digest('hex');
let served = payload, apiStatus = 200, noDigest = false;
const release = () => ({
  tag_name: 'v1.2.0', name: 'rwkit 离线包工具 v1.2.0', body: '## 新功能\n- 安装到 SillyTavern', html_url: 'https://github.com/demogest/rwkit-desktop/releases/tag/v1.2.0', published_at: '2026-10-20T00:00:00Z',
  assets: [
    { name: 'rwkit-desktop-1.2.0-setup.exe', size: payload.length, digest: 'sha256:' + sha, browser_download_url: 'https://example.test/setup.exe' },
    { name: 'rwkit-desktop-1.2.0-portable.exe', size: payload.length, digest: noDigest ? null : 'sha256:' + sha, browser_download_url: 'https://example.test/portable.exe' },
  ],
});
async function fakeFetch(url) {
  if (url.includes('api.github')) return apiStatus === 200 ? new Response(JSON.stringify(release()), { headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: apiStatus });
  return new Response(served, { headers: { 'content-length': String(served.length) } });
}
updater.init({ version: '1.1.0', kind: 'portable', dataDir: tmp, downloadDir: path.join(tmp, 'dl'), fetch: fakeFetch, api: 'https://api.github.test/repos/x/releases/latest' });

test('版本比较', () => {
  assert.equal(updater.compareVersions('1.10.0', '1.9.3'), 1);
  assert.equal(updater.compareVersions('v1.1.0', '1.1.0'), 0);
  assert.equal(updater.compareVersions('1.1.0', '1.2.0'), -1);
  assert.equal(updater.compareVersions('1.2.0', '1.2.0-beta.1'), 1);
});

test('检查更新：发现新版本，免安装版挑选 portable 文件', async () => {
  const st = await updater.handle('up.check');
  assert.equal(st.newer, true);
  assert.equal(st.latest.version, '1.2.0');
  assert.equal(st.latest.asset.name, 'rwkit-desktop-1.2.0-portable.exe');
  assert.equal(st.latest.asset.sha256, sha);
  assert.ok(st.lastCheck > 0);
});

test('自动检查：刚查过就不再查', async () => {
  const st = await updater.handle('up.auto');
  assert.equal(st.skipped, true);
});

test('下载：校验通过后放到下载位置', async () => {
  const st = await updater.handle('up.download');
  assert.equal(st.download.state, 'done', st.error);
  assert.equal(path.basename(st.download.file), 'rwkit-desktop-1.2.0-portable.exe');
  assert.ok(fs.readFileSync(st.download.file).equals(payload));
  assert.equal(updater.downloadedFile(), st.download.file);
  assert.ok(!fs.existsSync(st.download.file + '.part'));
});

test('下载：内容被篡改时拒绝并删除', async () => {
  served = Buffer.from(payload); served[100] ^= 0xff;
  const r = await updater.handle('up.download');
  served = payload;
  assert.equal(r.ok, false);
  assert.match(r.error, /SHA-256/);
  assert.equal(updater.downloadedFile(), null);
  assert.ok(!fs.existsSync(path.join(tmp, 'dl', 'rwkit-desktop-1.2.0-portable.exe.part')));
});

test('GitHub 没给 SHA-256 的文件不在程序里下载', async () => {
  noDigest = true;
  await updater.handle('up.check');
  const r = await updater.handle('up.download');
  noDigest = false;
  assert.equal(r.ok, false);
  assert.match(r.error, /校验值/);
  await updater.handle('up.check');
});

test('GitHub 限流时给出说明', async () => {
  apiStatus = 403;
  const r = await updater.handle('up.check');
  apiStatus = 200;
  assert.equal(r.ok, false);
  assert.match(r.error, /限制/);
});

test('跳过版本与关闭自动检查会保存', async () => {
  await updater.handle('up.settings', { skip: '1.2.0', auto: false });
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'update.json'), 'utf8'));
  assert.equal(saved.skip, '1.2.0');
  assert.equal(saved.auto, false);
});
