import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve as resolvePath } from 'node:path';
import {
  DEVELOPMENT_HTTP_ORIGIN,
  LOOPBACK_HTTP_HOST,
  PRODUCTION_HTTP_ORIGIN
} from './src/server/security/origin-host.js';

const developmentUrl = new URL(DEVELOPMENT_HTTP_ORIGIN);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '#client-route-pages': resolvePath(process.cwd(), 'src/client/app/route-pages-production.ts')
    }
  },
  server: {
    host: LOOPBACK_HTTP_HOST,
    port: Number(developmentUrl.port),
    strictPort: true,
    proxy: {
      '/api': {
        target: PRODUCTION_HTTP_ORIGIN,
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist/client',
    chunkSizeWarningLimit: 900
  }
});
