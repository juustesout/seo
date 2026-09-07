/**
 * Provider registry - the platform's plugin surface.
 *
 * Built once at startup (buildRegistry) and handed to the rest of the app as
 * the read-only ProviderRegistry contract. New data sources / knowledge
 * providers / publishers / AI / media providers are added here (or in a future
 * folder scanned for factories), never by touching the SEO core or the UI.
 *
 * Design decisions baked into this file:
 *
 * - Providers are *registered as factories*, not instances. Every `get*()` call
 *   builds a fresh adapter. Adapters are therefore required to be stateless:
 *   anything they need for one call (credentials, project config, logger) is
 *   passed per call through ProviderContext, never cached across calls. This
 *   keeps concurrent requests for different projects isolated.
 * - All entries share one id-keyed map, so provider ids must be unique across
 *   *all* kinds (a duplicate id anywhere is a startup error, even if the kinds
 *   differ). The `kind` field lets getters filter and the catalog list by kind.
 * - `order` preserves registration order so the UI catalog lists providers in a
 *   deterministic, human-curated order rather than map-insertion of an
 *   undefined variant.
 * - Publisher OAuth connectors live in a *separate* map, not in `entries`: a
 *   connector is not a PublisherProvider (it has no publish/update/delete and
 *   no descriptor of its own). It is keyed by the providerId of the publisher
 *   it belongs to and resolved through getPublisherOAuth().
 * - The descriptor served to the UI (list*) carries capabilities and setup
 *   hints, never secrets. Secrets only ever exist inside a credential store.
 */

import type {
  ProviderDescriptor,
  ProviderLogger,
  ProviderRegistry,
  ProviderDeps,
  PublisherOAuthConnector,
  DataSourceFactory,
  KnowledgeFactory,
  PublisherFactory,
  AIFactory,
  MediaFactory,
} from '@seo/contracts';
import { GscDataSource } from './gsc/gscDataSource.js';
import { DataForSeoDataSource } from './dataforseo/dataSource.js';
import { QdrantKnowledgeProvider } from './qdrantKnowledge.js';
import { WordPressPublisher } from './wordpress.js';
import { MockSocialPublisher } from './social/mockSocial.js';
import { XPublisher } from './social/xPublisher.js';
import { XOAuthConnector } from './social/xOAuth.js';
import { OpenAIProvider } from './ai/openai.js';
import { OpenAiMediaProvider } from './media/openaiMedia.js';
import { UnsplashMediaProvider } from './media/unsplash.js';


export interface RegistryBuildDeps {
  config: Record<string, string | undefined>;
  logger: ProviderLogger;
}

interface Entry {
  descriptor: ProviderDescriptor;
  kind: 'datasource' | 'knowledge' | 'publisher' | 'ai' | 'media';
  /** Factory closure that produces a fresh adapter instance on every get. */
  build: () => unknown;
}

class Registry implements ProviderRegistry {
  private entries = new Map<string, Entry>();
  private order: string[] = [];
  private oauthConnectors = new Map<string, (deps: ProviderDeps) => PublisherOAuthConnector>();

  constructor(private readonly deps: RegistryBuildDeps) {}

  /**
   * Shared registration path: rejects duplicate ids (across all kinds) before
   * anything else can observe an inconsistent catalog, then keeps insertion
   * order for stable UI listing.
   */
  private add(entry: Entry) {
    if (this.entries.has(entry.descriptor.id)) {
      throw new Error(`Duplicate provider id registered: ${entry.descriptor.id}`);
    }
    this.entries.set(entry.descriptor.id, entry);
    this.order.push(entry.descriptor.id);
  }

  registerDataSource(factory: DataSourceFactory, descriptor: Omit<ProviderDescriptor, 'kind'>): void {
    this.add({ descriptor: { ...descriptor, kind: 'datasource' }, kind: 'datasource', build: () => factory(this.deps) });
  }

  registerKnowledge(factory: KnowledgeFactory, descriptor: Omit<ProviderDescriptor, 'kind'>): void {
    this.add({ descriptor: { ...descriptor, kind: 'knowledge' }, kind: 'knowledge', build: () => factory(this.deps) });
  }

  registerPublisher(factory: PublisherFactory, descriptor: Omit<ProviderDescriptor, 'kind'>): void {
    this.add({ descriptor: { ...descriptor, kind: 'publisher' }, kind: 'publisher', build: () => factory(this.deps) });
  }

  registerPublisherOAuth(factory: (deps: ProviderDeps) => PublisherOAuthConnector, providerId: string): void {
    if (this.oauthConnectors.has(providerId)) {
      throw new Error(`Duplicate publisher OAuth connector registered: ${providerId}`);
    }
    this.oauthConnectors.set(providerId, factory);
  }

