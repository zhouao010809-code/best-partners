import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fixtureOrigin = 'http://127.0.0.1:41796';
process.env.QUEUE_DRAWER_ORIGIN = fixtureOrigin;
process.env.QUEUE_VISIBILITY_ORIGIN = fixtureOrigin;

export default defineConfig({
  testDir: '.', testMatch: ['queue-drawer.spec.ts', 'queue-visibility.spec.ts', 'candidate-review.spec.ts'], fullyParallel: false, workers: 1,
  timeout: 30_000, expect: { timeout: 8_000 },
  outputDir: '../../test-results/queue-drawer-fixture',
  use: { browserName: 'chromium', channel: 'chrome', colorScheme: 'dark', trace: 'retain-on-failure' },
  webServer: {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    command: 'npx vite --host 127.0.0.1 --port 41796 --strictPort',
    url: `${fixtureOrigin}/tests/e2e/fixtures/queue-drawer.html`, reuseExistingServer: true
  }
});
