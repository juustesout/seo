/**
 * X (Twitter) publisher adapter - foundation skeleton (Phase H6.1).
 *
 * X is registered with publish_text + schedule capability so the capability
 * gate and scheduling flows treat it as a real text-only social channel. Live
 * authentication and posting are intentionally NOT implemented in this phase:
 * every publish/update/delete path throws a normalized PublisherError so no
 * publication is ever marked successful and no fake X url / remote id is ever
 * produced. connect/testConnection report the honest "not implemented yet"
 * state instead of pretending a live platform is reachable.
 */

import type {
  DataSourceConnectionResult,
  ProviderContext,
  ProviderDeps,
  PublishInput,
  PublisherProvider,
  PublishResult,
} from '@seo/contracts';
import { PublisherError } from '../publisherError.js';

const NOT_IMPLEMENTED =
  'X live publishing is not implemented yet (foundation phase). Nothing was posted and no external state was created.';

export class XPublisher implements PublisherProvider {
  readonly id = 'x';
  readonly name = 'X';
  readonly description = 'Publish short text posts to X (foundation: live posting arrives in a later phase)';
  readonly capabilities = ['publish_text', 'schedule'] as const;

  constructor(private readonly deps: ProviderDeps) {}

  async connect(_ctx: ProviderContext): Promise<DataSourceConnectionResult> {
    return { ok: false, message: NOT_IMPLEMENTED };
  }

  async disconnect(): Promise<void> {
    // nothing to tear down - the adapter holds no live connection
  }

  async testConnection(_ctx: ProviderContext): Promise<{ ok: boolean; message?: string }> {
    return { ok: false, message: NOT_IMPLEMENTED };
  }

  async publish(_ctx: ProviderContext, _input: PublishInput): Promise<PublishResult> {
    throw new PublisherError('publisher_not_available', NOT_IMPLEMENTED, { retryable: false });
  }

  async update(_ctx: ProviderContext, _remoteId: string, _input: PublishInput): Promise<PublishResult> {
    throw new PublisherError('publisher_not_available', NOT_IMPLEMENTED, { retryable: false });
  }

  async delete(_ctx: ProviderContext, _remoteId: string): Promise<void> {
    throw new PublisherError('publisher_not_available', NOT_IMPLEMENTED, { retryable: false });
  }
}