  registerAI(factory: AIFactory, descriptor: Omit<ProviderDescriptor, 'kind'>): void {
    this.add({ descriptor: { ...descriptor, kind: 'ai' }, kind: 'ai', build: () => factory(this.deps) });
  }

  registerMedia(factory: MediaFactory, descriptor: Omit<ProviderDescriptor, 'kind'>): void {
    this.add({ descriptor: { ...descriptor, kind: 'media' }, kind: 'media', build: () => factory(this.deps) });
  }

  /**
   * Resolve a provider by id. Each call constructs a fresh adapter from the
   * stored factory; the returned instance carries no request state, so callers
   * can safely hand it to a route handler or a worker executor without fear of
   * cross-request leakage. Returns undefined when the id is unknown or was
   * registered under a different kind (callers turn that into a 404-style
   * "provider not configured" outcome, never a crash).
   */
  getDataSource(id: string) {
    const e = this.entries.get(id);
    if (!e || e.kind !== 'datasource') return undefined;
    return e.build() as ReturnType<DataSourceFactory>;
  }

  getKnowledge(id: string) {
    const e = this.entries.get(id);
    if (!e || e.kind !== 'knowledge') return undefined;
    return e.build() as ReturnType<KnowledgeFactory>;
  }

  /** Resolve a publisher adapter by id (same stateless-per-call contract as getDataSource). */
  getPublisher(id: string) {
    const e = this.entries.get(id);
    if (!e || e.kind !== 'publisher') return undefined;
    return e.build() as ReturnType<PublisherFactory>;
  }

  /**
   * Resolve the OAuth connector bound to a publisher provider id. Connectors
   * are not catalog entries (no descriptor, no publish surface) - see the file
   * header for why they are tracked in their own map.
   */
  getPublisherOAuth(id: string): PublisherOAuthConnector | undefined {
    const factory = this.oauthConnectors.get(id);
    if (!factory) return undefined;
    return factory(this.deps);
  }

  getAI(id: string) {
    const e = this.entries.get(id);
    if (!e || e.kind !== 'ai') return undefined;
    return e.build() as ReturnType<AIFactory>;
  }

  getMedia(id: string) {
    const e = this.entries.get(id);
    if (!e || e.kind !== 'media') return undefined;
    return e.build() as ReturnType<MediaFactory>;
  }

  listDataSources() {
    return this.order
      .filter((id) => this.entries.get(id)?.kind === 'datasource')
      .map((id) => this.entries.get(id)!.descriptor) as ProviderDescriptor<'datasource'>[];
  }

  listKnowledge() {
    return this.order
      .filter((id) => this.entries.get(id)?.kind === 'knowledge')
      .map((id) => this.entries.get(id)!.descriptor) as ProviderDescriptor<'knowledge'>[];
  }

  listPublishers() {
    return this.order
      .filter((id) => this.entries.get(id)?.kind === 'publisher')
      .map((id) => this.entries.get(id)!.descriptor) as ProviderDescriptor<'publisher'>[];
  }

  listAI() {
    return this.order
      .filter((id) => this.entries.get(id)?.kind === 'ai')
      .map((id) => this.entries.get(id)!.descriptor) as ProviderDescriptor<'ai'>[];
  }

  listMedia() {
    return this.order
      .filter((id) => this.entries.get(id)?.kind === 'media')
      .map((id) => this.entries.get(id)!.descriptor) as ProviderDescriptor<'media'>[];
  }
}

