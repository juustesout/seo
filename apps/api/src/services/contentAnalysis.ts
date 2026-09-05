/**
 * Deterministic content analysis (SEO Core).
 *
 * Scores structured content from its blocks + metadata alone: no network, no
 * provider. The same report shape feeds the UI, REST v1, MCP and the optional
 * AI pass performed inside the content_analyze job.
 */

import { contentWordCount, type ContentBlock } from '@seo/contracts';

export interface AnalysisIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface AnalysisSummary {
  words: number;
  headings: number;
  paragraphs: number;
  links: number;
  media: number;
  mediaPlaceholders: number;
  longParagraphs: number;
}

export interface ContentAnalysisReport {
  score: number;
  issues: AnalysisIssue[];
  recommendations: string[];
  summary: AnalysisSummary;
  generated_at: string;
}

interface AnalysisMeta {
  title?: string | null;
  targetKeyword?: string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  imageHint?: string | null;
}

const MAX_META_TITLE = 60;
const MAX_META_DESC = 160;

/** Flat, searchable text of every authored block. */
export function blockTexts(blocks: ContentBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === 'paragraph' || b.type === 'quote' || b.type === 'code') out.push(b.attrs.text);
    else if (b.type === 'heading') out.push(b.attrs.text);
    else if (b.type === 'list') out.push(b.attrs.items.join(' '));
    else if (b.type === 'link') out.push(b.attrs.text);
  }
  return out;
}

