/**
 * Demo/test social publisher adapter (Content Studio Phase H5).
 *
 * Registered ONLY when ENABLE_TEST_PUBLISHERS=true so it never shows up in
 * production catalogs by default. It exercises the whole pipeline (schedule ->
 * publication -> publish job -> worker -> adapter -> remote "platform") without
 * a real network: every publish is transformed through the social payload
 * builder and recorded with a `demo:` remote id and no target URL - it never
 * pretends content reached an external platform.
 */

import { createHash } from 'node:crypto';
import type {
  DataSourceConnectionResult,
  ProviderContext,
  ProviderDeps,
  PublishInput,
  PublisherProvider,
  PublishResult,
} from '@seo/contracts';
import { buildSocialTextPost } from './textPayload.js';

export class MockSocialPublisher implements PublisherProvider {
  readonly id = 'mock_social';
  readonly name = 'Social demo (mock)';
  readonly description = 'Demo social channel for testing the publishing pipeline - no external network calls';
  readonly capabilities = ['publish_text'] as const;

  constructor(private readonly deps: ProviderDeps) {}

  private resultFor(ctx: ProviderContext, input: PublishInput): PublishResult {
    const { text } = buildSocialTextPost(input);
    ctx.logger.debug('mock social publish (demo, no external call)', { chars: text.length });
    const hash = createHash('sha1').update(text).digest('hex').slice(0, 12);
    return { remoteId: `demo:${hash}`, url: null };
  }

  async connect(_ctx: ProviderContext): Promise<DataSourceConnectionResult> {
    return { ok: true, message: 'Demo social channel ready (test provider, no external network)' };
  }

  async disconnect(): Promise<void> {
    // nothing to tear down for a demo channel
  }

  async testConnection(_ctx: ProviderContext): Promise<{ ok: boolean; message?: string }> {
    return { ok: true, message: 'Demo social channel is available (test provider, no external network)' };
  }

  async publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
    return this.resultFor(ctx, input);
  }

  async update(ctx: ProviderContext, remoteId: string, input: PublishInput): Promise<PublishResult> {
    this.resultFor(ctx, input);
    return { remoteId, url: null };
  }

  async delete(_ctx: ProviderContext, _remoteId: string): Promise<void> {
    // demo channel keeps no remote state
  }
}