export function buildRegistry(deps: RegistryBuildDeps): ProviderRegistry {
  const registry = new Registry(deps);

  // -- Data sources ---------------------------------------------------------
  registry.registerDataSource(
    () => new GscDataSource({ config: deps.config, logger: deps.logger }),
    {
      id: 'gsc',
      name: 'Google Search Console',
      description: 'Search performance, queries and pages',
      capabilities: ['keywords', 'pages', 'performance'],
      ui: { icon: 'search', color: '#4285F4' },
    },
  );
  registry.registerDataSource(
    () => new DataForSeoDataSource({ config: deps.config, logger: deps.logger }),
    {
      id: 'dataforseo',
      name: 'DataForSEO',
      description: 'SERP tracking, keyword research and competitors',
      capabilities: ['keywords', 'rankings', 'serp', 'competitors'],
      ui: { icon: 'bar-chart', color: '#0F172A' },
    },
  );

  // -- Knowledge providers --------------------------------------------------
  registry.registerKnowledge(
    () => new QdrantKnowledgeProvider({ config: deps.config, logger: deps.logger }),
    {
      id: 'qdrant',
      name: 'Qdrant',
      description: 'Project-scoped vector knowledge base',
      capabilities: ['index', 'search', 'update', 'delete'],
      ui: { icon: 'database', color: '#EF4444' },
    },
  );

  // -- Publishers -----------------------------------------------------------
  //
  // Adapter contract applied to every publisher below:
  //   - `capabilities` is the *truthful* declaration of what the adapter can do
  //     with a real remote platform. It drives both the UI (only offered
  //     actions show up) and server-side gating (publish_kind is authorized
  //     only against the exact publish_* token, see publisherCanPublishKind).
  //     Declaring a capability implies a live implementation, never a stub.
  //   - publish() may resolve only after the remote platform confirmed the
  //     post/object exists (it returns the platform's remoteId + url, or a
  //     url of null for channels that expose none). It must never fabricate
  //     success when the remote call failed - a failure surfaces as a
  //     PublisherError so the job/publication history records the truth.
  //   - Credentials are read per call from ctx.credentials (encrypted store),
  //     never from config or environment, and never cross to the browser.
  //
  // WordPress: full article lifecycle via its REST API. Because it can create,
  // update and delete remote posts it declares publish_article + update +
  // delete. Setup is a form (username + application password over Basic auth),
  // which is why the registry registers no OAuth connector for it.
  registry.registerPublisher(
    () => new WordPressPublisher({ config: deps.config, logger: deps.logger }),
    {
      id: 'wordpress',
      name: 'WordPress',
      description: 'Publish to a WordPress site via its REST API',
      capabilities: ['publish_article', 'update', 'delete'],
      ui: { icon: 'globe', color: '#21759B' },
      setup: {
        category: 'website',
        config: [{ key: 'base_url', label: 'Site URL (REST root)', type: 'url', placeholder: 'https://example.com' }],
        credentials: [
          { key: 'wordpress_username', label: 'Username', type: 'text', placeholder: 'username' },
          { key: 'wordpress_application_password', label: 'Application password', type: 'password', placeholder: 'application password' },
        ],
      },
    },
  );

  // X social channel (Content Studio Phase H6.2): real OAuth connect + live
  // text posting. The UI shows a "Connect with X" consent button (auth: oauth)
  // and the adapter posts through the real X API; update/delete stay honest
  // "not available" because they are out of scope.
  registry.registerPublisher(
    () => new XPublisher({ config: deps.config, logger: deps.logger }),
    {
      id: 'x',
      name: 'X',
      description: 'Publish short text posts to X via its OAuth-connected API',
      capabilities: ['publish_text', 'schedule'],
      ui: { icon: 'share', color: '#000000' },
      setup: {
        category: 'social',
        auth: 'oauth',
        note: 'Connects through X OAuth (read + write). Live posting requires the server to be configured with X_OAUTH_CLIENT_ID.',
      },
    },
  );
  registry.registerPublisherOAuth(
    (deps2) => new XOAuthConnector({ config: deps2.config, logger: deps2.logger, fetchFn: deps2.fetchFn }),
    'x',
  );

  // Demo/test social channel. Registered only when the server explicitly opts
  // in (ENABLE_TEST_PUBLISHERS=true) so it never appears in a production
  // catalog by default; it never calls an external platform.
  if (deps.config.ENABLE_TEST_PUBLISHERS === 'true') {
    registry.registerPublisher(
      () => new MockSocialPublisher({ config: deps.config, logger: deps.logger }),
      {
        id: 'mock_social',
        name: 'Social demo (mock)',
        description: 'Demo social channel for testing the publishing pipeline - no external network calls',
        capabilities: ['publish_text'],
        ui: { icon: 'share', color: '#6B7280' },
        setup: {
          category: 'social',
          note: 'Test/demo provider. It never reaches an external platform and is meant to exercise schedules, jobs and publication history.',
        },
      },
    );
  }

  // -- AI providers ---------------------------------------------------------
  registry.registerAI(
    () => new OpenAIProvider({ config: deps.config, logger: deps.logger }),
    {
      id: 'openai',
      name: 'OpenAI',
      description: 'Chat, generation and embeddings (BYOK)',
      capabilities: ['chat', 'generate', 'embed', 'models'],
      ui: { icon: 'sparkles', color: '#10A37F' },
    },
  );

  // -- Media providers ------------------------------------------------------
  registry.registerMedia(
    () => new OpenAiMediaProvider({ config: deps.config, logger: deps.logger }),
    {
      id: 'openai_media',
      name: 'OpenAI images',
      description: 'Generate images from a prompt',
      capabilities: ['generate'],
      ui: { icon: 'image', color: '#10A37F' },
    },
  );
  registry.registerMedia(
    () => new UnsplashMediaProvider({ config: deps.config, logger: deps.logger }),
    {
      id: 'unsplash',
      name: 'Unsplash',
      description: 'Stock photo search',
      capabilities: ['search'],
      ui: { icon: 'image', color: '#111' },
    },
  );

  return registry;
}
