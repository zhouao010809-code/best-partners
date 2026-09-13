const status = document.querySelector('#status');
const tokenInput = document.querySelector('#token');

chrome.storage.local.get('clipperToken').then((stored) => { if (typeof stored?.clipperToken === 'string') tokenInput.value = stored.clipperToken; });
document.querySelector('#save').addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (token.length < 32) { show('配对令牌至少需要 32 个字符。'); return; }
  await chrome.storage.local.set({ clipperToken: token }); show('配对令牌已保存。');
});

function show(message) { status.textContent = message; }

document.querySelector('#test').addEventListener('click', () => {
  show('正在连接本地 App…');
  chrome.runtime.sendMessage({ type: 'test-connection' }, (response) => {
    if (chrome.runtime.lastError) show(`连接失败：${chrome.runtime.lastError.message}`);
    else if (response?.ok) show('连接成功，可以在网页上点击扩展按钮或使用右键菜单。');
    else show(`连接失败：${response?.error || '请先在桌面 App 中安装 host'}`);
  });
});

document.querySelector('#retry').addEventListener('click', () => {
  show('正在重试…');
  try {
    const request = chrome.runtime.sendMessage({ type: 'retry-pending' }, (response) => {
      if (chrome.runtime.lastError) show(`重试失败：${chrome.runtime.lastError.message}`);
      else show(response?.ok ? `已重试 ${response.results.length} 条收藏。` : `重试失败：${response?.error || '未知错误'}`);
    });
    Promise.resolve(request).catch((error) => show(`重试失败：${error.message || error}`));
  } catch (error) {
    show(`重试失败：${error.message || error}`);
  }
});
