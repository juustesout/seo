/**
 * Visual vocabulary contract tests (R4.1).
 *
 * Pins the three separate axes (role, intent, placement), their validators, the
 * accessibility/alt policy and the aspect preference the ranker consumes. These
 * are the shared language the Agent, editor and asset ranker all read, so the
 * values and their validation are asserted explicitly.
 */
import { describe, expect, it } from 'vitest';
import {
  VISUAL_ASSET_ROLES,
  VISUAL_DECORATIVE_ROLES,
  VISUAL_INSERTABLE_ROLES,
  VISUAL_INTENTS,
  VISUAL_PLACEMENTS,
  VISUAL_ROLE_DEFAULT_INTENT,
  VISUAL_ROLE_DEFAULT_PLACEMENT,
  isVisualInsertableRole,
  isValidAspectRatio,
  isValidVisualAssetRole,
  isValidVisualDesignIntent,
  isValidVisualIntent,
  isValidVisualPlacement,
  orientationOf,
  parseAspectRatio,
  visualAltTextForRole,
  visualAspectPreference,
  visualRoleRequiresDescriptiveAlt,
  type VisualDesignIntent,
} from './visualVocabulary.js';

function intent(over: Partial<VisualDesignIntent> = {}): VisualDesignIntent {
  return { role: 'inline', intent: 'reinforce', ...over };
}

describe('visual vocabulary', () => {
  it('keeps role, intent and placement as separate validated axes', () => {
    expect(VISUAL_ASSET_ROLES).toContain('hero');
    expect(VISUAL_ASSET_ROLES).toContain('background');
    expect(VISUAL_ASSET_ROLES).toContain('thumbnail');
    expect(VISUAL_INTENTS).toContain('atmosphere');
    expect(VISUAL_PLACEMENTS).toContain('full_bleed');
    expect(VISUAL_ASSET_ROLES).not.toContain('inline_image');
  });

  it('rejects invalid enum values', () => {
    expect(isValidVisualAssetRole('hero')).toBe(true);
    expect(isValidVisualAssetRole('cover')).toBe(false);
    expect(isValidVisualAssetRole(7)).toBe(false);
    expect(isValidVisualIntent('explain')).toBe(true);
    expect(isValidVisualIntent('inspire')).toBe(false);
    expect(isValidVisualPlacement('side_by_side')).toBe(true);
    expect(isValidVisualPlacement('floating')).toBe(false);
  });

  it('validates the intent as a bounded, discriminated structure', () => {
    expect(isValidVisualDesignIntent(intent())).toBe(true);
    expect(isValidVisualDesignIntent(intent({ placement: 'full_bleed', subject: 'Amsterdam canal' }))).toBe(true);
    expect(isValidVisualDesignIntent(intent({ aspectRatio: '16:9' }))).toBe(true);
    expect(isValidVisualDesignIntent(intent({ role: 'cover' as never }))).toBe(false);
    expect(isValidVisualDesignIntent(intent({ intent: 'inspire' as never }))).toBe(false);
    expect(isValidVisualDesignIntent(intent({ placement: 'floating' as never }))).toBe(false);
    expect(isValidVisualDesignIntent(intent({ aspectRatio: 'wide' }))).toBe(false);
    expect(isValidVisualDesignIntent({ ...intent(), extra: true } as never)).toBe(false);
    expect(isValidVisualDesignIntent(null)).toBe(false);
  });

  it('has a default placement and intent for every role (no string bags)', () => {
    for (const role of VISUAL_ASSET_ROLES) {
      expect(VISUAL_PLACEMENTS).toContain(VISUAL_ROLE_DEFAULT_PLACEMENT[role]);
      expect(VISUAL_INTENTS).toContain(VISUAL_ROLE_DEFAULT_INTENT[role]);
    }
  });
});

describe('visual accessibility semantics', () => {
  it('treats only decorative and background visuals as non-descriptive', () => {
    expect(VISUAL_DECORATIVE_ROLES).toEqual(['decorative', 'background']);
    expect(visualRoleRequiresDescriptiveAlt('decorative')).toBe(false);
    expect(visualRoleRequiresDescriptiveAlt('background')).toBe(false);
    expect(visualRoleRequiresDescriptiveAlt('inline')).toBe(true);
    expect(visualRoleRequiresDescriptiveAlt('illustration')).toBe(true);
    expect(visualRoleRequiresDescriptiveAlt('logo')).toBe(true);
  });

  it('drops alt text for decorative visuals and preserves it for content visuals', () => {
    expect(visualAltTextForRole('decorative', 'A subtle texture')).toBe('');
    expect(visualAltTextForRole('background', 'Canal at night')).toBe('');
    expect(visualAltTextForRole('inline', 'Solar panels on a roof')).toBe('Solar panels on a roof');
    expect(visualAltTextForRole('illustration', '', 'diagram.png')).toBe('diagram.png');
  });
});

describe('visual insertability', () => {
  it('declares only the roles the current canonical model can host', () => {
    expect(VISUAL_INSERTABLE_ROLES).toEqual(['inline', 'section', 'illustration', 'decorative']);
    expect(isVisualInsertableRole('inline')).toBe(true);
    expect(isVisualInsertableRole('illustration')).toBe(true);
    expect(isVisualInsertableRole('hero')).toBe(false);
    expect(isVisualInsertableRole('background')).toBe(false);
    expect(isVisualInsertableRole('thumbnail')).toBe(false);
  });
});

describe('visual aspect preferences', () => {
  it('parses bounded W:H ratios and rejects malformed ones', () => {
    expect(isValidAspectRatio('16:9')).toBe(true);
    expect(isValidAspectRatio('4:3')).toBe(true);
    expect(isValidAspectRatio('1:1')).toBe(true);
    expect(isValidAspectRatio('16x9')).toBe(false);
    expect(isValidAspectRatio('0:0')).toBe(true);
    expect(parseAspectRatio('16:9')).toBeCloseTo(1.777, 2);
    expect(parseAspectRatio('0:0')).toBeNull();
    expect(parseAspectRatio('wide')).toBeNull();
  });

  it('derives orientation from real dimensions only', () => {
    expect(orientationOf(1600, 900)).toBe('landscape');
    expect(orientationOf(900, 1600)).toBe('portrait');
    expect(orientationOf(1000, 1000)).toBe('square');
    expect(orientationOf(undefined, 900)).toBeNull();
    expect(orientationOf(0, 900)).toBeNull();
  });

  it('prefers a role default but lets an explicit aspect ratio win', () => {
    expect(visualAspectPreference({ role: 'hero' })).toEqual({ orientation: 'landscape', ratio: 16 / 9 });
    expect(visualAspectPreference({ role: 'avatar' })).toEqual({ orientation: 'square', ratio: 1 });
    expect(visualAspectPreference({ role: 'hero', aspectRatio: '4:3' })).toEqual({ ratio: 4 / 3 });
    expect(visualAspectPreference({ role: 'inline' })).toEqual({});
  });
});
