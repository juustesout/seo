/**
 * Media library API (project-scoped, Content Studio Phase F).
 *
 * Uploads arrive as a raw image body (Content-Type: image/...); the bytes are
 * sniffed server-side - the header/extension is never trusted. Listing, metadata
 * edits and deletion go through MediaService, which owns the object store and
 * the "no deletion while referenced" rule. Routes are thin: authorization and
 * then service calls, mirroring the other Content Studio routers.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { parseId, parseProjectId } from './utils.js';
import { MediaService, MEDIA_MAX_BYTES } from '../../services/mediaService.js';
import { SupabaseStorageStore } from '../../infra/mediaStorage.js';

export const mediaRouter: Router = Router({ mergeParams: true });

mediaRouter.use(requireAuth);

const patchSchema = z
  .object({
    alt_text: z.string().max(500).optional(),
    caption: z.string().max(2000).optional(),
  })
  .passthrough()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide alt_text and/or caption to update' });

const MAX_LABEL = `${Math.round(MEDIA_MAX_BYTES / 1024 / 1024)} MB`;

/** List this project's media library (metadata + stable public URLs). */
mediaRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const svc = new MediaService(container.sb, new SupabaseStorageStore(container.sb));
    const media = await svc.list(projectId);
    res.json({
      data: {
        project_id: projectId,
        configured: true,
        note: media.length === 0 ? 'No media yet. Upload a PNG, JPEG or WebP image.' : null,
        media,
      },
    });
  }),
);

/**
 * Upload one image (raw body). The request body must be image bytes and is
 * capped by the raw-body parser; the MIME type is re-verified from the bytes.
 */
mediaRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes || bytes.length === 0) {
      throw ApiError.badRequest('Send the image file as the raw request body (Content-Type: image/png|jpeg|webp)');
    }
    if (bytes.length > MEDIA_MAX_BYTES) {
      throw ApiError.badRequest(`Image is too large (max ${MAX_LABEL})`);
    }
    const filename = typeof req.query.filename === 'string' ? req.query.filename : undefined;
    const alt = typeof req.query.alt === 'string' ? req.query.alt : undefined;
    const svc = new MediaService(container.sb, new SupabaseStorageStore(container.sb));
    const media = await svc.upload(projectId, user!.sub, { bytes, filename, alt });
    res.status(201).json({ data: { media } });
  }),
);

/** Edit library metadata (alt text / caption). */
mediaRouter.patch(
  '/:mediaId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = patchSchema.parse(req.body);
    const svc = new MediaService(container.sb, new SupabaseStorageStore(container.sb));
    const media = await svc.updateAttrs(projectId, parseId(req, 'mediaId'), {
      altText: body.alt_text,
      caption: body.caption,
    });
    res.json({ data: { media } });
  }),
);

/**
 * Delete a media item. Refused while any content document still references it;
 * the library owns the asset and only un-referenced items can be removed.
 */
mediaRouter.delete(
  '/:mediaId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    const svc = new MediaService(container.sb, new SupabaseStorageStore(container.sb));
    await svc.remove(projectId, parseId(req, 'mediaId'));
    res.status(204).send();
  }),
);
