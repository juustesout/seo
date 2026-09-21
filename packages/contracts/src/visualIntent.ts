/**
 * Context-aware visual intent resolution (R4.1).
 *
 * Converts an editor instruction plus editor context into a typed
 * `VisualDesignIntent` from the shared vocabulary, or an explicit uncertainty
 * result. Deterministic rules handle the obvious cases; nothing here calls a
 * model, and nothing here mutates a document.
 *
 * The resolver is deliberately conservative:
 *   - An explicit role word in the instruction always wins over a contextual
 *     guess; an explicit intent/placement word overrides the role default.
 *   - A selected hero/section host in the editor can suggest a role when the
 *     instruction names none.
 *   - When several roles are named, or when a purpose is named but no role can
 *     be justified, the result is `needs_clarification` with explicit candidates
 *     rather than a silent pick. Uncertainty is represented, not hidden.
 *   - When nothing visual can be justified at all, the result is `unsupported`.
 *
 * It reuses the R3.1 image-instruction classifier for the generic "add an image
 * here" case, so an ordinary image request resolves to an inline/reinforce
 * intent exactly as the insertion slice already behaves.
 *
 * Dependency-free by convention: plain types plus hand-rolled guards.
 */

import { isImageInsertionInstruction, type ImageInsertionContext } from './imageInsertion.js';
import {
  VISUAL_ROLE_DEFAULT_INTENT,
  VISUAL_ROLE_DEFAULT_PLACEMENT,
  VISUAL_REASON_MAX_CHARS,
  isValidAspectRatio,
  isValidVisualDesignIntent,
  isVisualInsertableRole,
  visualRoleRequiresDescriptiveAlt,
  type VisualAssetRole,
  type VisualDesignIntent,
  type VisualIntent,
  type VisualPlacement,
} from './visualVocabulary.js';

/**
 * The uncertainty model. A resolved intent is usable; a clarification carries the
 * plausible candidates and a product-language question; an unsupported request
 * carries a short reason. Callers must branch on `status`, never guess.
 */
export type VisualIntentResolution =
  | { status: 'resolved'; intent: VisualDesignIntent }
  | { status: 'needs_clarification'; candidates: VisualDesignIntent[]; question: string }
  | { status: 'unsupported'; reason: string };

/** Context the resolver may read. A structural subset of the transmitted context. */
export type VisualIntentContext = Pick<
  ImageInsertionContext,
  'targetNodeType' | 'selectedText' | 'nearbyText' | 'documentTitle' | 'sectionHeading' | 'language'
>;

interface RoleSignal {
  role: VisualAssetRole;
  pattern: RegExp;
}

/**
 * Explicit role words, checked in precedence order. Patterns are localized
 * (Dutch + English) and anchored where a short token could otherwise match an
 * unrelated word (e.g. `icon` inside `iconic`).
 */
const ROLE_SIGNALS: readonly RoleSignal[] = [
  { role: 'hero', pattern: /\bhero\b|header\s?(image|afbeelding)|banner|masthead|kopafbeelding/ },
  { role: 'background', pattern: /achtergrond|background|backdrop/ },
  { role: 'illustration', pattern: /illustrat|diagram|infograf|\bschema\b|visual explanation|concept ?graphic/ },
  { role: 'icon', pattern: /\bicoon\b|\bicon\b|pictogram/ },
  { role: 'logo', pattern: /\blogo\b|beeldmerk/ },
  { role: 'thumbnail', pattern: /thumbnail|miniatuur|kaartafbeelding/ },
  { role: 'avatar', pattern: /\bavatar\b|profielfoto|portretfoto/ },
  { role: 'decorative', pattern: /decorat|versier|ornament/ },
  { role: 'section', pattern: /\bsectie\b|\bsection\b|sectieafbeelding|ondersteunende afbeelding/ },
  { role: 'inline', pattern: /\binline\b|in de (lopende )?tekst/ },
];

/**
 * Explicit plural image nouns and multi-quantity words. R4.2 can place one image
 * per request, so a request that clearly asks for several is clarified rather
 * than silently satisfied with one. Localized (Dutch + English).
 */
