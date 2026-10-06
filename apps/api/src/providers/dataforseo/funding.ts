/**
 * DataForSEO funding attribution (P14).
 *
 * DataForSEO can be paid for by the operator's server credentials or by the
 * user's own connected credentials (BYOK). The entitlement layer only ever
 * bounds operator-funded consumption, so it must attribute the funding exactly
 * the way the adapter picks a client - otherwise an operator-funded research
 * call would be recorded as unattributable and consume no allowance, or a BYOK
 * call could wrongly consume the operator's.
 *
 * This mirrors `DataForSeoDataSource.clientFor` precedence precisely:
 *   1. stored account token          -> BYOK
 *   2. server env token              -> operator-funded
 *   3. stored account login+password -> BYOK
 *   4. server env login+password     -> operator-funded
 *   5. none                          -> null (unattributable; consumes nothing)
 */

import type { CredentialReader, FundingSource } from '@seo/contracts';
import { DATAFORSEO_CRED_KEYS } from './dataSource.js';

/** Server-side DataForSEO credentials the adapter would fall back to. */
export interface DataForSeoEnvCredentials {
  DATAFORSEO_BASE64?: string | undefined;
  DATAFORSEO_LOGIN?: string | undefined;
  DATAFORSEO_PASSWORD?: string | undefined;
}

/**
 * Resolve which credential funds a DataForSEO call for one integration. Reads
 * only the exact integration's stored credentials, never another owner's.
 */
export async function resolveDataForSeoFundingSource(args: {
  credentials: CredentialReader;
  env: DataForSeoEnvCredentials;
}): Promise<FundingSource | null> {
  const [storedBase64, storedLogin, storedPassword] = await Promise.all([
    args.credentials.get(DATAFORSEO_CRED_KEYS.base64),
    args.credentials.get(DATAFORSEO_CRED_KEYS.login),
    args.credentials.get(DATAFORSEO_CRED_KEYS.password),
  ]);
  if (storedBase64) return 'byok';
  if (args.env.DATAFORSEO_BASE64) return 'operator_funded';
  if (storedLogin && storedPassword) return 'byok';
  if (args.env.DATAFORSEO_LOGIN && args.env.DATAFORSEO_PASSWORD) return 'operator_funded';
  return null;
}
