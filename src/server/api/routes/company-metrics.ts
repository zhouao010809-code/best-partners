import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { API_VERSION } from '../../../shared/api/schemas.js';
import {
  companyMetricImportRequestSchema,
  companyMetricImportResponseSchema,
  companyMetricScanResponseSchema,
  companyMetricsStatusResponseSchema,
  companyProjectMetricsResponseSchema
} from '../../../shared/api/company-metrics.js';
import { PublicApiError } from '../../../shared/api/errors.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';
import {
  requireCompanyUser,
  type CompanyAuthRequest,
  type CompanyAuthService,
  type CompanyPrincipal
} from '../../company/company-auth-service.js';
import type { CompanyMetricImportResult, CompanyMetricsService } from '../../company/company-metrics-service.js';

const idSchema = z.string().min(1).max(256);
const projectParamsSchema = z.strictObject({ id: idSchema });
const statusQuerySchema = z.strictObject({ projectId: idSchema.optional() });

function authRequest(request: FastifyRequest): CompanyAuthRequest {
  return { headers: request.headers as unknown as NonNullable<CompanyAuthRequest['headers']> };
}

function requirePermission(auth: CompanyAuthService, user: CompanyPrincipal, permission: Parameters<CompanyAuthService['can']>[1]): void {
  if (!auth.can(user, permission)) throw new PublicApiError('COMPANY_FORBIDDEN', 'Company role is not permitted', 403);
}

function publicImport(value: CompanyMetricImportResult) {
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    platform: value.platform,
    sourceRelativePath: value.sourceRelativePath,
    rawRelativePath: value.rawRelativePath,
    sourceSha256: value.sourceSha256,
    sourceType: value.sourceType,
    state: value.state,
    rowCount: value.rowCount,
    importedCount: value.importedCount,
    rejectedCount: value.rejectedCount,
    issues: value.issues,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    importedAt: value.importedAt
  };
}

export function registerCompanyMetricRoutes(
  app: FastifyInstance,
  dependencies: { readonly auth: CompanyAuthService; readonly metrics: CompanyMetricsService }
): void {
  const { auth, metrics } = dependencies;

  app.get('/api/company/v1/projects/:id/metrics', async (request, reply) => {
    const user = await requireCompanyUser(auth, authRequest(request));
    requirePermission(auth, user, 'proposal:read');
    const { id } = parseApiInput(projectParamsSchema, request.params);
    const result = await metrics.listProjectMetrics(id);
    reply.header('cache-control', 'no-store');
    return parseApiOutput(companyProjectMetricsResponseSchema, { data: result, version: API_VERSION });
  });

  app.get('/api/company/v1/metrics/status', async (request, reply) => {
    const user = await requireCompanyUser(auth, authRequest(request));
    requirePermission(auth, user, 'proposal:read');
    const { projectId } = parseApiInput(statusQuerySchema, request.query);
    const result = await metrics.getStatus(projectId);
    reply.header('cache-control', 'no-store');
    return parseApiOutput(companyMetricsStatusResponseSchema, { data: result, version: API_VERSION });
  });

  app.post('/api/company/v1/metrics/scan', async (request, reply) => {
    const user = await requireCompanyUser(auth, authRequest(request));
    requirePermission(auth, user, 'metrics:import');
    const result = await metrics.scanIncoming();
    reply.header('cache-control', 'no-store');
    return parseApiOutput(companyMetricScanResponseSchema, {
      data: {
        scanned: result.scanned,
        imported: result.imported,
        partial: result.partial,
        duplicate: result.duplicate,
        conflict: result.conflict,
        failed: result.failed,
        imports: result.imports.map(publicImport),
        scannedAt: result.scannedAt
      },
      version: API_VERSION
    });
  });

  app.post('/api/company/v1/metrics/import', async (request, reply) => {
    const user = await requireCompanyUser(auth, authRequest(request));
    requirePermission(auth, user, 'metrics:import');
    const input = parseApiInput(companyMetricImportRequestSchema, request.body);
    const result = await metrics.importFile({ relativePath: input.sourcePath });
    reply.header('cache-control', 'no-store');
    return parseApiOutput(companyMetricImportResponseSchema, { data: publicImport(result), version: API_VERSION });
  });
}
