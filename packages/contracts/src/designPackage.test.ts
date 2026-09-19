/**
 * Design Package v1 lifecycle (Stage 8E.6, ADR Phase 3).
 *
 * Behavioural contract tests for the portable package boundary: shape and
 * validation, deterministic serialization, export/import round trips, media/ID
 * hygiene, compatibility with the existing canonical/proposal contracts, and the
 * pure Designer proposal -> package adapter. No network, no service, no state.
 */
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_DOCUMENT_VERSION,
  isValidCanonicalDoc,
  type CanonicalDocument,
} from './canonical.js';
import { isValidCosmosDesign } from './cosmos.js';
import { isValidDesignerProposal, type DesignerProposal } from './designer.js';
import {
  DESIGN_PACKAGE_KIND,
  DESIGN_PACKAGE_VERSION,
  DesignPackageError,
  designPackageFromProposal,
  exportDesignPackage,
  importDesignPackage,
  isValidDesignAssetRef,
  isValidDesignPackage,
  isValidDesignPackageMetadata,
  portableDesignDocument,
  toPortableDesignPackage,
  type DesignPackage,
  type DesignPackageErrorCode,
  type DesignPackageMetadata,
} from './designPackage.js';

function canonicalDoc(): CanonicalDocument {
  return {
    version: CANONICAL_DOCUMENT_VERSION,
    meta: { title: 'Acme landing', language: 'en', designSystem: { id: 'cosmos' } },
    blocks: [
      { id: 'hero__title', type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Ship faster' }] },
      { id: 'hero__body', type: 'paragraph', content: [{ type: 'text', text: 'One platform.' }] },
    ],
  };
}

function metadata(): DesignPackageMetadata {
  return { id: 'pkg-1', name: 'Acme landing', createdAt: '2026-01-02T03:04:05.000Z' };
}

function basePackage(): DesignPackage {
  return {
    kind: DESIGN_PACKAGE_KIND,
    version: DESIGN_PACKAGE_VERSION,
    metadata: metadata(),
    document: canonicalDoc(),
    designSystem: { colors: { primary: '#112233' }, spacingScale: 'comfortable' },
  };
}

function validProposal(): DesignerProposal {
  return {
    version: 1,
    baseRevision: 'rev1:abc123',
    document: canonicalDoc(),
    plan: { version: 1, steps: [{ kind: 'designer.review', criteria: ['document_valid'] }] },
  };
}

function errorCodeOf(fn: () => unknown): DesignPackageErrorCode {
  try {
    fn();
  } catch (err) {
    if (err instanceof DesignPackageError) return err.code;
    throw err;
  }
  throw new Error('Expected a DesignPackageError');
}

describe('isValidDesignPackage metadata and assets', () => {
  it('accepts bounded metadata and rejects malformed metadata', () => {
    expect(isValidDesignPackageMetadata(metadata())).toBe(true);
    expect(isValidDesignPackageMetadata({ ...metadata(), description: 'ok', tags: ['a', 'b'] })).toBe(true);
    expect(isValidDesignPackageMetadata({ ...metadata(), id: 'not a slug' })).toBe(false);
    expect(isValidDesignPackageMetadata({ ...metadata(), name: '' })).toBe(false);
    expect(isValidDesignPackageMetadata({ ...metadata(), createdAt: 'yesterday' })).toBe(false);
    expect(isValidDesignPackageMetadata({ ...metadata(), tags: ['a', 'a'] })).toBe(false);
    expect(isValidDesignPackageMetadata({ ...metadata(), extra: true })).toBe(false);
  });

  it('accepts a portable asset ref without a project media id', () => {
    expect(isValidDesignAssetRef({ target: 'hero__media', kind: 'image', alt: 'shot' })).toBe(true);
    expect(isValidDesignAssetRef({ target: 'hero__media', kind: 'video' })).toBe(false);
    expect(isValidDesignAssetRef({ target: 'hero__media', kind: 'image', mediaId: 'p-123' })).toBe(false);
  });
});

describe('isValidDesignPackage shape', () => {
  it('accepts a minimal and a complete package', () => {
    expect(isValidDesignPackage(basePackage())).toBe(true);
    const complete: DesignPackage = {
      ...basePackage(),
      metadata: { ...metadata(), description: 'A landing page', tags: ['landing'] },
      plan: validProposal().plan,
      assets: [{ target: 'hero__media', kind: 'image', alt: 'Dashboard' }],
    };
    expect(isValidDesignPackage(complete)).toBe(true);
  });

  it('rejects missing required fields, wrong discriminator and unsupported version', () => {
    const { metadata: _m, ...withoutMetadata } = basePackage();
    const { document: _d, ...withoutDocument } = basePackage();
    const { designSystem: _s, ...withoutDesignSystem } = basePackage();
    expect(isValidDesignPackage(withoutMetadata)).toBe(false);
    expect(isValidDesignPackage(withoutDocument)).toBe(false);
    expect(isValidDesignPackage(withoutDesignSystem)).toBe(false);
    expect(isValidDesignPackage({ ...basePackage(), kind: 'something_else' })).toBe(false);
    expect(isValidDesignPackage({ ...basePackage(), version: 2 })).toBe(false);
    expect(isValidDesignPackage({ ...basePackage(), extra: 'nope' })).toBe(false);
  });

  it('rejects an invalid nested canonical document', () => {
    const badHeading: CanonicalDocument = {
      version: CANONICAL_DOCUMENT_VERSION,
      blocks: [{ type: 'heading', attrs: { level: 9 } }],
    };
    expect(isValidDesignPackage({ ...basePackage(), document: badHeading })).toBe(false);
    expect(isValidDesignPackage({ ...basePackage(), document: { version: 1, blocks: 'nope' } })).toBe(false);
  });

  it('rejects invalid package-specific data', () => {
    expect(isValidDesignPackage({ ...basePackage(), designSystem: { colors: { primary: 'red' } } })).toBe(false);
    expect(isValidDesignPackage({ ...basePackage(), designSystem: { unknown: true } })).toBe(false);
    expect(isValidDesignPackage({ ...basePackage(), designSystem: { spacingScale: 'huge' } })).toBe(false);
    expect(isValidDesignPackage({ ...basePackage(), plan: { version: 1, steps: [] } })).toBe(false);
    expect(
      isValidDesignPackage({
        ...basePackage(),
        assets: [
          { target: 'hero__media', kind: 'image' },
          { target: 'hero__media', kind: 'image' },
        ],
      }),
    ).toBe(false);
    expect(isValidDesignPackage({ ...basePackage(), assets: [{ target: 'hero__media', kind: 'video' }] })).toBe(false);
  });
});

describe('isValidCosmosDesign', () => {
  it('accepts empty and fully-specified designs, rejects off-contract values', () => {
    expect(isValidCosmosDesign({})).toBe(true);
    expect(
      isValidCosmosDesign({
        colors: { primary: '#fff', text: '#000000' },
        typography: { headingFamily: 'Inter', headingWeight: 700, headingScale: 'large', bodySize: 'md', lineHeight: 1.5 },
        spacingScale: 'spacious',
        radiusScale: 'small',
        elevation: 'subtle',
      }),
    ).toBe(true);
    expect(isValidCosmosDesign({ colors: { notAColor: '#fff' } })).toBe(false);
    expect(isValidCosmosDesign({ typography: { headingWeight: 999 } })).toBe(false);
    expect(isValidCosmosDesign({ radiusScale: 'round' })).toBe(false);
    expect(isValidCosmosDesign('nope')).toBe(false);
  });
});

describe('export / import lifecycle', () => {
  it('exports JSON-compatible data with stable version identity', () => {
    const raw = exportDesignPackage(basePackage());
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.kind).toBe(DESIGN_PACKAGE_KIND);
    expect(parsed.version).toBe(DESIGN_PACKAGE_VERSION);
    expect(parsed.document).toBeTruthy();
    expect(parsed.designSystem).toEqual({ colors: { primary: '#112233' }, spacingScale: 'comfortable' });
  });

  it('preserves meaningful data across a round trip', () => {
    const pkg: DesignPackage = {
      ...basePackage(),
      metadata: { ...metadata(), description: 'Portable', tags: ['landing'] },
      plan: validProposal().plan,
    };
    const imported = importDesignPackage(exportDesignPackage(pkg));
    expect(imported.metadata).toEqual(pkg.metadata);
    expect(imported.document).toEqual(pkg.document);
    expect(imported.designSystem).toEqual(pkg.designSystem);
    expect(imported.plan).toEqual(pkg.plan);
  });

  it('is byte-stable across a round trip (deterministic serialization)', () => {
    const first = exportDesignPackage(basePackage());
    const second = exportDesignPackage(importDesignPackage(first));
    expect(second).toBe(first);
  });

  it('omits absent optional fields consistently', () => {
    const parsed = JSON.parse(exportDesignPackage(basePackage())) as Record<string, unknown>;
    expect('plan' in parsed).toBe(false);
    expect('assets' in parsed).toBe(false);
    const emptyAssets = JSON.parse(exportDesignPackage({ ...basePackage(), assets: [] })) as Record<string, unknown>;
    expect('assets' in emptyAssets).toBe(false);
  });

  it('never carries a project-scoped media id or CMS source, recording an asset ref', () => {
    const document: CanonicalDocument = {
      version: CANONICAL_DOCUMENT_VERSION,
      blocks: [
        {
          id: 'hero__media',
          type: 'image',
          attrs: {
            mediaId: '11111111-1111-1111-1111-111111111111',
            src: 'https://cdn.example.com/shot.png',
            alt: 'Dashboard',
            caption: 'The dashboard',
          },
          source: { cms: 'tiptap', type: 'image' },
        },
      ],
    };
    const token = exportDesignPackage({ ...basePackage(), document });
    const parsed = JSON.parse(token) as { document: CanonicalDocument; assets: unknown };
    const block = parsed.document.blocks[0]!;
    expect(block.attrs?.mediaId).toBeUndefined();
    expect(block.attrs?.src).toBeUndefined();
    expect(block.attrs?.alt).toBe('Dashboard');
    expect(block.source).toBeUndefined();
    expect(parsed.assets).toEqual([{ target: 'hero__media', kind: 'image', alt: 'Dashboard', caption: 'The dashboard' }]);

    const imported = importDesignPackage(token);
    expect(imported.assets).toEqual([
      { target: 'hero__media', kind: 'image', alt: 'Dashboard', caption: 'The dashboard' },
    ]);
  });

  it('leaves the source document untouched and sorts collected assets', () => {
    const document: CanonicalDocument = {
      version: CANONICAL_DOCUMENT_VERSION,
      blocks: [
        { id: 'b', type: 'image', attrs: { mediaId: 'm-b' }, source: { cms: 'tiptap' } },
        { id: 'a', type: 'image', attrs: { src: 'https://example.com/a.png' } },
      ],
    };
    const original = JSON.parse(JSON.stringify(document)) as CanonicalDocument;
    const { assets } = portableDesignDocument(document);
    expect(assets.map((asset) => asset.target)).toEqual(['b', 'a']);
    expect(document).toEqual(original);

    const token = exportDesignPackage({ ...basePackage(), document });
    const parsed = JSON.parse(token) as { assets: Array<{ target: string }> };
    expect(parsed.assets.map((asset) => asset.target)).toEqual(['a', 'b']);
  });

  it('rejects malformed JSON deterministically', () => {
    expect(errorCodeOf(() => importDesignPackage('{ not json'))).toBe('invalid_design_package_json');
  });

  it('rejects a wrong discriminator, unsupported version and invalid shape by code', () => {
    const valid = JSON.parse(exportDesignPackage(basePackage())) as Record<string, unknown>;
    expect(errorCodeOf(() => importDesignPackage(JSON.stringify({ ...valid, kind: 'other' })))).toBe(
      'invalid_design_package',
    );
    expect(errorCodeOf(() => importDesignPackage(JSON.stringify({ ...valid, version: 2 })))).toBe(
      'unsupported_design_package_version',
    );
    expect(errorCodeOf(() => importDesignPackage(JSON.stringify({ ...valid, document: { version: 1, blocks: 'x' } })))).toBe(
      'invalid_design_package',
    );
    expect(errorCodeOf(() => importDesignPackage(JSON.stringify('a string')))).toBe('invalid_design_package');
    expect(errorCodeOf(() => exportDesignPackage({ kind: 'other' }))).toBe('invalid_design_package');
  });

  it('is idempotent under export(toPortable(package))', () => {
    const pkg = { ...basePackage(), assets: [{ target: 'keep__media', kind: 'image' as const }] };
    const once = exportDesignPackage(pkg);
    const twice = exportDesignPackage(toPortableDesignPackage(importDesignPackage(once)));
    expect(twice).toBe(once);
  });
});

