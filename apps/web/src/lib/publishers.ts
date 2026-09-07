/**
 * Publisher capability helpers for the UI (Content Studio Phase H5).
 *
 * The UI never hardcodes a publisher id or vendor; it reasons about what a
 * publisher can do purely through the descriptor + stored capability tokens
 * that the catalog already exposes.
 */

import type { PublishContentKind } from '@seo/contracts';
import { normalizePublisherCapabilities, publisherCanPublishContent } from '@seo/contracts';

export interface CapabilitySource {
  capabilities?: string[];
}

export interface DescriptorSource {
  capabilities?: string[];
}

/** Prefer the stored snapshot; fall back to the registry descriptor. */
export function effectiveCapabilities(publisher: CapabilitySource, descriptor?: DescriptorSource | null): string[] {
  const stored = publisher.capabilities;
  if (stored && stored.length > 0) return stored;
  return descriptor?.capabilities ?? [];
}

/** Whether a publisher can carry content of the given kind (article/text/image/video). */
export function canPublishContentKind(
  kind: PublishContentKind,
  publisher: CapabilitySource,
  descriptor?: DescriptorSource | null,
): boolean {
  return publisherCanPublishContent(kind, effectiveCapabilities(publisher, descriptor));
}

export const PUBLISHER_CAPABILITY_LABELS: Record<string, string> = {
  publish_article: 'Article',
  publish_text: 'Text',
  publish_image: 'Image',
  publish_video: 'Video',
  update: 'Update',
  delete: 'Delete',
  schedule: 'Scheduled',
};

/** Canonical capability tokens for display (legacy aliases expanded, unknown dropped). */
export function publisherCapabilityChips(declared: string[] | undefined): string[] {
  const out: string[] = [];
  for (const cap of normalizePublisherCapabilities(declared ?? [])) {
    const label = PUBLISHER_CAPABILITY_LABELS[cap] ?? cap;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** Human label for a publisher category hint (website / social / ...). */
export function categoryLabel(category?: string): string | null {
  if (!category) return null;
  if (category === 'website') return 'Website channel';
  if (category === 'social') return 'Social channel';
  return category;
}
