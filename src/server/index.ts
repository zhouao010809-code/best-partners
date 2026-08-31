import { buildServer } from './app.js';
import { resolveLoopbackListenOptions } from './security/origin-host.js';

const listenOptions = resolveLoopbackListenOptions(process.env);
const app = buildServer();

await app.listen(listenOptions);
