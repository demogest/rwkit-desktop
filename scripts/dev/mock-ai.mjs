// 开发用：模拟 OpenAI 接口（/v1/models、/v1/chat/completions 与 /v1/responses 流式），给 AI 帮写做界面自测
// 用法：node scripts/dev/mock-ai.mjs [端口] [保存最近一次请求的文件]，默认 18765；在“AI 帮写设置”里填 http://127.0.0.1:端口/v1，API key 填 test-key
import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.argv[2]) || 18765;
const dump = process.argv[3] || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function answer(body) {
  const sys = body.instructions ?? body.messages?.[0]?.content ?? '';
  const user = typeof body.input === 'string' ? body.input : body.messages?.at(-1)?.content || '';
  const text = (/【(?:原文|内容)】\n([\s\S]*)$/.exec(user) || [])[1] || '';
  // 模拟酒馆发来的聊天（SillyTavern 组好的多条消息）：回一段剧情，附带 MVU 的变量更新命令
  if ((body.messages || body.input || []).length > 2) return "你在主神空间醒来，四周一片寂静。（模拟回复）\n\n<UpdateVariable>\n_.set('世界.时间', '', '第一天·清晨');//模拟回复更新时间\n</UpdateVariable>";
  if (/任务：审查/.test(sys)) {
    return `## 审查结果\n\n1. **EJS 标签**：\`<% if %>\` 没有对应的 \`<% } %>\`。\n   - 建议：在条目末尾补上结束标签。\n2. **措辞**：“非常非常”重复，可以改为“极其”。\n\n共 ${text.length} 字，其余部分没有发现问题。`;
  }
  if (/任务：润色/.test(sys)) return text.replace(/非常非常/g, '极其').trim() + (body.instructions ? '（Responses）' : '（已润色）');
  if (/任务：按照作者的要求修改/.test(sys)) return text.replace(/守卫/g, '哨兵');
  return '【代写】一位沉默的守卫，披着褪色的斗篷，守在地下城入口。\n说话简短，只回答必要的问题。';
}
const chunk = (responses, piece) => responses
  ? 'event: response.output_text.delta\ndata: ' + JSON.stringify({ type: 'response.output_text.delta', delta: piece }) + '\n\n'
  : 'data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n';
const finish = responses => responses
  ? 'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }) + '\n\n'
  : 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';

http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'mock-fast' }, { id: 'mock-1' }, { id: 'text-embedding-mock' }, ...Array.from({ length: 240 }, (_, i) => ({ id: 'vendor/model-' + String(i).padStart(3, '0') }))] })); return; }
  const responses = req.url.endsWith('/responses');
  if (!responses && !req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
  if (req.headers.authorization !== 'Bearer test-key') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad key' } })); return; }
  const body = JSON.parse(raw || '{}');
  if (dump) fs.writeFileSync(dump, JSON.stringify(body, null, 1));
  console.log(req.url, body.model, responses ? 'responses' : 'chat');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const out = answer(body);
  for (let i = 0; i < out.length; i += 6) { res.write(chunk(responses, out.slice(i, i + 6))); await sleep(15); }
  res.write(finish(responses));
  res.end();
}).listen(port, '127.0.0.1', () => console.log('mock AI on http://127.0.0.1:' + port + '/v1'));
