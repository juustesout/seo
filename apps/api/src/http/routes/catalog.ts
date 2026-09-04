/** GET /api/providers - capability catalog the UI discovers instead of hardcoding. */

import { Router } from 'express';
import { requireAuth } from '../middleware.js';
import type { ProvidersCatalogDto } from '@seo/contracts';

export const catalogRouter: Router = Router();

catalogRouter.use(requireAuth);

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
