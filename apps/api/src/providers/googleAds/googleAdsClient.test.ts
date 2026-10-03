/**
 * Google Ads API client tests (P5). Pin normalization, request shape, the
 * searchStream parser, discovery, GAQL reporting normalization and the
 * 401 -> UnauthorizedError contract the service relies on to refresh once.
 */
import { describe, expect, it } from 'vitest';
import {
  GoogleAdsClient,
  GoogleAdsError,
  UnauthorizedError,
  isValidAdsFilter,
  normalizeCustomerId,
  parseSearchStreamBody,
} from './googleAdsClient.js';

function response(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe('normalizeCustomerId', () => {
  it('strips the customers/ prefix and hyphens, passing numeric ids through', () => {
    expect(normalizeCustomerId('customers/123456')).toBe('123456');
    expect(normalizeCustomerId('123-456-7890')).toBe('1234567890');
    expect(normalizeCustomerId(' 123456 ')).toBe('123456');
  });
});

describe('isValidAdsFilter', () => {
  it('accepts safe free text and rejects GAQL metacharacters', () => {
    expect(isValidAdsFilter('shoes')).toBe(true);
    expect(isValidAdsFilter('red shoes.size 42')).toBe(true);
    expect(isValidAdsFilter("' OR 1=1")).toBe(false);
    expect(isValidAdsFilter('50%_off')).toBe(false);
    expect(isValidAdsFilter('a'.repeat(51))).toBe(false);
  });
});

describe('parseSearchStreamBody', () => {
  it('flattens the JSON array of result chunks', () => {
    const body = JSON.stringify([{ results: [{ a: 1 }] }, { results: [{ b: 2 }] }]);
    expect(parseSearchStreamBody(body)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('tolerates newline-delimited chunks', () => {
    const body = `${JSON.stringify({ results: [{ a: 1 }] })}\n${JSON.stringify({ results: [{ b: 2 }] })}`;
    expect(parseSearchStreamBody(body)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('returns an empty list for an empty body', () => {
    expect(parseSearchStreamBody('')).toEqual([]);
  });
});

describe('GoogleAdsClient', () => {
  it('lists accessible customers, normalizing resource names', async () => {
    const client = new GoogleAdsClient('tok', {
      fetchFn: (async () => response({ resourceNames: ['customers/111', 'customers/222'] })) as unknown as typeof fetch,
    });
    expect(await client.listAccessibleCustomers()).toEqual(['111', '222']);
  });

  it('reads customer metadata from a searchStream customer query', async () => {
    let sawBody = '';
    const client = new GoogleAdsClient('tok', {
      fetchFn: (async (_url: string, init?: RequestInit) => {
        sawBody = String(init?.body ?? '');
        return response([{ results: [{ customer: { id: '111', descriptiveName: 'Acme', currencyCode: 'USD', manager: false, status: 'ENABLED' } }] }]);
      }) as unknown as typeof fetch,
    });
    expect(await client.getCustomerMeta('111')).toEqual({
      customerId: '111',
      name: 'Acme',
      currencyCode: 'USD',
      isManager: false,
      status: 'ENABLED',
    });
    expect(JSON.parse(sawBody).query).toContain('FROM customer');
  });

  it('lists managed customers from customer_client', async () => {
    const client = new GoogleAdsClient('tok', {
      fetchFn: (async () =>
        response([{ results: [{ customerClient: { id: '222', descriptiveName: 'Client', currencyCode: 'EUR', manager: false, status: 'ENABLED' } }] }])) as unknown as typeof fetch,
    });
    expect(await client.listManagedCustomers('111')).toEqual([
      { customerId: '222', name: 'Client', currencyCode: 'EUR', isManager: false, status: 'ENABLED' },
    ]);
  });

  it('normalizes search terms and converts cost_micros to currency units', async () => {
    let sawBody = '';
    const client = new GoogleAdsClient('tok', {
      fetchFn: (async (_url: string, init?: RequestInit) => {
        sawBody = String(init?.body ?? '');
        return response([
          {
            results: [
              {
                searchTermView: { searchTerm: 'running shoes', status: 'NONE' },
                metrics: { impressions: '1000', clicks: '50', costMicros: '2500000', conversions: '3', ctr: '0.05' },
              },
            ],
          },
        ]);
      }) as unknown as typeof fetch,
    });
    const { rows, truncated } = await client.searchTerms('111', { startDate: '2026-09-01', endDate: '2026-09-07', limit: 100 });
    expect(rows).toEqual([
      { search_term: 'running shoes', status: 'NONE', impressions: 1000, clicks: 50, cost: 2.5, conversions: 3, ctr: 0.05 },
    ]);
    expect(truncated).toBe(false);
    expect(JSON.parse(sawBody).query).toContain('FROM search_term_view');
    expect(JSON.parse(sawBody).query).toContain("segments.date BETWEEN '2026-09-01' AND '2026-09-07'");
  });

  it('normalizes keywords with campaign/ad-group context', async () => {
    const client = new GoogleAdsClient('tok', {
      fetchFn: (async () =>
        response([
          {
            results: [
              {
                adGroupCriterion: { keyword: { text: 'buy shoes', matchType: 'PHRASE' }, status: 'ENABLED' },
                campaign: { name: 'Brand' },
                adGroup: { name: 'Exact' },
                metrics: { impressions: '10', clicks: '2', costMicros: '1000000', conversions: '0.5', ctr: '0.2' },
              },
            ],
          },
        ])) as unknown as typeof fetch,
    });
    const { rows } = await client.keywords('111', { startDate: '2026-09-01', endDate: '2026-09-07', limit: 100 });
    expect(rows).toEqual([
      {
        keyword_text: 'buy shoes',
        match_type: 'PHRASE',
        status: 'ENABLED',
        campaign_name: 'Brand',
        ad_group_name: 'Exact',
        impressions: 10,
        clicks: 2,
        cost: 1,
        conversions: 0.5,
        ctr: 0.2,
      },
    ]);
  });

  it('marks a report truncated when Google returns exactly the limit', async () => {
    const client = new GoogleAdsClient('tok', {
      fetchFn: (async () =>
        response([{ results: [{ searchTermView: { searchTerm: 'a' }, metrics: {} }] }])) as unknown as typeof fetch,
    });
    const { truncated } = await client.searchTerms('111', { startDate: '2026-09-01', endDate: '2026-09-07', limit: 1 });
    expect(truncated).toBe(true);
  });

  it('forwards the developer-token header only when configured', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string> | undefined) ?? {});
      return response({ resourceNames: [] });
    }) as unknown as typeof fetch;

    await new GoogleAdsClient('tok', { fetchFn }).listAccessibleCustomers();
    await new GoogleAdsClient('tok', { fetchFn, developerToken: 'dev-token' }).listAccessibleCustomers();
    expect(seen[0]?.['developer-token']).toBeUndefined();
    expect(seen[1]?.['developer-token']).toBe('dev-token');
  });

  it('throws UnauthorizedError on 401 so the service can refresh', async () => {
    const client = new GoogleAdsClient('tok', {
      fetchFn: (async () => response({ error: { message: 'expired' } }, 401)) as unknown as typeof fetch,
    });
    await expect(client.listAccessibleCustomers()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('throws a GoogleAdsError carrying the provider code on other failures', async () => {
    const client = new GoogleAdsClient('tok', {
      fetchFn: (async () =>
        response(
          {
            error: {
              status: 'PERMISSION_DENIED',
              message: 'no access',
              details: [{ errors: [{ errorCode: { authorizationError: 'CUSTOMER_NOT_FOUND' } }] }],
            },
          },
          403,
        )) as unknown as typeof fetch,
    });
    await expect(client.listAccessibleCustomers()).rejects.toMatchObject({
      name: 'GoogleAdsError',
      status: 403,
      reason: 'PERMISSION_DENIED',
      providerCode: 'CUSTOMER_NOT_FOUND',
    });
  });

  it('reports every real request through the observer', async () => {
    const seen: Array<[string, boolean]> = [];
    const client = new GoogleAdsClient('tok', {
      fetchFn: (async () => response({ resourceNames: ['customers/111'] })) as unknown as typeof fetch,
      observe: async (operation, success) => {
        seen.push([operation, success]);
      },
    });
    await client.listAccessibleCustomers();
    expect(seen).toEqual([['list_accessible_customers', true]]);
  });

  it('reads the connected Google identity', async () => {
    const client = new GoogleAdsClient('tok', {
      fetchFn: (async (url: string) => {
        if (String(url).includes('userinfo')) return response({ email: 'user@example.com' });
        return response({});
      }) as unknown as typeof fetch,
    });
    expect(await client.getUserEmail()).toBe('user@example.com');
  });

  it('exposes the error class for callers', () => {
    expect(new GoogleAdsError('x', 500).name).toBe('GoogleAdsError');
  });
});
