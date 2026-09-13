import { createClipperPayload } from './payload.js';
import { createPendingQueue } from './pending-queue.js';
import { createPendingStore } from './pending-store.js';

const HOST_NAME = 'local.bestpartners.clipper';

function sendNative(payload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let port;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { port?.disconnect(); } catch { /* disconnected */ }
      fn(value);
    };
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
      port.onMessage.addListener((response) => finish(resolve, response));
      port.onDisconnect.addListener(() => finish(reject, new Error(chrome.runtime.lastError?.message || 'Native host disconnected')));
      port.postMessage(payload);
      setTimeout(() => finish(reject, new Error('Native host timed out')), 8000);
    } catch (error) {
      finish(reject, error);
    }
  });
}

const pendingQueue = createPendingQueue({ store: createPendingStore(), send: sendNative });
const deliver = pendingQueue.deliver;
const retryPending = pendingQueue.retryPending;

async function showCaptureError(tabId, error) {
  const message = `保存失败：${error?.message || error || '未知错误'}`;
  if (tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'capture-error', message });
    } catch { /* restricted pages may not accept messages */ }
    try {
      await chrome.action.setBadgeText({ tabId, text: '!' });
      await chrome.action.setTitle({ tabId, title: message });
    } catch { /* badge is only a fallback hint */ }
  }
}

async function requestCapture(tabId) {
  if (!tabId) throw new Error('No active tab');
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content-script.js'] });
  await chrome.tabs.sendMessage(tabId, { type: 'capture-page' });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'save-page', title: '保存到最佳拍档', contexts: ['page'] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'save-page') void requestCapture(tab?.id).catch((error) => showCaptureError(tab?.id, error));
});

chrome.action.onClicked.addListener((tab) => {
  void requestCapture(tab.id).catch((error) => showCaptureError(tab.id, error));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'capture-result') {
    let payload;
    try { payload = createClipperPayload(message.data); }
    catch (error) { sendResponse({ ok: false, error: error.message }); return false; }
    void deliver(payload)
      .then((response) => sendResponse({ ok: true, response }))
      .catch((error) => sendResponse({ ok: false, queued: true, packetId: payload.packetId, error: error.message }));
    return true;
  }
  if (message?.type === 'retry-pending') {
    void retryPending()
      .then((results) => sendResponse({ ok: true, results }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'test-connection') {
    void sendNative({ type: 'ping' })
      .then((response) => sendResponse({ ok: true, response }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

export { HOST_NAME, deliver, retryPending };
