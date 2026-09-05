/// <reference types="vite/client" />

import type { XiaozhaoDesktopApi } from '../shared/desktop/bridge.js';

declare global {
  interface Window {
    readonly xiaozhaoDesktop?: XiaozhaoDesktopApi;
  }
}
