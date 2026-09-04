/**
 * EmbeddingService (SEO Core).
 *
 * Produces an Embedder bound to a project's effective AI configuration so the
 * content agent, knowledge tooling and future MCP tools can embed text with
 * the same per-project BYOK resolution used for chat/generation. When the
 * project AI provider is not configured for embeddings this reports itself as
 * "not configured" - it never invents vectors.
 */

import type { AIProvider } from '@seo/contracts';
import { AIService } from './aiService.js';
import { dimensionsForModel, type Embedder } from '../providers/knowledge/embedding.js';

/** OpenAI-compatible model embedding dimension table (unknown -> 1536). */

export class ProjectEmbedder implements Embedder {
  readonly dimensions: number;

  constructor(
    private readonly provider: AIProvider,
    private readonly model: string,
  ) {
    this.dimensions = dimensionsForModel(model);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const result = await this.provider.embed({ input: texts, model: this.model });
    return result.vectors;
  }
}

export class EmbeddingService {
  constructor(private readonly ai: AIService) {}

  /** Embedder honoring the project's BYOK OpenAI credentials + model choice. */
  async embedderFor(projectId: string): Promise<Embedder> {
    const status = await this.ai.status(projectId);
    if (!status.configured) {
      throw new Error(
        'No AI provider is configured for this project (add a project key or server OPENAI_API_KEY)',
      );
    }
    const resolved = await this.ai.resolve(projectId);
    const provider = resolved.provider;
    if (!provider.capabilities.includes('embed')) {
      throw new Error(`AI provider ${provider.id} does not support embeddings`);
    }
    return new ProjectEmbedder(provider, status.embeddingModel);
  }
}
