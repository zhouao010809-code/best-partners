import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/native/**/*.contract.test.ts'],
    passWithNoTests: false,
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000
  }
});
