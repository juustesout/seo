/**
 * Provider capability catalog - the discovery endpoint the UI uses instead of
 * hardcoding provider ids or vendor names.
 *
 * Adding a provider means registering its adapter + descriptor in the registry;
 * this endpoint then advertises it to the UI automatically, so no UI change is
 * needed for a new provider. The response is a ProvidersCatalogDto grouping the
 * registry's data sources, knowledge providers, publishers, AI and media
 * providers, each tagged with its kind for client-side rendering.
 *
 * Mounted at /api/providers. Only requires an authenticated session - catalog
 * entries are capability descriptors (id/name/description/setup fields), never
 * credentials or per-project state.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware.js';
import type { ProvidersCatalogDto } from '@seo/contracts';

export const catalogRouter: Router = Router();

catalogRouter.use(requireAuth);

/** Emit every registered provider grouped by capability kind. */
catalogRouter.get('/', (req, res) => {
  const registry = req.container.registry;
  const dto: ProvidersCatalogDto = {
    dataSources: registry.listDataSources().map((d) => ({ ...d, kind: 'datasource' as const })),
    knowledge: registry.listKnowledge().map((d) => ({ ...d, kind: 'knowledge' as const })),
    publishers: registry.listPublishers().map((d) => ({ ...d, kind: 'publisher' as const })),
    ai: registry.listAI().map((d) => ({ ...d, kind: 'ai' as const })),
    media: registry.listMedia().map((d) => ({ ...d, kind: 'media' as const })),
  };
  res.json({ data: dto });
});
