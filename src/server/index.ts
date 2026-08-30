import { buildServer } from './app.js';

const host = process.env.APP_HOST ?? '127.0.0.1';
const port = Number(process.env.APP_PORT ?? '4317');
const app = buildServer();

await app.listen({ host, port });
