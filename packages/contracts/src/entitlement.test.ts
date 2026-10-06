/**
 * Entitlement contracts (P13): the closed vocabularies, the resource -> usage
 * ledger mapping, and deterministic period boundaries. These are the shared
 * facts both enforcement and reporting depend on, so they are pinned here.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWANCE_PERIODS,
  ALLOWANCE_SCOPES,
  ENTITLEMENT_FEATURES,
  ENTITLEMENT_LIMIT_CODE,
  ENTITLEMENT_RESOURCES,
  ENTITLEMENT_RESOURCE_SPEC,
  PLAN_BILLING_INTERVALS,
  PLAN_DISPLAY_NAME_MAX_CHARS,
  PLAN_PRICE_LABEL_MAX_CHARS,
  PLAN_PRICE_STATUSES,
  isValidAllowancePeriod,
  isValidAllowanceScope,
  isValidEntitlementFeature,
  isValidEntitlementResource,
  isValidPlanBillingInterval,
  isValidPlanPriceStatus,
  resolveAllowancePeriod,
} from './entitlement.js';
import type { CustomerPlanDto, PlanSummaryDto } from './entitlement.js';

describe('entitlement vocabulary', () => {
  it('closes the feature vocabulary', () => {
    expect(ENTITLEMENT_FEATURES).toEqual([
      'api_access',
      'mcp_access',
      'ai_editing',
      'publishing',
      'designer',
      'composer',
    ]);
    expect(isValidEntitlementFeature('api_access')).toBe(true);
    expect(isValidEntitlementFeature('billing')).toBe(false);
  });

  it('closes the allowance period and scope vocabularies', () => {
    expect(ALLOWANCE_PERIODS).toEqual(['day', 'week', 'month', 'year', 'none']);
    expect(ALLOWANCE_SCOPES).toEqual(['account', 'project']);
    expect(isValidAllowancePeriod('month')).toBe(true);
    expect(isValidAllowancePeriod('fortnight')).toBe(false);
    expect(isValidAllowanceScope('account')).toBe(true);
    expect(isValidAllowanceScope('team')).toBe(false);
  });

  it('closes the resource vocabulary and exposes a stable limit code', () => {
    expect(ENTITLEMENT_RESOURCES).toEqual(['ai_generation', 'ai_image', 'dataforseo_research', 'media', 'x_link_post']);
    expect(isValidEntitlementResource('x_link_post')).toBe(true);
    expect(isValidEntitlementResource('publishing')).toBe(false);
    expect(ENTITLEMENT_LIMIT_CODE).toBe('entitlement_limit');
  });
});

describe('ENTITLEMENT_RESOURCE_SPEC', () => {
  it('maps each product resource onto the usage ledger vocabulary', () => {
    expect(ENTITLEMENT_RESOURCE_SPEC.ai_generation).toMatchObject({
      category: 'ai',
      units: ['input_token', 'output_token'],
      xLinkOnly: false,
      fundingModel: 'byok_or_operator',
    });
    // AI images are metered by the media provider's `image_generation` request.
    expect(ENTITLEMENT_RESOURCE_SPEC.ai_image).toMatchObject({
      category: 'media',
      units: ['image_generation'],
      fundingModel: 'byok_or_operator',
    });
    // DataForSEO is aggregated from the two billable request units only; the
    // `keyword`/`task` sub-units must never inflate the count.
    expect(ENTITLEMENT_RESOURCE_SPEC.dataforseo_research).toMatchObject({
      category: 'dataforseo',
      units: ['request', 'serp_request'],
      fundingModel: 'byok_or_operator',
    });
    expect(ENTITLEMENT_RESOURCE_SPEC.media).toMatchObject({
      category: 'media',
      units: ['request'],
      fundingModel: 'operator',
    });
  });

  it('gives every resource a funding model and a metering definition', () => {
    for (const resource of ENTITLEMENT_RESOURCES) {
      const spec = ENTITLEMENT_RESOURCE_SPEC[resource];
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.unitLabel.length).toBeGreaterThan(0);
      expect(spec.metering.length).toBeGreaterThan(0);
      expect(spec.units.length).toBeGreaterThan(0);
    }
  });

  it('counts only X link posts for x_link_post', () => {
    expect(ENTITLEMENT_RESOURCE_SPEC.x_link_post).toMatchObject({
      category: 'publishing',
      units: ['publish_attempt'],
      xLinkOnly: true,
    });
  });
});

describe('resolveAllowancePeriod', () => {
  // 2026-10-05 is a Monday, which makes the week boundary unambiguous.
  const monday = new Date('2026-10-05T13:37:00.000Z');

  it('resolves a UTC day window', () => {
    expect(resolveAllowancePeriod('day', monday)).toEqual({
      start: '2026-10-05T00:00:00.000Z',
      end: '2026-10-06T00:00:00.000Z',
    });
  });

  it('resolves an ISO week starting Monday', () => {
    expect(resolveAllowancePeriod('week', monday)).toEqual({
      start: '2026-10-05T00:00:00.000Z',
      end: '2026-10-12T00:00:00.000Z',
    });
  });

  it('resolves a week that crosses a month boundary', () => {
    // 2026-03-01 is a Sunday; its ISO week begins Monday 2026-02-23.
    expect(resolveAllowancePeriod('week', new Date('2026-03-01T08:00:00.000Z'))).toEqual({
      start: '2026-02-23T00:00:00.000Z',
      end: '2026-03-02T00:00:00.000Z',
    });
  });

  it('resolves a UTC month window', () => {
    expect(resolveAllowancePeriod('month', monday)).toEqual({
      start: '2026-10-01T00:00:00.000Z',
      end: '2026-11-01T00:00:00.000Z',
    });
  });

  it('resolves a UTC year window', () => {
    expect(resolveAllowancePeriod('year', monday)).toEqual({
      start: '2026-01-01T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z',
    });
  });

  it('treats none as a lifetime window', () => {
    const window = resolveAllowancePeriod('none', monday);
    expect(window.start.startsWith('1970-01-01')).toBe(true);
    expect(window.end.startsWith('9999-')).toBe(true);
  });

  it('uses the last UTC day of February in a non-leap year', () => {
    expect(resolveAllowancePeriod('month', new Date('2026-02-15T23:59:59.999Z'))).toEqual({
      start: '2026-02-01T00:00:00.000Z',
      end: '2026-03-01T00:00:00.000Z',
    });
  });
});

describe('plan catalog & pricing vocabulary (P15)', () => {
  it('closes the billing interval and price status vocabularies', () => {
    expect(PLAN_BILLING_INTERVALS).toEqual(['monthly', 'yearly']);
    expect(isValidPlanBillingInterval('monthly')).toBe(true);
    expect(isValidPlanBillingInterval('weekly')).toBe(false);
    expect(PLAN_PRICE_STATUSES).toEqual(['draft', 'final']);
    expect(isValidPlanPriceStatus('final')).toBe(true);
    expect(isValidPlanPriceStatus('negotiating')).toBe(false);
  });

  it('rejects non-string values for both guards', () => {
    expect(isValidPlanBillingInterval(null)).toBe(false);
    expect(isValidPlanBillingInterval(1)).toBe(false);
    expect(isValidPlanPriceStatus(undefined)).toBe(false);
    expect(isValidPlanPriceStatus({})).toBe(false);
  });

  it('exposes bounded display fields for admin-entered plan copy', () => {
    expect(PLAN_DISPLAY_NAME_MAX_CHARS).toBe(120);
    expect(PLAN_PRICE_LABEL_MAX_CHARS).toBe(40);
  });

  it('models a priced plan summary and its customer projection', () => {
    const summary: PlanSummaryDto = {
      key: 'starter',
      name: 'Starter',
      displayName: 'Starter',
      description: null,
      isDefault: false,
      isPublic: true,
      sortOrder: 10,
      pricing: { currency: 'EUR', monthlyPrice: 1900, yearlyPrice: null, priceStatus: 'draft', priceLabel: null },
      billingIntervals: ['monthly'],
    };
    const plan: CustomerPlanDto = {
      ...summary,
      features: [{ feature: 'api_access', enabled: true }],
      allowances: [
        {
          resource: 'ai_generation',
          unit: 'input_token',
          period: 'month',
          scope: 'account',
          operatorFunded: true,
          byokExempt: true,
          status: 'active',
          allowance: 0,
        },
      ],
    };
    expect(plan.pricing.monthlyPrice).toBe(1900);
    expect(plan.pricing.yearlyPrice).toBeNull();
    expect(plan.allowances[0]?.allowance).toBe(0);
  });
});
