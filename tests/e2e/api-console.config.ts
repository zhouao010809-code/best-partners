import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import base from '../../playwright.config.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!];

// Release verification has already built the runtime. Do not overwrite its
// recorded artifacts while exercising the real API against an isolated vault.
export default defineConfig({
  ...base,
  testDir: fileURLToPath(new URL('./', import.meta.url)),
  testMatch: ['read-only-console.spec.ts', 'production-deck.spec.ts', 'company-project-onboarding.spec.ts'],
  workers: 1,
  outputDir: fileURLToPath(new URL('../../test-results/api-console/', import.meta.url)),
  webServer: servers.map((server, index) => ({
    ...server,
    cwd: repository,
    ...(index === 1 ? { command: 'npm exec tsx tests/e2e/fixture-server.ts' } : {})
  }))
});
