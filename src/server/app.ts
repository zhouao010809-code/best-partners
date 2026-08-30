import Fastify from 'fastify';

export function buildServer() {
  const app = Fastify({ logger: false });
  app.get('/api/v1/health', async () => ({
    data: {
      status: 'booting' as const,
      apiVersion: 'v1' as const,
      writeGate: 'closed' as const
    },
    version: 1
  }));
  return app;
}
