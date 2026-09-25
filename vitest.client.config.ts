import { defineConfig } from 'vitest/config';
import { resolve as resolvePath } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '#client-route-pages': resolvePath(process.cwd(), 'src/client/app/route-pages-test.ts')
    }
  },
  test: {
    environment: 'jsdom',
    include: ['tests/component/**/*.test.tsx'],
    setupFiles: ['tests/helpers/setup-dom.ts']
  }
});
