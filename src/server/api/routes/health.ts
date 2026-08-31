import type { FastifyInstance } from 'fastify';
import {
  API_VERSION,
  healthResponseSchema,
  healthSnapshotSchema
} from '../../../shared/api/schemas.js';
import type { HealthService } from '../../services/health-service.js';
import { parseApiOutput } from '../route-validation.js';

export function registerHealthRoutes(app: FastifyInstance, service: HealthService): void {
  app.get('/api/v1/health', async () => {
    const data = parseApiOutput(healthSnapshotSchema, await service.getSnapshot());
    return parseApiOutput(healthResponseSchema, { data, version: API_VERSION });
  });
}
