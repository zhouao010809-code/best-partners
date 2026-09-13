import type { FastifyInstance } from 'fastify';
import {
  API_VERSION,
  materialPageResponseSchema,
  materialPageSchema,
  materialQuerySchema
} from '../../../shared/api/schemas.js';
import { PublicApiError } from '../../../shared/api/errors.js';
import type { ReadService } from '../../services/read-service.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';
import { libraryPageResponseSchema, libraryPageSchema, libraryQuerySchema } from '../../../shared/api/library.js';

export function registerMaterialRoutes(app: FastifyInstance, service?: ReadService): void {
  app.get('/api/v1/library', async (request) => {
    if (service === undefined) throw new PublicApiError('READ_API_UNAVAILABLE', 'Read API is unavailable', 503);
    const query = parseApiInput(libraryQuerySchema, request.query);
    const data = parseApiOutput(libraryPageSchema, service.listLibrary(query));
    return parseApiOutput(libraryPageResponseSchema, { data, version: API_VERSION });
  });
  app.get('/api/v1/materials', async (request) => {
    if (service === undefined) {
      throw new PublicApiError('READ_API_UNAVAILABLE', 'Read API is unavailable', 503);
    }
    const query = parseApiInput(materialQuerySchema, request.query);
    const data = parseApiOutput(materialPageSchema, service.listMaterials(query));
    return parseApiOutput(materialPageResponseSchema, { data, version: API_VERSION });
  });
}
