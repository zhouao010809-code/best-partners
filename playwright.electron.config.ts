import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/electron', testMatch: '**/*.{test,spec}.ts', workers: 1, fullyParallel: false, timeout: 60_000, use: { trace: 'retain-on-failure' } });
