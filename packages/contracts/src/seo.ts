/**
 * Deterministic on-page SEO evaluation (SEO Core).
 *
 * Phase C: the single canonical evaluator for the Content Studio. It runs on
 * the Phase B Tiptap document plus content metadata - no network, no AI, no
 * search-engine data. Identical input always yields identical output, and the
 * result is explainable: every point belongs to a named check in a category.
 *
 * This is an editorial/on-page assessment, not a prediction of search-engine
 * rankings.
 */

import {
  docHeadings,
  docIntroduction,
  docPlainText,
  docWordCount,
  inlineText,
  type TipDoc,
  type TipNode,
} from './contentDoc.js';

export type SeoCheckStatus = 'pass' | 'warn' | 'fail' | 'not_applicable';
export type SeoCategory = 'Metadata' | 'Keyword' | 'Content' | 'Structure' | 'Readability';

export interface SeoCheck {
  code: string;
  category: SeoCategory;
  label: string;
  status: SeoCheckStatus;
  /** Points earned by this check (0..maxPoints). */
  points: number;
  maxPoints: number;
  /** One-line explanation of the result. */
  detail: string;
  /** Optional one-line suggestion when the check is not a clean pass. */
  suggestion?: string;
}

export interface SeoMeta {
  title?: string | null;
  targetKeyword?: string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
}

export interface SeoEvalInput {
  doc: TipDoc;
  meta?: SeoMeta;
}

export interface SeoStats {
  words: number;
  headings: number;
  h1: number;
  h2: number;
  paragraphs: number;
  links: number;
  longParagraphs: number;
}

export interface SeoResult {
  /** 0..100 integer. */
  score: number;
  /** Normalized keyword used for the keyword checks (null when none). */
  keyword: string | null;
  checks: SeoCheck[];
  stats: SeoStats;
}

export function seoScoreLabel(score: number): string {
  if (score >= 90) return 'Excellent';
  if (score >= 80) return 'Good';
  if (score >= 60) return 'Needs work';
  return 'Needs attention';
}

// ---------------------------------------------------------------------------
// Keyword normalization (trim / collapse whitespace / case-insensitive)
// ---------------------------------------------------------------------------

export function normalizeKeyword(keyword: string | null | undefined): string | null {
  if (!keyword) return null;
  const normalized = String(keyword).trim().replace(/\s+/g, ' ').toLowerCase();
  return normalized || null;
}

/** Sensible phrase matching on normalized text. */
export function textHasKeyword(text: string, keyword: string): boolean {
  return normalizeKeyword(text)?.includes(keyword) ?? false;
}

/** Number of times the normalized phrase occurs in the normalized text. */
export function keywordCount(text: string, keyword: string): number {
  if (!keyword || !text) return 0;
  const source = normalizeKeyword(text) ?? '';
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = source.match(new RegExp(escaped, 'g'));
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// Document structure helpers
// ---------------------------------------------------------------------------

/** Text lengths of every heading node in the document (including empty ones). */
function headingTexts(doc: TipDoc): string[] {
  const out: string[] = [];
  const walk = (nodes: TipNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'heading') out.push(inlineText(node).trim());
      if (node.content) walk(node.content as TipNode[]);
    }
  };
  walk(doc.content ?? []);
  return out;
}

interface ParagraphInfo {
  text: string;
  words: number;
}

function paragraphs(doc: TipDoc): ParagraphInfo[] {
  const out: ParagraphInfo[] = [];
  const walk = (nodes: TipNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'paragraph') {
        const text = inlineText(node).trim();
        if (text) {
          out.push({ text, words: text.split(/\s+/).filter(Boolean).length });
        }
      }
      if (node.content) walk(node.content as TipNode[]);
    }
  };
  walk(doc.content ?? []);
  return out;
}

function linkCount(doc: TipDoc): number {
  let count = 0;
  const walk = (nodes: TipNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'text' && Array.isArray(node.marks) && node.marks.some((m) => m.type === 'link')) {
        count += 1;
      }
      if (node.content) walk(node.content as TipNode[]);
    }
  };
  walk(doc.content ?? []);
  return count;
}

