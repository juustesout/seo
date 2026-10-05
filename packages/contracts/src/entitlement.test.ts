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
  isValidAllowancePeriod,
  isValidAllowanceScope,
  isValidEntitlementFeature,
  isValidEntitlementResource,
  resolveAllowancePeriod,
} from './entitlement.js';

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
    });
    expect(ENTITLEMENT_RESOURCE_SPEC.ai_image).toMatchObject({ category: 'ai', units: ['image_generation'] });
    // Empty units means "all units in the category".
    expect(ENTITLEMENT_RESOURCE_SPEC.dataforseo_research).toMatchObject({ category: 'dataforseo', units: [] });
    expect(ENTITLEMENT_RESOURCE_SPEC.media).toMatchObject({ category: 'media', units: ['asset'] });
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
