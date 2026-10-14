// 预加载：只向界面暴露调用主进程的接口、事件订阅与拖入文件的真实路径
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('rwkit', {
  api: (route, body) => ipcRenderer.invoke('api', route, body),
  on: fn => {
    const h = (e, type, data) => fn(type, data);
    ipcRenderer.on('evt', h);
    return () => ipcRenderer.removeListener('evt', h);
  },
  pathFor: file => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  platform: process.platform,
});
