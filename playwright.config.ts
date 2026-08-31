import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: 'http://127.0.0.1:41793',
    colorScheme: 'dark',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'npm exec vite -- --host 127.0.0.1 --port 41793 --strictPort',
    url: 'http://127.0.0.1:41793/tests/e2e/fixtures/material-deck.html',
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
