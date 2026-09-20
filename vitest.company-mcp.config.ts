import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/company-mcp/**/*.test.ts'],
    passWithNoTests: false
  }
});
