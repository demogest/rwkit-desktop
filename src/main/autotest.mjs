// 开发用的界面自测：按脚本操作窗口并截图（只在未打包且设置了 RWKIT_AUTOTEST 时启用）
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function run(win, file) {
  const out = msg => { try { process.stdout.write('[autotest] ' + msg + '\n'); } catch {} };
  let steps;
  try { steps = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { out('脚本读取失败：' + e.message); app.exit(2); return; }
  const outDir = path.dirname(file);
  win.webContents.on('console-message', (...args) => {
    const d = args[0], level = d?.level ?? args[1], msg = d?.message ?? args[2];
    if (level === 'warning' || level === 'error' || level >= 2) out('console ' + level + ': ' + msg);
  });
  for (const s of steps) {
    try {
      if (s.wait) await sleep(s.wait);
      if (s.size) { win.setContentSize(s.size[0], s.size[1]); await sleep(300); }
      if (s.js) { const v = await win.webContents.executeJavaScript(`(async () => { ${s.js} })()`, true); if (v !== undefined) out((s.label || 'js') + ' → ' + JSON.stringify(v)); }
      if (s.text) win.webContents.insertText(s.text);
      if (s.key) {
        for (const type of ['keyDown', 'char', 'keyUp']) {
          if (type === 'char' && (s.key.modifiers || []).length) continue;
          win.webContents.sendInputEvent({ type, keyCode: s.key.keyCode, modifiers: s.key.modifiers || [] });
        }
      }
      if (s.after) await sleep(s.after);
      if (s.shot) {
        win.webContents.invalidate();
        await Promise.race([win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))', true), sleep(800)]);
        await sleep(150);
        let img = await win.webContents.capturePage();
        if (s.width) img = img.resize({ width: s.width, quality: 'best' }); fs.writeFileSync(path.join(outDir, s.shot), img.toPNG()); out('shot ' + s.shot + ' ' + JSON.stringify(img.getSize())); }
    } catch (e) { out('step failed: ' + (s.label || JSON.stringify(s).slice(0, 80)) + ' — ' + e.message); }
  }
  if (!process.env.RWKIT_KEEP) app.exit(0);
}
