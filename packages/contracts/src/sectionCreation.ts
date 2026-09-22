/**
 * Section creation instruction (Part B Slice 2).
 *
 * A bounded, deterministic parser that recognizes a request to *create* a new
 * hero/section (optionally with a title, and optionally accompanied by an image
 * request). It exists so the API can build a `DocumentOperationBatch` that adds
 * structure the editor owns, instead of overloading the single-image insertion
 * path.
 *
 * This is deliberately not a general natural-language parser:
 *   - A trigger needs both a creation verb and an explicit indefinite/new
 *     determiner next to a structure noun, so "Maak de hero sterker." and "The
 *     page has a hero section." are not misread as creation.
 *   - A bare "hero" only triggers when the instruction asks for no image, so
 *     "add a hero image" stays an image request rather than a new hero.
 *   - A title is read from an explicit title cue, or from a quoted fragment that
 *     is not positioned as an image subject ("of 'Amsterdam'"). When a title was
 *     asked for but none can be read, the parser reports `expectsHeading` with no
 *     `heading`, and the caller asks instead of inventing one.
 *
 * Dependency-free by convention: plain types plus hand-rolled guards.
 */

/** Bound for a heading parsed out of the user's instruction. */
export const SECTION_CREATION_HEADING_MAX_CHARS = 120;

export const SECTION_CREATION_KINDS = ['hero', 'section'] as const;
export type SectionCreationKind = (typeof SECTION_CREATION_KINDS)[number];

export interface SectionCreationRequest {
  kind: SectionCreationKind;
  /** The explicitly titled heading, when one could be read reliably. */
  heading?: string;
  /** True when the instruction asked for a title (read or not). */
  expectsHeading: boolean;
}

const CREATION_VERB_RE = /\b(add|create|insert|make|build|voeg|toevoegen|maak|plaats|zet)\b/i;
const NEW_SECTION_RE = /\b(?:a|an|een|new|nieuw|nieuwe)\s+(?:[^\s]+\s+){0,2}?(?:section|sectie)\b/i;
const NEW_HERO_RE = /\b(?:a|an|een|new|nieuw|nieuwe)\s+(?:[^\s]+\s+){0,2}?hero\b/i;
const HERO_RE = /\bhero\b/i;
const HEADING_CUE_RE = /\b(?:title|titled|heading|headline|kop|titel|genaamd)\b/i;
const IMAGE_NOUN_RE =
  /\b(?:image|images|photo|photos|picture|pictures|afbeelding|afbeeldingen|foto|fotos|illustration|illustratie|graphic|plaatje|background|achtergrond)\b/i;

/** First single/double quoted fragment, used for an explicitly quoted title. */
const QUOTED_RE = /"([^"]{1,120})"|'([^']{1,120})'/;
/** A title named after an explicit cue, without quotes. */
const LABELLED_RE =
  /(?:with (?:the )?title|with (?:the )?heading|titled|title|heading|headline|met (?:de )?titel|onder de titel|genaamd)\s*[:\-=]?\s*([^"'\n.,]{1,120})/i;
/** Connectors that end an unquoted title. */
const TITLE_STOP_RE = /\s+(?:and|with|en|met|of|van|for|voor)\b/i;
/** Prepositions that mark a quoted fragment as an image subject, not a title. */
const SUBJECT_PREPOSITION_RE = /^(?:of|van|about|over)$/i;

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function bound(value: string): string {
  return value.slice(0, SECTION_CREATION_HEADING_MAX_CHARS);
}

/**
 * A quoted fragment is a title when a title cue preceded it, or when it is not
 * positioned as an image subject (preceded by "of"/"van" or followed by an image
 * noun). This reads a quoted title even when the cue itself is misspelled, while
 * still refusing to turn "a background image of 'Amsterdam'" into a heading.
 */
function quotedHeading(instruction: string, hasHeadingCue: boolean): string | undefined {
  const quoted = QUOTED_RE.exec(instruction);
  if (!quoted || quoted.index === undefined) return undefined;
  const value = normalize(quoted[1] ?? quoted[2] ?? '');
  if (!value) return undefined;
  if (hasHeadingCue) return bound(value);

  const before = normalize(instruction.slice(0, quoted.index)).split(/\s+/).pop() ?? '';
  if (SUBJECT_PREPOSITION_RE.test(before)) return undefined;
  const after = normalize(instruction.slice(quoted.index + quoted[0].length));
  const nextWord = after.split(/\s+/)[0] ?? '';
  if (nextWord && IMAGE_NOUN_RE.test(nextWord)) return undefined;
  return bound(value);
}

function extractHeading(instruction: string, hasHeadingCue: boolean): string | undefined {
  const quoted = quotedHeading(instruction, hasHeadingCue);
  if (quoted) return quoted;
  if (!hasHeadingCue) return undefined;

  const labelled = LABELLED_RE.exec(instruction);
  if (!labelled?.[1]) return undefined;
  const stop = TITLE_STOP_RE.exec(labelled[1]);
  const value = normalize(stop ? labelled[1].slice(0, stop.index) : labelled[1]).replace(/^["'\s:=-]+|["'\s:=-]+$/g, '');
  return value ? bound(value) : undefined;
}

/**
 * Recognizes a request to create a new hero/section, or returns null. Pure and
 * deterministic: the same instruction always produces the same request.
 */
export function sectionCreationFromInstruction(instruction: string): SectionCreationRequest | null {
  const text = normalize(instruction);
  if (text.length === 0) return null;
  if (!CREATION_VERB_RE.test(text)) return null;

  const newSection = NEW_SECTION_RE.test(text);
  // A bare "hero" is only a creation request when no image is asked for, so
  // "add a hero image" keeps routing to image insertion.
  const newHero = !newSection && NEW_HERO_RE.test(text) && !IMAGE_NOUN_RE.test(text);
  if (!newSection && !newHero) return null;

  const hasHeadingCue = HEADING_CUE_RE.test(text);
  const heading = extractHeading(text, hasHeadingCue);
  const kind: SectionCreationKind = HERO_RE.test(text) ? 'hero' : 'section';
  return { kind, expectsHeading: hasHeadingCue || heading !== undefined, ...(heading ? { heading } : {}) };
}
