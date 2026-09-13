import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const origin = 'http://127.0.0.1:41796';
process.env.INTAKE_TRAY_ORIGIN = origin;

export default defineConfig({
  testDir: '.', testMatch: 'intake-tray.spec.ts', fullyParallel: false,
  timeout: 30_000, expect: { timeout: 8_000 },
  outputDir: '../../test-results/intake-tray-fixture',
  use: { browserName: 'chromium', channel: 'chrome', colorScheme: 'dark', trace: 'retain-on-failure' },
  webServer: {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    command: 'npx vite --host 127.0.0.1 --port 41796 --strictPort',
    url: `${origin}/tests/e2e/fixtures/intake-tray.html`, reuseExistingServer: true
  }
});
