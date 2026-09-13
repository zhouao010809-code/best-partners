import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.', testMatch: 'unified-trash.spec.ts', fullyParallel: false,
  outputDir: '../../test-results/unified-trash-fixture',
  use: { browserName: 'chromium', channel: 'chrome', colorScheme: 'dark', trace: 'retain-on-failure' },
  webServer: { cwd: fileURLToPath(new URL('../../', import.meta.url)), command: 'npx vite --host 127.0.0.1 --port 41795 --strictPort', url: 'http://127.0.0.1:41795/tests/e2e/fixtures/unified-trash.html', reuseExistingServer: true },
});
