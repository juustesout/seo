/**
 * Publisher capability helpers for the UI (Content Studio Phase H5 + H6.1).
 *
 * The UI never hardcodes a publisher id or vendor; it reasons about what a
 * publisher can do purely through the descriptor + stored capability tokens
 * that the catalog already exposes. Since Phase H6.1 each publication intent
 * (article / text / image / video) maps to exactly one capability, and the UI
 * only offers the kinds a selected publisher can actually carry.
 *
 * The provider catalog's `setup` descriptor also drives *how* the UI connects
 * a publisher: `auth: 'form'` renders credential fields that post through the
 * encrypted credentials endpoint, while `auth: 'oauth'` renders a
 * "Connect with <name>" button (see views/Publishing) that redirects through
 * the vendor consent screen. Consumers pick names/labels from the descriptor -
 * never from a hardcoded vendor table.
 */

import type { PublishContentKind } from '@seo/contracts';
import { normalizePublisherCapabilities, publisherCanPublishKind, publisherKindsFor } from '@seo/contracts';

/** Something that carries an optional stored capabilities snapshot (a publisher row). */
export interface CapabilitySource {
  capabilities?: string[];
}

/** Something that carries an optional registry/descriptor capabilities list. */
export interface DescriptorSource {
  capabilities?: string[];
}

/** Prefer the stored snapshot; fall back to the registry descriptor. */
export function effectiveCapabilities(publisher: CapabilitySource, descriptor?: DescriptorSource | null): string[] {
  const stored = publisher.capabilities;
  if (stored && stored.length > 0) return stored;
  return descriptor?.capabilities ?? [];
}

/** Whether a publisher can carry a publication intent of the given kind. */
export function canPublishKind(
  kind: PublishContentKind,
  publisher: CapabilitySource,
  descriptor?: DescriptorSource | null,
): boolean {
  return publisherCanPublishKind(kind, effectiveCapabilities(publisher, descriptor));
}

/** The canonical kinds a publisher can carry, in a stable order (article first). */
export function supportedPublishKinds(publisher: CapabilitySource, descriptor?: DescriptorSource | null): PublishContentKind[] {
  return publisherKindsFor(effectiveCapabilities(publisher, descriptor));
}

/** Best default intent for a publisher: its first supported kind (article first). */
export function defaultPublishKind(publisher: CapabilitySource, descriptor?: DescriptorSource | null): PublishContentKind {
  const kinds = supportedPublishKinds(publisher, descriptor);
  return kinds.length > 0 ? (kinds[0] ?? 'article') : 'article';
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

/** Labels for publication intents (what a user schedules/publishes as). */
export const PUBLISH_KIND_LABELS: Record<PublishContentKind, string> = {
  article: 'Article',
  text: 'Text post',
  image: 'Image',
  video: 'Video',
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
