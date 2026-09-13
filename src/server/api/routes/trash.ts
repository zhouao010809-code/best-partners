import type { FastifyInstance } from 'fastify';
import { PublicApiError } from '../../../shared/api/errors.js';
import { API_VERSION } from '../../../shared/api/schemas.js';
import { trashDeletePreviewResponseSchema, trashDeleteRequestSchema, trashEmptySchema, trashEntryResponseSchema, trashIdRequestSchema, trashListResponseSchema, trashPathRequestSchema, trashPreviewResponseSchema } from '../../../shared/api/trash.js';
import type { TrashService } from '../../trash/trash-service.js';
import { parseApiInput, parseApiOutput } from '../route-validation.js';

export function registerTrashRoutes(app:FastifyInstance,service?:TrashService) {
  function required(){if(!service)throw new PublicApiError('TRASH_UNAVAILABLE','回收站暂不可用，请使用更新后的个人桌面 App。',503);return service;}
  app.get('/api/v1/trash',async(request,reply)=>{reply.header('cache-control','no-store');parseApiInput(trashEmptySchema,request.query);return parseApiOutput(trashListResponseSchema,{version:API_VERSION,data:required().list()});});
  app.get('/api/v1/trash/:id',async(request,reply)=>{reply.header('cache-control','no-store');const {id}=parseApiInput(trashIdRequestSchema,request.params);parseApiInput(trashEmptySchema,request.query);return parseApiOutput(trashEntryResponseSchema,{version:API_VERSION,data:required().get(id)});});
  app.post('/api/v1/trash/preview',async(request,reply)=>{reply.header('cache-control','no-store');const {materialPath,origin}=parseApiInput(trashPathRequestSchema,request.body);return parseApiOutput(trashPreviewResponseSchema,{version:API_VERSION,data:await required().preview(materialPath,origin)});});
  app.post('/api/v1/trash/commit',async(request,reply)=>{reply.header('cache-control','no-store');const {id}=parseApiInput(trashIdRequestSchema,request.body);return parseApiOutput(trashEntryResponseSchema,{version:API_VERSION,data:await required().commit(id)});});
  app.post('/api/v1/trash/:id/delete-preview',async(request,reply)=>{reply.header('cache-control','no-store');const {id}=parseApiInput(trashIdRequestSchema,request.params);parseApiInput(trashEmptySchema,request.body);return parseApiOutput(trashDeletePreviewResponseSchema,{version:API_VERSION,data:await required().previewDelete(id)});});
  app.post('/api/v1/trash/:id/delete',async(request,reply)=>{reply.header('cache-control','no-store');const {id}=parseApiInput(trashIdRequestSchema,request.params);const {token}=parseApiInput(trashDeleteRequestSchema,request.body);return parseApiOutput(trashEntryResponseSchema,{version:API_VERSION,data:await required().delete(id,token)});});
  for(const action of ['restore','retry'] as const)app.post(`/api/v1/trash/:id/${action}`,async(request,reply)=>{reply.header('cache-control','no-store');const {id}=parseApiInput(trashIdRequestSchema,request.params);parseApiInput(trashEmptySchema,request.body);return parseApiOutput(trashEntryResponseSchema,{version:API_VERSION,data:await required()[action](id)});});
}
