import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
  environment: 'node', include: ['tests/archive/**/*.test.ts'], fileParallelism: false,
  testTimeout: 20_000, hookTimeout: 30_000, passWithNoTests: false
} });
