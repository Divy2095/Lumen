import type { FastifyPluginAsync } from 'fastify';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { MediaService } from './media.service.js';
import { Mp4StreamInspector } from './mp4-validator.js';
import { defaultStorageService } from '../../shared/storage/local-storage.service.js';
import { getStorageConfig } from '../../config/storage.js';

export const mediaRoutes: FastifyPluginAsync = async (fastify) => {
  const mediaService = new MediaService(fastify.db);

  await defaultStorageService.init();

  // Startup lifecycle: perform safe one-time stale temporary-file cleanup
  try {
    const config = getStorageConfig();
    const cleanupResult = await defaultStorageService.cleanupStaleTempFiles(
      config.uploadTokenTtlSeconds * 1000 * 2, // 2 hours threshold
      (assetId) => mediaService.isAssetActivelyUploading(assetId)
    );

    if (cleanupResult.deleted > 0) {
      fastify.log.info(
        { deletedCount: cleanupResult.deleted },
        'Cleaned up stale temporary upload files during startup'
      );
    }
    if (cleanupResult.errors > 0) {
      fastify.log.warn(
        { errorCount: cleanupResult.errors },
        'Encountered errors while cleaning up some stale temporary files during startup'
      );
    }
  } catch (cleanupErr: any) {
    // Non-critical startup cleanup failure: log clearly without preventing startup
    fastify.log.warn(
      { err: cleanupErr?.message },
      'Non-critical error during startup stale temporary-file cleanup'
    );
  }

  // POST /v1/media (Register media asset upload intent)
  fastify.post(
    '/v1/media',
    {
      preHandler: [(fastify as any).authenticateApiKey],
      schema: {
        body: {
          type: 'object',
          required: ['original_filename', 'mime_type', 'file_size_bytes'],
          additionalProperties: false,
          properties: {
            original_filename: { type: 'string', minLength: 1, maxLength: 255 },
            mime_type: { type: 'string', enum: ['video/mp4'] },
            file_size_bytes: { type: 'integer', minimum: 1, maximum: getStorageConfig().maxUploadSizeBytes },
          },
        },
      },
    },
    async (request, reply) => {
      const project = request.project!;
      const body = request.body as {
        original_filename: string;
        mime_type: string;
        file_size_bytes: number;
      };

      // Strip directory path characters to prevent traversal
      const sanitizedFilename = body.original_filename.replace(/^.*[\\/]/, '');

      const asset = await mediaService.registerMedia(project.id, {
        original_filename: sanitizedFilename,
        mime_type: body.mime_type,
        file_size_bytes: body.file_size_bytes,
      });

      return reply.status(201).send(asset);
    }
  );

  // PUT /v1/media/:id/upload (Direct streaming MP4 upload)
  fastify.put(
    '/v1/media/:id/upload',
    async (request, reply) => {
      const { id: assetId } = request.params as { id: string };
      const storageConfig = getStorageConfig();

      // 1. Verify Authorization Bearer token header
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({
          error: 'unauthorized',
          message: 'Missing or invalid upload token in Authorization header',
        });
      }
      const rawUploadToken = authHeader.slice(7).trim();

      // 2. Validate Content-Type (must be video/mp4 with optional parameters or application/octet-stream)
      const rawContentType = request.headers['content-type'];
      if (!rawContentType) {
        return reply.status(415).send({
          error: 'unsupported_media_type',
          message: 'Missing Content-Type header. Expected video/mp4 or application/octet-stream',
        });
      }
      const normalizedCt = rawContentType.split(';')[0]?.trim().toLowerCase();
      if (normalizedCt !== 'video/mp4' && normalizedCt !== 'application/octet-stream') {
        return reply.status(415).send({
          error: 'unsupported_media_type',
          message: `Unsupported Content-Type "${rawContentType}". Expected video/mp4 or application/octet-stream`,
        });
      }

      // 3. Content-Length header validation
      const contentLengthHeader = request.headers['content-length'];
      if (!contentLengthHeader) {
        return reply.status(411).send({
          error: 'length_required',
          message: 'Content-Length header is required for media upload',
        });
      }

      const contentLength = Number(contentLengthHeader);
      if (!Number.isInteger(contentLength) || contentLength <= 0) {
        return reply.status(400).send({
          error: 'invalid_content_length',
          message: 'Content-Length header must be a positive integer',
        });
      }

      if (contentLength > storageConfig.maxUploadSizeBytes) {
        return reply.status(413).send({
          error: 'payload_too_large',
          message: `Upload exceeds maximum allowed size of ${storageConfig.maxUploadSizeBytes} bytes (100 MB)`,
        });
      }

      // 4. Preflight check: authenticate token and inspect asset state without leaking
      const preflight = await mediaService.findAssetForUploadPreflight(assetId, rawUploadToken);
      if (!preflight.claimed || !preflight.asset) {
        switch (preflight.reason) {
          case 'invalid_token':
            return reply.status(401).send({
              error: 'unauthorized',
              message: 'Invalid upload credentials',
            });
          case 'expired':
            return reply.status(403).send({
              error: 'token_expired',
              message: 'Upload token has expired',
            });
          case 'already_uploaded':
            return reply.status(409).send({
              error: 'asset_already_uploaded',
              message: 'This media asset has already been ingested',
            });
          case 'in_progress_or_consumed':
          default:
            return reply.status(409).send({
              error: 'upload_in_progress_or_consumed',
              message: 'Upload token has already been consumed or an upload is already in progress',
            });
        }
      }

      // Verify Content-Length matches registered file_size_bytes before consuming token
      if (contentLength !== preflight.asset.fileSizeBytes) {
        return reply.status(400).send({
          error: 'content_length_mismatch',
          message: `Content-Length header (${contentLength}) does not match declared file_size_bytes (${preflight.asset.fileSizeBytes})`,
        });
      }

      // 5. Atomically claim the asset and consume upload token
      const claimResult = await mediaService.claimUploadToken(assetId, rawUploadToken);
      if (!claimResult.claimed || !claimResult.asset) {
        switch (claimResult.reason) {
          case 'invalid_token':
            return reply.status(401).send({
              error: 'unauthorized',
              message: 'Invalid upload credentials',
            });
          case 'expired':
            return reply.status(403).send({
              error: 'token_expired',
              message: 'Upload token has expired',
            });
          case 'already_uploaded':
            return reply.status(409).send({
              error: 'asset_already_uploaded',
              message: 'This media asset has already been ingested',
            });
          case 'in_progress_or_consumed':
          default:
            return reply.status(409).send({
              error: 'upload_in_progress_or_consumed',
              message: 'Upload token has already been consumed or an upload is already in progress',
            });
        }
      }

      const asset = claimResult.asset;

      // 6. Prepare temporary file stream and lifecycle trackers
      const tempFileName = `${asset.id}.upload.tmp`;
      const { writeStream, tempFilePath } = defaultStorageService.createTempWriteStream(tempFileName);
      const finalFilePath = defaultStorageService.resolvePath(asset.storageKey);
      const inspector = new Mp4StreamInspector(asset.fileSizeBytes);

      let fileRenamedToFinal = false;
      let uploadSucceeded = false;
      let timedOut = false;
      let durationTimer: NodeJS.Timeout | null = null;
      let inactivityTimer: NodeJS.Timeout | null = null;

      const sock = request.raw.socket;
      const isMockSocket = !sock || sock.constructor.name === 'MockSocket';

      // Safe stream teardown: unpipe and close socket on real HTTP to prevent unbounded reading
      const teardownStream = () => {
        request.raw.unpipe();
        if (!isMockSocket) {
          reply.header('Connection', 'close');
          reply.raw.once('finish', () => {
            if (sock && !sock.destroyed) {
              sock.destroy();
            }
          });
        } else {
          request.raw.resume();
        }
      };

      const resetInactivityTimer = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(async () => {
          timedOut = true;
          fastify.log.warn({ assetId: asset.id }, 'Upload stream timed out due to inactivity');
          try {
            await mediaService.markUploadFailed(asset.id);
          } catch {}
          reply.header('Connection', 'close');
          reply.status(408).send({
            error: 'upload_timeout',
            message: 'Upload stream timed out due to inactivity',
          });
          teardownStream();
          request.raw.destroy();
        }, storageConfig.uploadInactivityTimeoutMs);
      };

      durationTimer = setTimeout(async () => {
        timedOut = true;
        fastify.log.warn({ assetId: asset.id }, 'Upload exceeded maximum duration window');
        try {
          await mediaService.markUploadFailed(asset.id);
        } catch {}
        reply.header('Connection', 'close');
        reply.status(408).send({
          error: 'upload_timeout',
          message: 'Upload exceeded maximum duration window',
        });
        teardownStream();
        request.raw.destroy();
      }, storageConfig.maxUploadDurationMs);

      request.raw.on('data', resetInactivityTimer);
      resetInactivityTimer();

      inspector.on('error', teardownStream);
      writeStream.on('error', teardownStream);
      request.raw.on('error', teardownStream);

      try {
        await pipeline(request.raw, inspector, writeStream);

        // If a timeout already fired, abort finalization
        if (timedOut) {
          return;
        }

        // Verify total bytes received match expected
        const receivedBytes = inspector.getBytesReceived();
        if (receivedBytes !== asset.fileSizeBytes) {
          const mismatchErr = new Error(
            `Stream byte count mismatch: received ${receivedBytes} bytes, expected ${asset.fileSizeBytes}`
          );
          (mismatchErr as any).code = 'ERR_STREAM_BYTE_MISMATCH';
          throw mismatchErr;
        }

        // Commit temporary file to final storage key
        await defaultStorageService.commitFile(tempFilePath, asset.storageKey);
        fileRenamedToFinal = true;

        // Finalize PostgreSQL state (uploading -> ready)
        try {
          const publicAsset = await mediaService.finalizeUpload(asset.id, receivedBytes);
          uploadSucceeded = true;
          fastify.log.info({ assetId: asset.id, bytes: receivedBytes }, 'Media asset upload finalized successfully');
          return reply.status(200).send(publicAsset);
        } catch (finalizeErr: any) {
          fastify.log.error(
            { assetId: asset.id, err: finalizeErr?.message },
            'Exception during PostgreSQL finalization after filesystem commit'
          );

          // Check if PostgreSQL actually committed the transition
          let confirmedStatus: string | null = null;
          try {
            confirmedStatus = await mediaService.checkAssetStatus(asset.id);
          } catch (statusCheckErr: any) {
            fastify.log.error(
              { assetId: asset.id, err: statusCheckErr?.message },
              'CRITICAL: Unable to verify asset status from database; commit outcome uncertain'
            );
          }

          if (confirmedStatus === 'ready') {
            // DB confirmed ready
            uploadSucceeded = true;
            const publicAsset = await mediaService.getMediaAsset(asset.projectId, asset.id);
            return reply.status(200).send(publicAsset);
          }

          if (confirmedStatus !== null && confirmedStatus !== 'ready') {
            // DB is reachable and asset did not transition to ready
            // Clean up orphaned final file
            await defaultStorageService.unlinkFile(finalFilePath);
            try {
              await mediaService.markUploadFailed(asset.id);
            } catch (markErr: any) {
              fastify.log.warn({ assetId: asset.id, err: markErr?.message }, 'Failed to mark asset as failed');
            }

            return reply.status(500).send({
              error: 'internal_error',
              message: 'An internal error occurred during upload finalization',
            });
          }

          // Outcome cannot be determined (database unreachable).
          // Preserve final file and log for reconciliation.
          fastify.log.error(
            { assetId: asset.id, finalFilePath },
            'CRITICAL: Upload commit outcome uncertain for asset; preserving file at final path for reconciliation'
          );

          return reply.status(500).send({
            error: 'internal_error',
            message: 'An internal error occurred during upload finalization',
          });
        }
      } catch (err: any) {
        if (timedOut) {
          return;
        }

        fastify.log.error(
          { assetId: asset.id, err: err?.message, code: err?.code },
          'Media asset upload failed during ingestion'
        );

        // Mark asset failed in DB
        try {
          await mediaService.markUploadFailed(asset.id);
        } catch (markErr: any) {
          fastify.log.warn({ assetId: asset.id, err: markErr?.message }, 'Failed to mark asset as failed in DB');
        }

        if (err?.code === 'ERR_INVALID_CONTAINER') {
          return reply.status(400).send({
            error: 'invalid_media_container',
            message: err.message,
          });
        }

        if (err?.code === 'ERR_PAYLOAD_TOO_LARGE') {
          return reply.status(413).send({
            error: 'payload_too_large',
            message: err.message,
          });
        }

        if (err?.code === 'ERR_STREAM_TIMEOUT' || err?.code === 'ERR_UPLOAD_DURATION_EXCEEDED') {
          return reply.status(408).send({
            error: 'upload_timeout',
            message: err.message,
          });
        }

        if (err?.code === 'ERR_STREAM_BYTE_MISMATCH') {
          return reply.status(400).send({
            error: 'stream_byte_mismatch',
            message: err.message,
          });
        }

        // Catch aborts or client disconnects
        if (err?.code === 'ABORT_ERR' || err?.name === 'AbortError' || err?.code === 'ECONNRESET') {
          return reply.status(400).send({
            error: 'client_disconnected',
            message: 'Client disconnected before upload completed',
          });
        }

        return reply.status(500).send({
          error: 'internal_error',
          message: 'An internal error occurred during media ingestion',
        });
      } finally {
        if (durationTimer) clearTimeout(durationTimer);
        if (inactivityTimer) clearTimeout(inactivityTimer);
        request.raw.off('data', resetInactivityTimer);
        inspector.off('error', teardownStream);
        writeStream.off('error', teardownStream);
        request.raw.off('error', teardownStream);

        // Only unlink temp file if upload did not succeed and temp file wasn't renamed
        if (!uploadSucceeded && !fileRenamedToFinal) {
          await defaultStorageService.unlinkFile(tempFilePath);
        }
      }
    }
  );

  // GET /v1/media/:id (Get media asset metadata)
  fastify.get(
    '/v1/media/:id',
    {
      preHandler: [(fastify as any).authenticateApiKey],
    },
    async (request, reply) => {
      const project = request.project!;
      const { id: assetId } = request.params as { id: string };

      const asset = await mediaService.getMediaAsset(project.id, assetId);
      if (!asset) {
        return reply.status(404).send({
          error: 'asset_not_found',
          message: 'Media asset not found in this project',
        });
      }

      return reply.status(200).send(asset);
    }
  );

  // GET /v1/media/:id/thumbnail (Stream thumbnail image)
  fastify.get(
    '/v1/media/:id/thumbnail',
    {
      preHandler: [(fastify as any).authenticateApiKey],
    },
    async (request, reply) => {
      const project = request.project!;
      const { id: assetId } = request.params as { id: string };

      const thumbnail = await mediaService.getThumbnail(project.id, assetId);
      if (!thumbnail) {
        return reply.status(404).send({
          error: 'thumbnail_not_found',
          message: 'Thumbnail not found or not ready for this media asset',
        });
      }

      const filePath = defaultStorageService.resolvePath(thumbnail.storageKey);
      const exists = await defaultStorageService.fileExists(filePath);
      if (!exists) {
        return reply.status(404).send({
          error: 'thumbnail_not_found',
          message: 'Thumbnail file is missing from storage',
        });
      }

      const stream = createReadStream(filePath);
      stream.on('error', (err) => {
        request.log.error({ err }, 'Streaming error occurred while reading thumbnail file');
      });
      return reply
        .type(thumbnail.mimeType)
        .header('Content-Length', thumbnail.fileSizeBytes)
        .header('Cache-Control', 'private, max-age=86400')
        .send(stream);
    }
  );
};

export default mediaRoutes;