export function analyzeContent(blocks: ContentBlock[], meta: AnalysisMeta = {}): ContentAnalysisReport {
  const issues: AnalysisIssue[] = [];
  const recommendations: string[] = [];
  const kw = meta.targetKeyword?.trim()?.toLowerCase() ?? '';
  const allText = blockTexts(blocks).join('\n');
  const lower = allText.toLowerCase();
  const titleText = (meta.title ?? meta.metaTitle ?? '').toLowerCase();
  const words = contentWordCount(blocks);
  const paragraphs = blocks.filter((b) => b.type === 'paragraph');
  const headings = blocks.filter((b) => b.type === 'heading');
  const h1 = headings.filter((h) => h.attrs.level === 1);
  const h2 = headings.filter((h) => h.attrs.level === 2);
  const links = blocks.filter((b) => b.type === 'link');
  const mediaBlocks = blocks.filter((b) => b.type === 'media');
  const mediaPlaceholders = mediaBlocks.filter((b) => b.attrs.kind === 'placeholder' && !b.attrs.src);
  const longParagraphs = paragraphs.filter((p) => p.attrs.text.trim().split(/\s+/).length > 180);
  const firstParagraph = paragraphs[0]?.attrs.text.toLowerCase() ?? '';
  const headingText = headings.map((h) => h.attrs.text.toLowerCase()).join(' ');

  // Metadata + keyword signals.
  const metaTitle = meta.metaTitle ?? meta.title ?? '';
  const metaDesc = meta.metaDescription ?? '';
  if (!metaTitle) {
    issues.push({ code: 'meta_title_missing', severity: 'warning', message: 'No meta title is set' });
    recommendations.push('Add a meta title (aim 50-60 characters).');
  } else if (metaTitle.length > MAX_META_TITLE) {
    issues.push({
      code: 'meta_title_too_long',
      severity: 'warning',
      message: `Meta title is ${metaTitle.length} chars (max ${MAX_META_TITLE})`,
    });
  }
  if (kw && metaTitle && !metaTitle.includes(kw)) {
    issues.push({ code: 'keyword_not_in_meta_title', severity: 'warning', message: 'Primary keyword is missing from the meta title' });
  }
  if (!metaDesc) {
    issues.push({ code: 'meta_description_missing', severity: 'warning', message: 'No meta description is set' });
    recommendations.push('Add a meta description between 50 and 160 characters.');
  } else if (metaDesc.length > MAX_META_DESC) {
    issues.push({
      code: 'meta_description_too_long',
      severity: 'warning',
      message: `Meta description is ${metaDesc.length} chars (max ${MAX_META_DESC})`,
    });
  } else if (metaDesc.length < 50) {
    issues.push({ code: 'meta_description_too_short', severity: 'warning', message: 'Meta description is shorter than 50 characters' });
  }
  if (kw && metaDesc && !metaDesc.toLowerCase().includes(kw)) {
    issues.push({ code: 'keyword_not_in_meta_description', severity: 'warning', message: 'Primary keyword is missing from the meta description' });
  }

  // Content structure signals.
  if (kw && titleText && !titleText.includes(kw)) {
    issues.push({ code: 'keyword_not_in_title', severity: 'warning', message: 'Primary keyword is missing from the title' });
  }
  if (kw && !lower.includes(kw)) {
    issues.push({ code: 'keyword_not_in_body', severity: 'error', message: 'Primary keyword does not appear anywhere in the body' });
    recommendations.push('Mention the primary keyword naturally in the body copy.');
  } else if (kw && !firstParagraph.includes(kw) && !headingText.includes(kw)) {
    issues.push({ code: 'keyword_not_up_front', severity: 'warning', message: 'Primary keyword is not in the first paragraph or any heading' });
  }

  if (words < 200) {
    issues.push({ code: 'too_short', severity: 'error', message: `Only ${words} words; most competitive topics need more depth` });
    recommendations.push('Expand the article to at least 400 words per section intent.');
  } else if (words < 400) {
    issues.push({ code: 'thin_content', severity: 'warning', message: `Only ${words} words` });
    recommendations.push('Consider adding more depth to reach at least 600 words.');
  }
  if (headings.length === 0) {
    issues.push({ code: 'no_headings', severity: 'warning', message: 'No headings found' });
    recommendations.push('Break the copy into sections with level-2 headings.');
  } else if (h2.length === 0 && h1.length === 0) {
    issues.push({ code: 'no_h2', severity: 'warning', message: 'No level-2 headings found' });
  }
  if (h1.length > 0) {
    issues.push({ code: 'h1_used', severity: 'warning', message: 'Body uses a level-1 heading; reserve H1 for the page title' });
  }
  if (words >= 600 && links.length === 0) {
    issues.push({ code: 'no_links', severity: 'warning', message: 'Long article contains no links' });
    recommendations.push('Add at least one internal link and one clearly relevant external reference.');
  }
  if (mediaPlaceholders.length > 0) {
    issues.push({
      code: 'media_placeholder_unresolved',
      severity: 'warning',
      message: `${mediaPlaceholders.length} media placeholder(s) still unresolved`,
    });
    recommendations.push('Run content images to resolve media placeholders, or remove them.');
  }
  if (mediaBlocks.length === 0 && words >= 400 && meta.imageHint) {
    issues.push({ code: 'no_media', severity: 'warning', message: 'Article has no images despite an image brief' });
    recommendations.push('Add a supporting image with descriptive alt text.');
  }
  if (longParagraphs.length > 0) {
    issues.push({ code: 'long_paragraphs', severity: 'warning', message: `${longParagraphs.length} paragraph(s) exceed 180 words` });
    recommendations.push('Split paragraphs longer than ~150 words for readability.');
  }

  // Derived score: start at 100 and subtract per signal so the number is an
  // honest audit trail of the findings above.
  let score = 100;
  for (const issue of issues) {
    if (issue.code === 'meta_description_too_long' || issue.code === 'meta_title_too_long') score -= 2;
    else if (issue.code === 'too_short') score -= 15;
    else if (issue.code === 'thin_content') score -= 7;
    else if (issue.code === 'keyword_not_in_body') score -= 12;
    else if (issue.code === 'media_placeholder_unresolved') score -= 4;
    else score -= 5;
  }
  if (!metaDesc && words < 300) score -= 3;
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    issues,
    recommendations,
    summary: {
      words,
      headings: headings.length,
      paragraphs: paragraphs.length,
      links: links.length,
      media: mediaBlocks.length,
      mediaPlaceholders: mediaPlaceholders.length,
      longParagraphs: longParagraphs.length,
    },
    generated_at: new Date().toISOString(),
  };
}