function collectStats(doc: TipDoc): SeoStats {
  const headings = docHeadings(doc);
  const paras = paragraphs(doc);
  const longParagraphs = paras.filter((p) => p.words > 220).length;
  return {
    words: docWordCount(doc),
    headings: headings.length,
    h1: headings.filter((h) => h.level === 1).length,
    h2: headings.filter((h) => h.level === 2).length,
    paragraphs: paras.length,
    links: linkCount(doc),
    longParagraphs,
  };
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

const TITLE_IDEAL = { min: 25, max: 70 };
const META_TITLE_IDEAL = { min: 30, max: 60 };
const META_DESC_IDEAL = { min: 50, max: 160 };
const MIN_GOOD_WORDS = 300;
const LONG_PARAGRAPH_WORDS = 220;

interface CheckAccumulator {
  checks: SeoCheck[];
}

function addCheck(acc: CheckAccumulator, check: SeoCheck): void {
  acc.checks.push(check);
}

function resultOf(acc: CheckAccumulator, keyword: string | null, stats: SeoStats): SeoResult {
  const maxTotal = acc.checks.reduce((sum, c) => sum + c.maxPoints, 0);
  const earned = acc.checks.reduce((sum, c) => sum + c.points, 0);
  const score = maxTotal === 0 ? 0 : Math.round((earned / maxTotal) * 100);
  return {
    score,
    keyword,
    checks: acc.checks,
    stats,
  };
}

/**
 * Deterministic on-page SEO evaluation. Pure and side-effect free: the same
 * doc + metadata always produce the same checks and the same score.
 */
export function evaluateSeo({ doc, meta = {} }: SeoEvalInput): SeoResult {
  const title = meta.title?.trim() ?? '';
  const metaTitle = meta.metaTitle?.trim() ?? '';
  const metaDescription = meta.metaDescription?.trim() ?? '';
  const keyword = normalizeKeyword(meta.targetKeyword);

  const plain = docPlainText(doc);
  const words = docWordCount(doc);
  const headings = docHeadings(doc);
  const headingRaw = headingTexts(doc);
  const paras = paragraphs(doc);
  const longestParagraph = paras.reduce((max, p) => Math.max(max, p.words), 0);
  const intro = docIntroduction(doc);

  const acc: CheckAccumulator = { checks: [] };

  const statusPoints = (status: SeoCheckStatus, max: number): number => {
    if (status === 'pass' || status === 'not_applicable') return max;
    if (status === 'warn') return Math.round(max * 0.6);
    return 0;
  };

  const push = (
    code: string,
    category: SeoCategory,
    label: string,
    status: SeoCheckStatus,
    maxPoints: number,
    detail: string,
    suggestion?: string,
  ) => {
    addCheck(acc, {
      code,
      category,
      label,
      status,
      points: statusPoints(status, maxPoints),
      maxPoints,
      detail,
      ...(suggestion ? { suggestion } : {}),
    });
  };

  // ---- Metadata ----------------------------------------------------------
  const titleOk = title.length > 0;
  push(
    'title_present',
    'Metadata',
    'Title',
    titleOk ? 'pass' : 'fail',
    7,
    titleOk ? `Title is "${title.slice(0, 60)}${title.length > 60 ? '…' : ''}"` : 'No document title is set',
    titleOk ? undefined : 'Set an article title (metadata title, not the H1).',
  );

  if (titleOk) {
    if (title.length >= TITLE_IDEAL.min && title.length <= TITLE_IDEAL.max) {
      push('title_length', 'Metadata', 'Title length', 'pass', 6, `${title.length} characters (recommended ${TITLE_IDEAL.min}-${TITLE_IDEAL.max})`);
    } else if (title.length < TITLE_IDEAL.min) {
      push('title_length', 'Metadata', 'Title length', 'warn', 6, `Title is ${title.length} characters — short for a ${TITLE_IDEAL.min}-${TITLE_IDEAL.max} target`, 'Consider a slightly more descriptive title.');
    } else {
      push('title_length', 'Metadata', 'Title length', 'warn', 6, `Title is ${title.length} characters — long for a ${TITLE_IDEAL.min}-${TITLE_IDEAL.max} target`, 'Consider trimming the title.');
    }
  } else {
    push('title_length', 'Metadata', 'Title length', 'not_applicable', 6, 'No title to measure');
  }

  const metaTitleOk = metaTitle.length > 0;
  push(
    'meta_title_present',
    'Metadata',
    'Meta title',
    metaTitleOk ? 'pass' : 'fail',
    5,
    metaTitleOk ? `Meta title is "${metaTitle.slice(0, 60)}${metaTitle.length > 60 ? '…' : ''}"` : 'No meta title is set',
    metaTitleOk ? undefined : 'Add a meta title of about 50-60 characters.',
  );

  if (metaTitleOk) {
    if (metaTitle.length >= META_TITLE_IDEAL.min && metaTitle.length <= META_TITLE_IDEAL.max) {
      push('meta_title_length', 'Metadata', 'Meta title length', 'pass', 4, `${metaTitle.length} characters (recommended ${META_TITLE_IDEAL.min}-${META_TITLE_IDEAL.max})`);
    } else if (metaTitle.length < META_TITLE_IDEAL.min) {
      push('meta_title_length', 'Metadata', 'Meta title length', 'warn', 4, `${metaTitle.length} characters — below the ${META_TITLE_IDEAL.min}-${META_TITLE_IDEAL.max} target`, 'Aim for at least 30 characters in the meta title.');
    } else {
      push('meta_title_length', 'Metadata', 'Meta title length', 'warn', 4, `${metaTitle.length} characters — above the ${META_TITLE_IDEAL.min}-${META_TITLE_IDEAL.max} target`, 'Search results may truncate longer meta titles.');
    }
  } else {
    push('meta_title_length', 'Metadata', 'Meta title length', 'not_applicable', 4, 'No meta title to measure');
  }

  const metaDescOk = metaDescription.length > 0;
  push(
    'meta_description_present',
    'Metadata',
    'Meta description',
    metaDescOk ? 'pass' : 'fail',
    4,
    metaDescOk ? 'Meta description is set' : 'No meta description is set',
    metaDescOk ? undefined : 'Add a meta description of about 50-160 characters.',
  );

  if (metaDescOk) {
    if (metaDescription.length >= META_DESC_IDEAL.min && metaDescription.length <= META_DESC_IDEAL.max) {
      push('meta_description_length', 'Metadata', 'Meta description length', 'pass', 4, `${metaDescription.length} characters (recommended ${META_DESC_IDEAL.min}-${META_DESC_IDEAL.max})`);
    } else if (metaDescription.length < META_DESC_IDEAL.min) {
      push('meta_description_length', 'Metadata', 'Meta description length', 'warn', 4, `${metaDescription.length} characters — below the ${META_DESC_IDEAL.min}-${META_DESC_IDEAL.max} target`, 'Aim for at least 50 characters in the meta description.');
    } else {
      push('meta_description_length', 'Metadata', 'Meta description length', 'warn', 4, `${metaDescription.length} characters — above the ${META_DESC_IDEAL.min}-${META_DESC_IDEAL.max} target`, 'Search results may truncate longer meta descriptions.');
    }
  } else {
    push('meta_description_length', 'Metadata', 'Meta description length', 'not_applicable', 4, 'No meta description to measure');
  }

  // ---- Keyword -----------------------------------------------------------
  const kwChecks = keyword !== null;

  if (!kwChecks) {
    push('keyword_in_title', 'Keyword', 'Keyword in title', 'not_applicable', 5, 'No target keyword set — not evaluated');
    push('keyword_in_meta_title', 'Keyword', 'Keyword in meta title', 'not_applicable', 4, 'No target keyword set — not evaluated');
    push('keyword_in_meta_description', 'Keyword', 'Keyword in meta description', 'not_applicable', 4, 'No target keyword set — not evaluated');
    push('keyword_in_content', 'Keyword', 'Keyword in content', 'not_applicable', 8, 'No target keyword set — not evaluated');
    push('keyword_in_introduction', 'Keyword', 'Keyword in introduction', 'not_applicable', 3, 'No target keyword set — not evaluated');
    push('keyword_repetition', 'Keyword', 'Keyword repetition', 'not_applicable', 1, 'No target keyword set — not evaluated');
  } else {
    if (!titleOk) {
      push('keyword_in_title', 'Keyword', 'Keyword in title', 'not_applicable', 5, 'No title to evaluate');
    } else if (textHasKeyword(title, keyword)) {
      push('keyword_in_title', 'Keyword', 'Keyword in title', 'pass', 5, `Title contains "${keyword}"`);
    } else {
      push('keyword_in_title', 'Keyword', 'Keyword in title', 'fail', 5, `Title does not contain "${keyword}"`, 'Include the primary keyword in the title.');
    }

    if (!metaTitleOk) {
      push('keyword_in_meta_title', 'Keyword', 'Keyword in meta title', 'not_applicable', 4, 'No meta title to evaluate');
    } else if (textHasKeyword(metaTitle, keyword)) {
      push('keyword_in_meta_title', 'Keyword', 'Keyword in meta title', 'pass', 4, `Meta title contains "${keyword}"`);
    } else {
      push('keyword_in_meta_title', 'Keyword', 'Keyword in meta title', 'fail', 4, `Meta title does not contain "${keyword}"`, 'Include the primary keyword in the meta title.');
    }

    if (!metaDescOk) {
      push('keyword_in_meta_description', 'Keyword', 'Keyword in meta description', 'not_applicable', 4, 'No meta description to evaluate');
    } else if (textHasKeyword(metaDescription, keyword)) {
      push('keyword_in_meta_description', 'Keyword', 'Keyword in meta description', 'pass', 4, `Meta description contains "${keyword}"`);
    } else {
      push('keyword_in_meta_description', 'Keyword', 'Keyword in meta description', 'fail', 4, `Meta description does not contain "${keyword}"`, 'Include the primary keyword in the meta description.');
    }

    if (words === 0) {
      push('keyword_in_content', 'Keyword', 'Keyword in content', 'not_applicable', 8, 'No content to evaluate');
    } else if (textHasKeyword(plain, keyword)) {
      push('keyword_in_content', 'Keyword', 'Keyword in content', 'pass', 8, `Content contains "${keyword}"`);
    } else {
      push('keyword_in_content', 'Keyword', 'Keyword in content', 'fail', 8, `Content does not contain "${keyword}"`, 'Mention the primary keyword naturally in the copy.');
    }

    if (words === 0) {
      push('keyword_in_introduction', 'Keyword', 'Keyword in introduction', 'not_applicable', 3, 'No introduction to evaluate');
    } else if (textHasKeyword(intro, keyword)) {
      push('keyword_in_introduction', 'Keyword', 'Keyword in introduction', 'pass', 3, `Introduction contains "${keyword}"`);
    } else {
      push('keyword_in_introduction', 'Keyword', 'Keyword in introduction', 'fail', 3, `Introduction does not contain "${keyword}"`, 'Use the primary keyword early in the opening paragraph.');
    }

    const occurrences = keywordCount(plain, keyword);
    const generousCap = Math.max(3, Math.floor(words * 0.02));
    if (words > 0 && occurrences > generousCap) {
      push('keyword_repetition', 'Keyword', 'Keyword repetition', 'warn', 1, `"${keyword}" appears ${occurrences} times in ${words} words`, 'Reduce repetition — replace some uses with natural alternatives.');
    } else {
      push('keyword_repetition', 'Keyword', 'Keyword repetition', 'pass', 1, `"${keyword}" appears ${occurrences} ${occurrences === 1 ? 'time' : 'times'}`);
    }
  }

  // ---- Content -----------------------------------------------------------
  if (words === 0) {
    push('has_content', 'Content', 'Content present', 'fail', 4, 'The document contains no text', 'Write your article content.');
  } else {
    push('has_content', 'Content', 'Content present', 'pass', 4, `${words} ${words === 1 ? 'word' : 'words'} of body copy`);
  }

  if (words === 0) {
    push('content_length', 'Content', 'Content length', 'not_applicable', 9, 'No content to measure');
  } else if (words >= MIN_GOOD_WORDS) {
    push('content_length', 'Content', 'Content length', 'pass', 9, `${words} words — meets the ${MIN_GOOD_WORDS}+ word guide`);
  } else {
    push('content_length', 'Content', 'Content length', 'warn', 9, `${words} words — short of the ${MIN_GOOD_WORDS}+ word guide`, 'Expand the article with genuinely useful detail.');
  }

  // ---- Structure ---------------------------------------------------------
  const h1 = headings.filter((h) => h.level === 1).length;
  if (h1 === 1) {
    push('single_h1', 'Structure', 'Single H1', 'pass', 6, 'Exactly one H1 heading');
  } else if (h1 === 0) {
    push('single_h1', 'Structure', 'Single H1', 'warn', 6, 'No H1 heading found', 'Use one H1 as the page heading.');
  } else {
    push('single_h1', 'Structure', 'Single H1', 'fail', 6, `${h1} H1 headings found`, 'Keep exactly one H1 heading.');
  }

  let skips = 0;
  for (let i = 1; i < headings.length; i += 1) {
    const prev = headings[i - 1];
    const cur = headings[i];
    if (prev && cur && cur.level - prev.level > 1) skips += 1;
  }
  if (headings.length < 2) {
    push('heading_hierarchy', 'Structure', 'Heading hierarchy', 'pass', 5, 'Fewer than two headings — hierarchy not applicable');
  } else if (skips === 0) {
    push('heading_hierarchy', 'Structure', 'Heading hierarchy', 'pass', 5, 'Heading levels progress without skipping');
  } else {
    push('heading_hierarchy', 'Structure', 'Heading hierarchy', 'warn', 5, `${skips} ${skips === 1 ? 'heading skips' : 'headings skip'} a level (e.g. H2 → H4)`, 'Keep sub-sections one level deeper than their parent.');
  }

  if (headingRaw.length === 0) {
    push('meaningful_headings', 'Structure', 'Meaningful headings', 'fail', 5, 'The document has no headings', 'Break the copy into sections with descriptive headings.');
  } else {
    const emptyHeading = headingRaw.some((t) => t.length === 0);
    const tooShort = headingRaw.some((t) => t.length > 0 && t.length < 3);
    if (emptyHeading) {
      push('meaningful_headings', 'Structure', 'Meaningful headings', 'fail', 5, 'One or more headings are empty', 'Give every heading descriptive text.');
    } else if (tooShort) {
      push('meaningful_headings', 'Structure', 'Meaningful headings', 'warn', 5, 'One or more headings are very short', 'Use descriptive heading text.');
    } else {
      push('meaningful_headings', 'Structure', 'Meaningful headings', 'pass', 5, 'All headings contain descriptive text');
    }
  }

  if (words >= 500 && headings.length < 2) {
    push('structural_headings', 'Structure', 'Structural headings', 'warn', 4, `${words} words but only ${headings.length} ${headings.length === 1 ? 'heading' : 'headings'}`, 'Add section headings to structure longer content.');
  } else {
    push('structural_headings', 'Structure', 'Structural headings', 'pass', 4, headings.length === 0 ? 'Headings optional at this length' : `${headings.length} headings in the document`);
  }

  // ---- Readability -------------------------------------------------------
  if (paras.length === 0) {
    push('paragraph_length', 'Readability', 'Paragraph length', 'pass', 6, 'No paragraphs to measure');
  } else if (longestParagraph > LONG_PARAGRAPH_WORDS) {
    push('paragraph_length', 'Readability', 'Paragraph length', 'warn', 6, `Longest paragraph is ${longestParagraph} words`, 'Split paragraphs longer than about 200 words.');
  } else {
    push('paragraph_length', 'Readability', 'Paragraph length', 'pass', 6, `Longest paragraph is ${longestParagraph} words`);
  }

  const paraTexts = paras.map((p) => p.text);
  const dupParagraph = paraTexts.some((t, i) => t.length >= 40 && paraTexts.indexOf(t) !== i);
  const headingKeys = headingRaw.filter((t) => t.length > 0).map((t) => t.toLowerCase());
  const dupHeading = headingKeys.some((t, i) => headingKeys.indexOf(t) !== i);
  if (dupParagraph) {
    push('excessive_repetition', 'Readability', 'Repeated content', 'warn', 6, 'Two or more paragraphs contain the same text', 'Reword duplicated paragraphs.');
  } else if (dupHeading) {
    push('excessive_repetition', 'Readability', 'Repeated content', 'warn', 6, 'Two or more headings have the same text', 'Give each section a distinct heading.');
  } else {
    push('excessive_repetition', 'Readability', 'Repeated content', 'pass', 6, 'No repeated paragraphs or headings detected');
  }

  return resultOf(acc, keyword, collectStats(doc));
}
