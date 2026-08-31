import type { FastifyInstance } from 'fastify';
import {
  API_VERSION,
  operationPageResponseSchema,
  operationPageSchema
} from '../../../shared/api/schemas.js';
import { parseApiOutput } from '../route-validation.js';

export function registerOperationRoutes(app: FastifyInstance): void {
  app.get('/api/v1/operations', async () => {
    const data = parseApiOutput(operationPageSchema, { items: [] });
    return parseApiOutput(operationPageResponseSchema, { data, version: API_VERSION });
  });
}
