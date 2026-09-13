import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: '.', testMatch: 'archive-motion.spec.ts',
  outputDir: '../../test-results/archive-motion',
  use: { channel: 'chrome', baseURL: 'http://127.0.0.1:41803', colorScheme: 'dark' },
  webServer: { cwd: fileURLToPath(new URL('../../', import.meta.url)), command: 'npx vite --host 127.0.0.1 --port 41803 --strictPort', url: 'http://127.0.0.1:41803/tests/e2e/fixtures/archive-motion.html', reuseExistingServer: true }
});
