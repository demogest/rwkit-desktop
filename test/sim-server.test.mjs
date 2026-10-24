// 模拟酒馆的服务器：用一个很小的假运行文件夹测试接口（不需要真正的 SillyTavern 文件）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, readCardPng, triggersOf } from '../src/main/sim-server.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rwkit-sim-'));
const vendor = path.join(tmp, 'vendor');
const put = (p, data) => { fs.mkdirSync(path.dirname(path.join(vendor, p)), { recursive: true }); fs.writeFileSync(path.join(vendor, p), data); };
put('st/public/index.html', '<!DOCTYPE html><html><head><title>SillyTavern</title></head><body></body></html>');
put('st/public/script.js', 'export const x = 1;');
put('st/public/img/ai4.png', 'png');
put('st/public/scripts/extensions/regex/manifest.json', '{}');
put('st/public/scripts/extensions/tts/manifest.json', '{}');
put('st/lib.js', 'export default {};');
put('st/default/index.json', JSON.stringify([{ filename: 'settings.json', type: 'settings' }, { filename: 'presets/openai/Default.json', type: 'openai_preset' }, { filename: 'user-default.png', type: 'avatar' }, { filename: 'Seraphina/x.png', type: 'character' }]));
put('st/default/settings.json', JSON.stringify({ firstRun: true, username: 'User', extension_settings: { disabledExtensions: [] } }));
put('st/default/presets/openai/Default.json', JSON.stringify({ temperature: 1 }));
put('st/default/user-default.png', 'png');
put('th/manifest.json', JSON.stringify({ display_name: '酒馆助手' }));
const logs = [];
const srv = createServer({ vendorDir: vendor, dataDir: path.join(tmp, 'data'), version: { sillytavern: '1.19.0' }, log: m => logs.push(m) });
const call = (method, p, body) => srv.handle(new Request('rwsim://st' + p, { method, ...(body instanceof FormData ? { body } : body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }));
const post = async (p, body) => (await call('POST', p, body)).json();

// 带角色卡数据的 PNG（只需要文件头与 tEXt 块）
function cardPng(card, key = 'chara') {
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
  const text = Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(Buffer.from(JSON.stringify(card)).toString('base64'), 'latin1')]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.alloc(13)), chunk('tEXt', text), chunk('IEND', Buffer.alloc(0))]);
}
const CARD = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '测试角色', description: '描述', first_mes: '【封面】', extensions: { world: '测试世界', tavern_helper: { scripts: [] } }, character_book: { entries: [{ keys: ['a'], content: 'x' }] } } };
async function importCard(buf, extra = {}) {
  const f = new FormData();
  f.append('avatar', new Blob([buf], { type: 'image/png' }), 'card.png');
  f.append('file_type', 'png');
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  return post('/api/characters/import', f);
}

test('首次启动：生成设置，跳过欢迎向导，关闭与预览无关的内置扩展', async () => {
  const r = await post('/api/settings/get', {});
  const s = JSON.parse(r.settings);
  assert.equal(s.firstRun, false);
  assert.equal(s.power_user.auto_load_chat, true);
  assert.ok(s.extension_settings.disabledExtensions.includes('stable-diffusion'));
  assert.ok(!s.extension_settings.disabledExtensions.includes('regex'));
  assert.deepEqual(r.openai_setting_names, ['Default']);
  assert.equal(r.enable_extensions, true);
  assert.ok(fs.existsSync(path.join(tmp, 'data/default-user/User Avatars/user-default.png')));
  assert.ok(!fs.existsSync(path.join(tmp, 'data/default-user/characters/x.png')), '不带示例角色');
});

test('扩展清单：内置扩展 + 酒馆助手；酒馆助手的文件从运行文件夹读取', async () => {
  const list = await (await call('GET', '/api/extensions/discover')).json();
  assert.deepEqual(list.map(x => x.name).sort(), ['regex', 'third-party/JS-Slash-Runner', 'tts']);
  const m = await (await call('GET', '/scripts/extensions/third-party/JS-Slash-Runner/manifest.json')).json();
  assert.equal(m.display_name, '酒馆助手');
});

