import type { FastifyPluginAsync } from 'fastify';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { MediaService } from '../media/media.service.js';
import type { RegisterMediaInput } from '../media/media.types.js';
import { registrationBodySchema } from '../media/media.schema.js';
import { InvalidTranscodingConfigError } from '../media/transcoding-profiles.js';
import { defaultStorageService, type StorageService } from '../../shared/storage/local-storage.service.js';
import { BrowserContextService, requireBrowserProject } from './browser-context.service.js';
import { BrowserMediaService } from './browser-media.service.js';
import {
  browserAssetParams, browserErrorResponses, browserRegistrationResponse, browserStatusResponse,
} from './browser-media.schema.js';

export const browserMediaRoutes: FastifyPluginAsync<{
  storage?: Pick<StorageService, 'resolvePath' | 'fileExists'>;
}> = async (fastify, options) => {
  const media = new MediaService(fastify.db);
  const browserMedia = new BrowserMediaService(fastify.db, media);
  const context = new BrowserContextService(fastify.db);
  const storage = options.storage ?? defaultStorageService;
  const preHandler = [fastify.authenticateClerk, requireBrowserProject(context)];

  fastify.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });

  fastify.post('/v1/browser/media', {
    preHandler,
    // Reject authority fields before Fastify removes additional body properties.
    preValidation: async (request, reply) => {
      for (const source of [request.body, request.query]) {
        if (source && typeof source === 'object' &&
            ['account_id', 'project_id', 'accountId', 'projectId'].some(key => Object.hasOwn(source, key))) {
          return reply.status(400).send({ error: 'bad_request', message: 'Account and project selection is not accepted.' });
        }
      }
    },
    schema: {
      body: registrationBodySchema(),
      response: { 201: browserRegistrationResponse, ...browserErrorResponses },
    },
  }, async (request, reply) => {
    const body = request.body as RegisterMediaInput;
    try {
      const registered = await media.registerMedia(request.browserProject!.id, {
        ...body, original_filename: body.original_filename.replace(/^.*[\\/]/, ''),
      });
      return reply.status(201).send(registered);
    } catch (error) {
      if (error instanceof InvalidTranscodingConfigError) {
        return reply.status(400).send({ error: 'bad_request', message: error.message });
      }
      throw error;
    }
  });

  fastify.get('/v1/browser/media/:id', {
    preHandler,
    schema: { params: browserAssetParams, response: { 200: browserStatusResponse, ...browserErrorResponses } },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const asset = await browserMedia.getStatus(request.browserProject!.id, id);
    if (!asset) return reply.status(404).send({ error: 'asset_not_found', message: 'Media asset not found in this project' });
    return reply.send(asset);
  });

  fastify.get('/v1/browser/media/:id/thumbnail', {
    preHandler,
    schema: {
      params: browserAssetParams,
      response: { 200: { type: 'string', format: 'binary' }, ...browserErrorResponses },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const thumbnail = await media.getThumbnail(request.browserProject!.id, id);
    if (!thumbnail) return reply.status(404).send({ error: 'thumbnail_not_found', message: 'Thumbnail not found or not ready' });
    const path = storage.resolvePath(thumbnail.storageKey);
    if (!await storage.fileExists(path)) {
      return reply.status(404).send({ error: 'thumbnail_not_found', message: 'Thumbnail not found or not ready' });
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stream = file.createReadStream();
    stream.on('error', err => request.log.error({ err }, 'Thumbnail streaming error'));
    return reply.type('image/jpeg').header('Content-Length', thumbnail.fileSizeBytes).send(stream);
  });
};
