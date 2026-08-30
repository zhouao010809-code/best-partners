import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/component/**/*.test.tsx'],
    setupFiles: ['tests/helpers/setup-dom.ts']
  }
});
