const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

if (globalThis.__xiaozhaoClipperLoaded) {
  // The service worker may inject this file more than once after a navigation.
} else {
globalThis.__xiaozhaoClipperLoaded = true;

function firstText(selectors) {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const value = element?.getAttribute('content') || element?.getAttribute('datetime') || element?.textContent;
    if (value?.trim()) return value.trim();
  }
  return '';
}

function findPublishedAt() {
  const metadata = firstText([
    'meta[property="article:published_time"]',
    'meta[name="date"]',
    'meta[itemprop="datePublished"]',
    'time[datetime]'
  ]);
  if (metadata && Number.isFinite(new Date(metadata).getTime())) return new Date(metadata).toISOString();
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const value = JSON.parse(script.textContent || '');
      const candidates = Array.isArray(value) ? value : [value, ...(value?.['@graph'] || [])];
      const date = candidates.find((entry) => entry?.datePublished || entry?.dateModified)?.datePublished || candidates.find((entry) => entry?.dateModified)?.dateModified;
      if (date && Number.isFinite(new Date(date).getTime())) return new Date(date).toISOString();
    } catch {
      // Ignore malformed page metadata and use the capture time.
    }
  }
  return new Date().toISOString();
}

function readableContent() {
  const root = document.querySelector('article, main, [role="main"]') || document.body;
  const text = (root?.innerText || root?.textContent || '').replace(/\n{3,}/gu, '\n\n').trim();
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= MAX_CAPTURE_BYTES) return text;
  return new TextDecoder().decode(encoded.slice(0, MAX_CAPTURE_BYTES));
}

function capturePage() {
  return {
    title: document.title.trim(),
    url: location.href,
    content: readableContent(),
    clippedAt: findPublishedAt()
  };
}

function showCaptureError(message) {
  const existing = document.querySelector('[data-xiaozhao-clipper-toast]');
  existing?.remove();
  const toast = document.createElement('div');
  toast.dataset.xiaozhaoClipperToast = 'true';
  toast.textContent = message;
  Object.assign(toast.style, {
    position: 'fixed', zIndex: '2147483647', right: '16px', bottom: '16px', maxWidth: 'min(420px, calc(100vw - 32px))',
    padding: '10px 14px', borderRadius: '8px', background: '#7f1d1d', color: '#fff', font: '14px/1.4 system-ui, sans-serif', boxShadow: '0 4px 16px #0006'
  });
  document.documentElement.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'capture-page') {
    void chrome.runtime.sendMessage({ type: 'capture-result', data: capturePage() }, (response) => {
      if (chrome.runtime.lastError) showCaptureError(`保存失败：${chrome.runtime.lastError.message}`);
      else if (!response?.ok) showCaptureError(`保存失败：${response?.error || '请检查桌面 App 连接'}`);
    });
  } else if (message?.type === 'capture-error') {
    showCaptureError(message.message || '保存失败');
  }
});
}
