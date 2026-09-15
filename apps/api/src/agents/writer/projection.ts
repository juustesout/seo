/**
 * Writer plan projection (W1, extracted in W2a).
 *
 * Projects the internal plan artifact (WriterPlan, which carries key points and
 * related-content signal) into the bounded, UI-safe ArticlePlan contract shared
 * by Quick Draft and Deep Write. Kept dependency-free and in its own module so
 * both execution profiles project identically without importing each other.
 */

import type { ArticlePlan, WriterInput } from '@seo/contracts';
import type { WriterPlan } from './state.js';

export function planToArticlePlan(plan: WriterPlan, input: WriterInput): ArticlePlan {
  return {
    title: plan.title,
    intent: plan.introductionPurpose,
    primaryKeyword: input.primaryKeyword,
    format: input.format,
    sections: plan.sections.map((section) => ({
      heading: section.heading,
      purpose: section.keyPoints.join(' | '),
      keywords: section.suggestedKeywords,
    })),
  };
}
