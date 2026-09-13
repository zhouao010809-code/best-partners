import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.', testMatch: 'overview-desk.spec.ts', fullyParallel: false,
  outputDir: '../../test-results/overview-desk-fixture',
  use: { browserName: 'chromium', channel: 'chrome', colorScheme: 'dark', trace: 'retain-on-failure' },
  webServer: {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    command: 'npx vite --host 127.0.0.1 --port 41798 --strictPort',
    url: 'http://127.0.0.1:41798/tests/e2e/fixtures/overview-desk.html', reuseExistingServer: true
  }
});