describe('Designer integration', () => {
  it('represents a valid Designer proposal without changing canonical meaning', () => {
    const proposal = validProposal();
    const pkg = designPackageFromProposal(proposal, {
      metadata: metadata(),
      designSystem: { colors: { primary: '#112233' } },
    });
    expect(isValidDesignPackage(pkg)).toBe(true);
    expect(pkg.document).toEqual(proposal.document);
    expect(pkg.plan).toEqual(proposal.plan);
    expect(pkg.document.meta?.designSystem).toEqual({ id: 'cosmos' });
  });

  it('omits the plan when the proposal has none', () => {
    const proposal: DesignerProposal = { ...validProposal() };
    delete proposal.plan;
    const pkg = designPackageFromProposal(proposal, { metadata: metadata(), designSystem: {} });
    expect('plan' in pkg).toBe(false);
  });

  it('rejects an invalid proposal or invalid options through the contract boundary', () => {
    expect(errorCodeOf(() => designPackageFromProposal({ version: 1 }, { metadata: metadata(), designSystem: {} }))).toBe(
      'invalid_designer_proposal',
    );
    expect(
      errorCodeOf(() =>
        designPackageFromProposal(validProposal(), {
          metadata: metadata(),
          designSystem: { colors: { primary: 'red' } },
        }),
      ),
    ).toBe('invalid_design_package');
  });
});

describe('backwards compatibility', () => {
  it('keeps existing canonical documents and proposals valid', () => {
    expect(isValidCanonicalDoc(canonicalDoc())).toBe(true);
    expect(isValidDesignerProposal(validProposal())).toBe(true);
  });
});