test('首页默认简体中文；静态文件不能越出前端文件夹', async () => {
  const html = await (await call('GET', '/')).text();
  assert.match(html, /<head><script>[^<]*localStorage\.setItem\('language','zh-cn'\)/);
  assert.equal((await call('GET', '/script.js')).status, 200);
  assert.equal((await call('GET', '/lib.js')).status, 200);
  assert.equal((await call('GET', '/%2e%2e/%2e%2e/th/manifest.json')).status, 404);
  assert.equal((await call('GET', '/scripts/extensions/third-party/JS-Slash-Runner/..%2f..%2fst%2flib.js')).status, 404);
});

test('导入角色卡：PNG 原样保存、数据放到顶层、同名另起名字、preserved_name 覆盖', async () => {
  const r = await importCard(cardPng(CARD));
  assert.equal(r.file_name, '测试角色');
  const all = await post('/api/characters/all', {});
  assert.equal(all.length, 1);
  const c = all[0];
  assert.equal(c.avatar, '测试角色.png');
  assert.equal(c.name, '测试角色');
  assert.equal(c.first_mes, '【封面】');
  assert.match(c.chat, /^测试角色 - \d{4}-\d\d-\d\d@/);
  assert.equal(c.data.extensions.world, '测试世界');
  assert.equal((await importCard(cardPng(CARD))).file_name, '测试角色1');
  const again = await importCard(cardPng({ ...CARD, data: { ...CARD.data, description: '新描述' } }), { preserved_name: '测试角色.png' });
  assert.equal(again.file_name, '测试角色');
  assert.equal((await post('/api/characters/get', { avatar_url: '测试角色.png' })).description, '新描述');
  assert.equal((await post('/api/characters/get', { avatar_url: '测试角色.png' })).chat, c.chat, '覆盖时保留原来的聊天');
  assert.equal((await call('GET', '/characters/' + encodeURIComponent('测试角色.png'))).status, 200);
  const bad = await importCard(Buffer.from('not png'));
  assert.equal(bad.error, true);
  await post('/api/characters/delete', { avatar_url: '测试角色1.png', delete_chats: true });
  assert.equal((await post('/api/characters/all', {})).length, 1);
});

test('读取 V3 角色卡（ccv3）', () => {
  assert.equal(readCardPng(cardPng({ spec: 'chara_card_v3', data: { name: 'V3' } }, 'ccv3')).data.name, 'V3');
  assert.throws(() => readCardPng(Buffer.from('x'.repeat(16))), /不是 PNG/);
});

test('酒馆助手保存脚本与变量：只改给出的字段', async () => {
  await post('/api/characters/merge-attributes', { avatar: '测试角色.png', data: { extensions: { tavern_helper: { variables: { a: 1 } } } } });
  const c = await post('/api/characters/get', { avatar_url: '测试角色.png' });
  assert.deepEqual(c.data.extensions.tavern_helper, { scripts: [], variables: { a: 1 } });
  assert.equal(c.data.extensions.world, '测试世界');
});

test('聊天：保存后读取、列出', async () => {
  const chat = [{ user_name: 'User', character_name: '测试角色', chat_metadata: {} }, { name: '测试角色', is_user: false, mes: '【封面】', variables: [{ stat_data: { x: 1 } }] }];
  assert.deepEqual(await post('/api/chats/save', { avatar_url: '测试角色.png', file_name: '测试角色 - 1', chat }), { ok: true });
  assert.deepEqual(await post('/api/chats/get', { avatar_url: '测试角色.png', file_name: '测试角色 - 1' }), chat);
  assert.deepEqual(await post('/api/chats/get', { avatar_url: '测试角色.png', file_name: '不存在' }), {});
  const list = await post('/api/characters/chats', { avatar_url: '测试角色.png' });
  assert.equal(list[0].file_name, '测试角色 - 1.jsonl');
  assert.equal(list[0].mes, '【封面】');
});

