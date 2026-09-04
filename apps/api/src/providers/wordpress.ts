/**
 * WordPress REST API publisher adapter.
 *
 * Uses Application Passwords over the WP REST API. Credentials (username +
 * application password) are stored encrypted server-side; `config` only holds
 * non-secret settings such as base_url and the display site name.
 */

import type {
  DataSourceConnectionResult,
  ProviderContext,
  ProviderDeps,
  PublishInput,
  PublisherProvider,
  PublishResult,
} from '@seo/contracts';

const CRED = { username: 'wordpress_username', appPassword: 'wordpress_application_password' } as const;

export interface WordPressPostResponse {
  id: number;
  link?: string;
  title?: { rendered?: string };
  status?: string;
}

export class WordPressError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'WordPressError';
  }
}

export class WordPressClient {
  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly appPassword: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private endpoint(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/wp-json/wp/v2${path}`;
  }

  private authHeaders(): Record<string, string> {
    return {
      authorization: `Basic ${Buffer.from(`${this.username}:${this.appPassword}`).toString('base64')}`,
      'content-type': 'application/json',
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(this.endpoint(path), {
      method,
      headers: this.authHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const message = (json.message as string) ?? `WordPress HTTP ${res.status}`;
      throw new WordPressError(message, res.status);
    }
    return json as T;
  }

  async whoami(): Promise<{ id: number; name?: string }> {
    return this.request('GET', '/users/me?context=edit');
  }

  async createPost(input: {
    title: string;
    content: string;
    status: 'publish' | 'draft';
    excerpt?: string;
    slug?: string;
    comment_status?: string;
  }): Promise<WordPressPostResponse> {
    return this.request('POST', '/posts', {
      title: input.title,
      content: input.content,
      status: input.status,
      excerpt: input.excerpt ?? '',
      slug: input.slug ?? undefined,
    });
  }

  async updatePost(id: string, input: Partial<{ title: string; content: string; status: string; excerpt: string; slug: string }>): Promise<WordPressPostResponse> {
    return this.request('POST', `/posts/${id}`, input);
  }

  async deletePost(id: string): Promise<void> {
    await this.request('DELETE', `/posts/${id}?force=true`);
  }
}

export class WordPressPublisher implements PublisherProvider {
  readonly id = 'wordpress';
  readonly name = 'WordPress';
  readonly description = 'Publish content to a WordPress site via its REST API';
  readonly capabilities = ['post', 'update', 'delete'] as const;

  constructor(private readonly deps: ProviderDeps) {}

  private async clientFor(ctx: ProviderContext): Promise<WordPressClient> {
    const baseUrl = (ctx.config.base_url as string) ?? (ctx.config.site_url as string);
    const username = await ctx.credentials.get(CRED.username);
    const appPassword = await ctx.credentials.get(CRED.appPassword);
    if (!baseUrl) throw new Error('WordPress site URL is not configured');
    if (!username || !appPassword) {
      throw new Error('WordPress credentials are missing; add the application password in Publishing settings');
    }
    return new WordPressClient(baseUrl, username, appPassword);
  }

  async connect(ctx: ProviderContext): Promise<DataSourceConnectionResult> {
    const client = await this.clientFor(ctx);
    const me = await client.whoami();
    return { ok: true, message: `Connected to WordPress as ${me.name ?? me.id}` };
  }

  async disconnect(): Promise<void> {
    // credentials deleted by caller (publisher store)
  }

  async testConnection(ctx: ProviderContext): Promise<{ ok: boolean; message?: string }> {
    const client = await this.clientFor(ctx);
    const me = await client.whoami();
    return { ok: true, message: `Authenticated as ${me.name ?? me.id}` };
  }

  async publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
    const client = await this.clientFor(ctx);
    const post = await client.createPost({
      title: input.title,
      content: input.content,
      status: input.status === 'draft' ? 'draft' : 'publish',
      excerpt: input.excerpt,
      slug: input.slug,
    });
    return { remoteId: String(post.id), url: post.link ?? null };
  }

  async update(ctx: ProviderContext, remoteId: string, input: PublishInput): Promise<PublishResult> {
    const client = await this.clientFor(ctx);
    const post = await client.updatePost(remoteId, {
      title: input.title,
      content: input.content,
      status: input.status === 'draft' ? 'draft' : 'publish',
      excerpt: input.excerpt,
      slug: input.slug,
    });
    return { remoteId: String(post.id), url: post.link ?? null };
  }

  async delete(ctx: ProviderContext, remoteId: string): Promise<void> {
    const client = await this.clientFor(ctx);
    await client.deletePost(remoteId);
  }
}
