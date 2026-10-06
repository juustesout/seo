/**
 * Customer plan catalog API (P15).
 *
 * The product-facing catalog: the active, public plans an account can be on,
 * with their feature packaging, operator-funded resource allowances and pricing
 * metadata. This is presentation only - it carries no account state and no
 * billing. An account's *effective* limits are resolved by
 * `/api/account/entitlement` and enforced by the P14 admission path; the
 * catalog only describes what the plans offer.
 *
 * The API reads the policy tables with the service-role client and returns a
 * DTO; the browser never sees raw plan rows or another account's data. The
 * catalog is product information, so any authenticated user may read it.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';

export const plansRouter: Router = Router();
plansRouter.use(requireAuth);

plansRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const data = await req.container.entitlements.listCustomerPlans();
    res.json({ data });
  }),
);
