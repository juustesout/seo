/**
 * Provider registry - the platform's plugin surface.
 *
 * Built once at startup. New data sources / knowledge providers / publishers
 * are added here (or in future in a folder scanned for factories), never by
 * touching the SEO core or the UI.
 */

import type {
  ProviderDescriptor,
  ProviderLogger,
  ProviderRegistry,
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
  build: () => unknown;
}

class Registry implements ProviderRegistry {
  private entries = new Map<string, Entry>();
  private order: string[] = [];

  constructor(private readonly deps: RegistryBuildDeps) {}

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

  registerAI(factory: AIFactory, descriptor: Omit<ProviderDescriptor, 'kind'>): void {
    this.add({ descriptor: { ...descriptor, kind: 'ai' }, kind: 'ai', build: () => factory(this.deps) });
  }

  registerMedia(factory: MediaFactory, descriptor: Omit<ProviderDescriptor, 'kind'>): void {
    this.add({ descriptor: { ...descriptor, kind: 'media' }, kind: 'media', build: () => factory(this.deps) });
  }

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

  getPublisher(id: string) {
    const e = this.entries.get(id);
    if (!e || e.kind !== 'publisher') return undefined;
    return e.build() as ReturnType<PublisherFactory>;
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
  registry.registerPublisher(
    () => new WordPressPublisher({ config: deps.config, logger: deps.logger }),
    {
      id: 'wordpress',
      name: 'WordPress',
      description: 'Publish to a WordPress site via its REST API',
      capabilities: ['post', 'update', 'delete'],
      ui: { icon: 'globe', color: '#21759B' },
    },
  );

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
