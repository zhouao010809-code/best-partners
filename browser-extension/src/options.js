const status = document.querySelector('#status');

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
