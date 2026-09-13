import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({testDir:'.',testMatch:'operations.spec.ts',outputDir:'../../test-results/operations',use:{channel:'chrome',baseURL:'http://127.0.0.1:41804',colorScheme:'dark'},webServer:{cwd:fileURLToPath(new URL('../../',import.meta.url)),command:'npx vite --host 127.0.0.1 --port 41804 --strictPort',url:'http://127.0.0.1:41804/tests/e2e/fixtures/operations.html',reuseExistingServer:true}});