test('世界书：不存在时返回空世界书，保存、列出、删除', async () => {
  assert.deepEqual(await post('/api/worldinfo/get', { name: '没有' }), { entries: {} });
  await post('/api/worldinfo/edit', { name: '测试世界', data: { entries: { 0: { uid: 0, content: 'x' } } } });
  assert.equal((await post('/api/worldinfo/get', { name: '测试世界' })).entries[0].content, 'x');
  assert.deepEqual((await post('/api/worldinfo/list', {})).map(x => x.file_id), ['测试世界']);
  assert.deepEqual(JSON.parse((await post('/api/settings/get', {})).settings).firstRun, false);
  assert.deepEqual((await post('/api/settings/get', {})).world_names, ['测试世界']);
  await post('/api/worldinfo/delete', { name: '测试世界' });
  assert.deepEqual((await post('/api/worldinfo/list', {})), []);
});

test('没有模拟的接口：返回空对象并只记录一次', async () => {
  logs.length = 0;
  assert.deepEqual(await post('/api/nothing/here', {}), {});
  await post('/api/nothing/here', {});
  assert.equal(logs.filter(l => l.includes('/api/nothing/here')).length, 1);
});

test('从作品的正则找出可以直接插入的触发文字', () => {
  const pack = { bundle: { artifacts: [
    { kind: 'regex', format: 'json', name: '开局.json', content: { scriptName: '魅魔开局', findRegex: '【魅魔开局】', replaceString: '```html\n<!DOCTYPE html><html></html>\n```' } },
    { kind: 'regex', format: 'json', name: '美化.json', content: [
      { scriptName: '天关执法美化', findRegex: '/<天关执法>([\\s\\S]*?)<\\/天关执法>/gsi', replaceString: '<div>$1</div>' },
      { scriptName: '复杂', findRegex: '/(a|b)+c/g', replaceString: 'x' },
      { scriptName: '已禁用', findRegex: '【关】', replaceString: 'x', disabled: true },
    ] },
  ] } };
  assert.deepEqual(triggersOf(pack), [
    { name: '魅魔开局', text: '【魅魔开局】', page: true },
    { name: '天关执法美化', text: '<天关执法>\n\n</天关执法>', page: false },
  ]);
});

test('酒馆页面传来的名字不能带路径（角色卡与作品的脚本不可信）', async () => {
  const data = path.join(tmp, 'data');
  await post('/api/chats/save', { avatar_url: '../../../../逃逸.png', file_name: '../../x', chat: [{}] });
  assert.ok(!fs.existsSync(path.join(tmp, '逃逸')) && !fs.existsSync(path.join(data, '逃逸')));
  assert.ok(fs.existsSync(path.join(data, 'default-user/chats/逃逸/_.._x.jsonl')) || fs.readdirSync(path.join(data, 'default-user/chats/逃逸')).length === 1);
  assert.equal((await call('POST', '/api/characters/get', { avatar_url: '../settings.png' })).status, 404);
  assert.deepEqual(await post('/api/characters/merge-attributes', { avatar: '../../settings.png', data: {} }), { error: 'not found' });
  await post('/api/worldinfo/edit', { name: '..', data: { entries: {} } });
  assert.ok(fs.existsSync(path.join(data, 'default-user/worlds/_.json')));
  assert.ok(!fs.existsSync(path.join(data, 'default-user/.json')));
});

test('生成回复交给 rwkit；默认使用“自定义”来源并自动连接', async () => {
  const s = JSON.parse((await post('/api/settings/get', {})).settings);
  assert.equal(s.oai_settings.chat_completion_source, 'custom');
  assert.equal(s.power_user.auto_connect, true);
  assert.equal((await call('POST', '/api/backends/chat-completions/generate', { messages: [] })).status, 400, '没有连接 rwkit 时返回错误');
  const seen = [];
  const srv2 = createServer({ vendorDir: vendor, dataDir: path.join(tmp, 'data2'), version: {}, hooks: { generate: (b, signal) => { seen.push([b, signal instanceof AbortSignal]); return new Response('{"choices":[]}'); } } });
  const r = await srv2.handle(new Request('rwsim://st/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }) }));
  assert.equal(await r.text(), '{"choices":[]}');
  assert.equal(seen[0][0].messages[0].content, 'hi');
  assert.equal(seen[0][1], true);
});
