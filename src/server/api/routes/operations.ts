import type { FastifyInstance } from 'fastify';
import {
  API_VERSION,
  operationPageResponseSchema,
  operationPageSchema, operationQuerySchema
} from '../../../shared/api/schemas.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';
import { createOperationLedger } from '../../services/operation-ledger.js';

export function registerOperationRoutes(app: FastifyInstance, sources: Parameters<typeof createOperationLedger>[0] = {}): void {
  const ledger = createOperationLedger(sources);
  app.get('/api/v1/operations', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const data = parseApiOutput(operationPageSchema, await ledger.list(parseApiInput(operationQuerySchema, request.query)));
    return parseApiOutput(operationPageResponseSchema, { data, version: API_VERSION });
  });
}