const PLURAL_IMAGE_RE = /\b(beelden|afbeeldingen|foto's|fotos|illustraties|images|pictures|photos)\b/;
const MULTI_QUANTITY_RE = /\b(meerdere|multiple|several|twee|two|drie|three|gallerie|gallery)\b/;

interface IntentSignal {
  intent: VisualIntent;
  pattern: RegExp;
}

/**
 * Purpose words. When several match, the first in this list wins; purpose never
 * changes which host a visual needs, so it never forces a clarification on its
 * own.
 */
const INTENT_SIGNALS: readonly IntentSignal[] = [
  { intent: 'explain', pattern: /leg (dit |dat |het )?uit|uitleg|verduidelijk|\bexplain\b/ },
  { intent: 'emphasis', pattern: /benadruk|emphasis|accent|sterker|\bstronger\b|prominent/ },
  { intent: 'atmosphere', pattern: /sfeer|atmosfeer|\batmosphere\b|rustig|\bcalm\b|\bsubtle\b/ },
  { intent: 'attention', pattern: /aandacht|\battention\b|\bguide\b|\bfocus\b/ },
  { intent: 'context', pattern: /achtergrondinformatie|\bcontext\b/ },
  { intent: 'brand', pattern: /\bbrand\b|\bmerk\b|huisstijl|\bbranded\b/ },
  { intent: 'decoration', pattern: /decorat|versier|ornament/ },
  { intent: 'reinforce', pattern: /versterk|ondersteun|\breinforce\b|\bsupport\b/ },
];

interface PlacementSignal {
  placement: VisualPlacement;
  pattern: RegExp;
}

/** Explicit layout words, checked before the role default. */
const PLACEMENT_SIGNALS: readonly PlacementSignal[] = [
  { placement: 'full_bleed', pattern: /full[- ]?bleed|volledige breedte|hele breedte/ },
  { placement: 'side_by_side', pattern: /naast|side[- ]?by[- ]?side/ },
  { placement: 'card', pattern: /\bcard\b|\bkaart\b|thumbnail|miniatuur/ },
  { placement: 'overlay', pattern: /overlay|over de afbeelding/ },
  { placement: 'contained', pattern: /contained|in een kader|omlijnd/ },
  { placement: 'inline', pattern: /\binline\b|in de (lopende )?tekst/ },
];

/**
 * Maps a canonical/editor node type onto a role when the instruction names none.
 * Only the hosts that actually carry a role meaning are recognized; anything
 * unknown leaves the decision to the instruction/default rather than guessing.
 */
export function visualRoleFromNodeType(nodeType: string | undefined): VisualAssetRole | null {
  if (!nodeType) return null;
  const value = nodeType.toLowerCase();
  if (value.includes('hero')) return 'hero';
  if (value.includes('section')) return 'section';
  if (value.includes('heading')) return 'section';
  return null;
}

function normalized(value: string | undefined): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function bounded(value: string, max = VISUAL_REASON_MAX_CHARS): string {
  return value.length > max ? value.slice(0, max) : value;
}

function findExplicitAspectRatio(instruction: string): string | undefined {
  const match = instruction.match(/\b(\d{1,4}):(\d{1,4})\b/);
  if (!match) return undefined;
  const ratio = `${match[1]}:${match[2]}`;
  return isValidAspectRatio(ratio) ? ratio : undefined;
}

function buildIntent(role: VisualAssetRole, intent: VisualIntent, placement: VisualPlacement, context: VisualIntentContext, instruction: string): VisualDesignIntent {
  const subject = normalized(context.selectedText) || normalized(context.sectionHeading);
  const aspectRatio = findExplicitAspectRatio(instruction);
  const result: VisualDesignIntent = {
    role,
    intent,
    placement,
    accessibilityRequired: visualRoleRequiresDescriptiveAlt(role),
    ...(subject ? { subject: subject.slice(0, 160) } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
  };
  return isValidVisualDesignIntent(result) ? result : { role, intent, placement };
}

/**
 * Resolves an instruction plus editor context into a typed visual intent.
 * Pure and deterministic: the same instruction and context always produce the
 * same resolution. Never mutates content and never calls a provider.
 */
export function resolveVisualDesignIntent(instruction: string, context: VisualIntentContext): VisualIntentResolution {
  const text = normalized(instruction).toLowerCase();
  if (text.length === 0) return { status: 'unsupported', reason: 'empty_instruction' };

  const matchedRoles = ROLE_SIGNALS.filter((signal) => signal.pattern.test(text)).map((signal) => signal.role);
  // `section` can be a location word ("...aan deze sectie") rather than the
  // requested role. When exactly one other explicit role is named, that role
  // wins; only genuinely competing roles force a clarification.
  const nonSectionRoles = [...new Set(matchedRoles.filter((role) => role !== 'section'))];
  const roles = nonSectionRoles.length === 1 ? nonSectionRoles : matchedRoles;

  // R4.3: a hero and a background are different hosts with different placements.
  // The pair cannot be satisfied by one visual, and reinterpreting it as a single
  // full-bleed image would silently downgrade the request, so it is reported
  // unsupported rather than guessed at.
  if (roles.includes('hero') && roles.includes('background')) {
    return { status: 'unsupported', reason: 'hero_background_unsupported' };
  }

  // R4.2 can place one image per request. A clearly plural/multi request is
  // clarified instead of silently resolved to a single image.
  const pluralImage = PLURAL_IMAGE_RE.test(text);
  const multiQuantity = MULTI_QUANTITY_RE.test(text);
  if (pluralImage || (multiQuantity && (isImageInsertionInstruction(instruction) || roles.length > 0))) {
    const candidates = (roles.length > 0 ? roles : (['section', 'inline'] as const)).map((role) =>
      buildIntent(role, resolveIntentWord(text, role), VISUAL_ROLE_DEFAULT_PLACEMENT[role], context, instruction),
    );
    return {
      status: 'needs_clarification',
      candidates,
      question: 'I can add one image at a time. Which single image should I add here?',
    };
  }

  if (roles.length > 1) {
    const candidates = roles.map((role) =>
      buildIntent(role, resolveIntentWord(text, role), VISUAL_ROLE_DEFAULT_PLACEMENT[role], context, instruction),
    );
    const names = roles.join(' or ');
    return {
      status: 'needs_clarification',
      candidates,
      question: bounded(`Which visual did you mean: a ${names}?`),
    };
  }

  let role: VisualAssetRole;
  if (roles.length === 1) {
    role = roles[0]!;
  } else {
    const hinted = visualRoleFromNodeType(context.targetNodeType);
    if (hinted) {
      role = hinted;
    } else if (isImageInsertionInstruction(instruction)) {
      role = 'inline';
    } else if (INTENT_SIGNALS.some((signal) => signal.pattern.test(text))) {
      const candidates = (['hero', 'section'] as const).map((candidate) =>
        buildIntent(candidate, resolveIntentWord(text, candidate), VISUAL_ROLE_DEFAULT_PLACEMENT[candidate], context, instruction),
      );
      return {
        status: 'needs_clarification',
        candidates,
        question: 'Should this be a hero visual or a supporting section image?',
      };
    } else {
      return { status: 'unsupported', reason: 'no_role_identified' };
    }
  }

  const intent = resolveIntentWord(text, role);
  const placement = PLACEMENT_SIGNALS.find((signal) => signal.pattern.test(text))?.placement ?? VISUAL_ROLE_DEFAULT_PLACEMENT[role];
  return { status: 'resolved', intent: buildIntent(role, intent, placement, context, instruction) };
}

function resolveIntentWord(text: string, role: VisualAssetRole): VisualIntent {
  return INTENT_SIGNALS.find((signal) => signal.pattern.test(text))?.intent ?? VISUAL_ROLE_DEFAULT_INTENT[role];
}

/** True when the resolved intent maps to a visual R4.1 can actually place. */
export function isVisualIntentInsertable(intent: VisualDesignIntent): boolean {
  return isVisualInsertableRole(intent.role);
}

/** The plain-text query the resolver derived from the instruction and context. */
export function visualIntentQuery(intent: VisualDesignIntent, context: VisualIntentContext): string {
  const parts = [intent.subject, context.selectedText, context.sectionHeading, context.nearbyText, context.documentTitle];
  return parts
    .map((part) => normalized(part))
    .filter((part) => part.length > 0)
    .join(' ');
}
