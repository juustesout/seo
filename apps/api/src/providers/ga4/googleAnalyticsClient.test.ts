/**
 * GA4 API client tests (P4). Pin normalization, request shape, discovery
 * enrichment, metric parsing and the 401 -> UnauthorizedError contract the
 * service relies on to refresh once.
 */
import { describe, expect, it } from 'vitest';
import { GoogleAnalyticsClient, GoogleAnalyticsError, UnauthorizedError, normalizePropertyId } from './googleAnalyticsClient.js';

function response(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

describe('normalizePropertyId', () => {
  it('strips the properties/ prefix and passes numeric ids through', () => {
    expect(normalizePropertyId('properties/123456')).toBe('123456');
    expect(normalizePropertyId('123456')).toBe('123456');
  });
});

describe('GoogleAnalyticsClient', () => {
  it('lists properties from accountSummaries with real names', async () => {
    const calls: string[] = [];
    const client = new GoogleAnalyticsClient('tok', (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('accountSummaries')) {
        return response({
          accountSummaries: [
            { displayName: 'Acme', propertySummaries: [{ property: 'properties/111', displayName: 'My Website' }] },
            { displayName: 'Other', propertySummaries: [{ property: 'properties/222', displayName: 'Example Shop' }] },
          ],
        });
      }
      if (String(url).includes('properties/111/dataStreams')) {
        return response({ dataStreams: [{ type: 'WEB', webStreamData: { defaultUri: 'https://example.com' } }] });
      }
      return response({ dataStreams: [] });
    }) as unknown as typeof fetch);

    const properties = await client.listProperties();
    expect(properties).toEqual([
      { propertyId: '111', propertyName: 'My Website', propertyUrl: 'https://example.com' },
      { propertyId: '222', propertyName: 'Example Shop', propertyUrl: null },
    ]);
    expect(calls.some((u) => u.includes('accountSummaries'))).toBe(true);
  });

  it('returns an empty list when the account has no properties', async () => {
    const client = new GoogleAnalyticsClient('tok', (async () => response({ accountSummaries: [] })) as unknown as typeof fetch);
    expect(await client.listProperties()).toEqual([]);
  });

  it('normalizes a runReport page-traffic response', async () => {
    let sawBody = '';
    const client = new GoogleAnalyticsClient('tok', (async (_url: string, init?: RequestInit) => {
      sawBody = String(init?.body ?? '');
      return response({
        rows: [
          { dimensionValues: [{ value: '/' }], metricValues: [{ value: '4821' }, { value: '3902' }, { value: '4500' }] },
          { dimensionValues: [{ value: '/blog/seo-guide' }], metricValues: [{ value: '2184' }, { value: '1731' }, { value: '2000' }] },
        ],
        rowCount: 2,
      });
    }) as unknown as typeof fetch);

    const report = await client.runPageTrafficReport('123', { startDate: '2026-09-01', endDate: '2026-09-28', limit: 100 });
    expect(report.truncated).toBe(false);
    expect(report.rows).toEqual([
      { path: '/', views: 4821, active_users: 3902, sessions: 4500 },
      { path: '/blog/seo-guide', views: 2184, active_users: 1731, sessions: 2000 },
    ]);
    const body = JSON.parse(sawBody);
    expect(body.dimensions).toEqual([{ name: 'pagePath' }]);
    expect(body.metrics.map((m: { name: string }) => m.name)).toEqual(['screenPageViews', 'activeUsers', 'sessions']);
  });

  it('marks the report truncated when Google has more rows than returned', async () => {
    const client = new GoogleAnalyticsClient('tok', (async () =>
      response({ rows: [{ dimensionValues: [{ value: '/' }], metricValues: [{ value: '1' }, { value: '1' }, { value: '1' }] }], rowCount: 500 })) as unknown as typeof fetch);
    const report = await client.runPageTrafficReport('123', { startDate: '2026-09-01', endDate: '2026-09-28', limit: 1 });
    expect(report.truncated).toBe(true);
  });

  it('throws UnauthorizedError on 401 so the service can refresh', async () => {
    const client = new GoogleAnalyticsClient('tok', (async () => response({ error: { message: 'expired' } }, 401)) as unknown as typeof fetch);
    await expect(client.listProperties()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('throws a GoogleAnalyticsError on other non-2xx responses', async () => {
    const client = new GoogleAnalyticsClient('tok', (async () => response({ error: { message: 'quota' } }, 429)) as unknown as typeof fetch);
    await expect(client.listProperties()).rejects.toBeInstanceOf(GoogleAnalyticsError);
  });

  it('reads the connected Google identity', async () => {
    const client = new GoogleAnalyticsClient('tok', (async (url: string) => {
      if (String(url).includes('userinfo')) return response({ email: 'user@example.com' });
      return response({});
    }) as unknown as typeof fetch);
    expect(await client.getUserEmail()).toBe('user@example.com');
  });
});
