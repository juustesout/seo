/**
 * Representative composition plan fixture (Stage 6/7).
 *
 * A deterministic marketing storyboard for the SEO application. It declares
 * structure and required content slots only - no headlines, no copy, no image
 * URLs, no statistics. Every requirement carries a stable semantic slot so a
 * later Writer can address one piece at a time. It exists so the compiler and
 * the renderer can be exercised against one shared, realistic plan; it is not
 * wired into production UI.
 */

import { COMPOSITION_PLAN_VERSION, type CompositionPlan, type CompositionPlanNode } from './compositionPlan.js';

function featureCard(index: number): CompositionPlanNode {
  return {
    type: 'featureCard',
    variant: 'elevated',
    purpose: 'features',
    requiredContent: [
      { slot: `feature.card.${index}.title`, type: 'heading', level: 3 },
      { slot: `feature.card.${index}.body`, type: 'paragraph', role: 'body' },
    ],
  };
}

export const MARKETING_STORYBOARD_PLAN: CompositionPlan = {
  version: COMPOSITION_PLAN_VERSION,
  purpose: 'Introduce the product, explain its capabilities, prove the claim and drive signup.',
  format: 'landing_page',
  sections: [
    {
      type: 'hero',
      variant: 'split',
      layout: { direction: 'row', width: 'wide' },
      purpose: 'introduction',
      requiredContent: [
        { slot: 'hero.title', type: 'heading', level: 1, role: 'title' },
        { slot: 'hero.intro', type: 'paragraph', role: 'intro' },
        { slot: 'hero.media', type: 'image', role: 'media' },
        { slot: 'hero.primaryCta', type: 'button', role: 'primaryCta', variant: 'primary' },
      ],
    },
    {
      type: 'section',
      purpose: 'problem',
      requiredContent: [
        { slot: 'problem.title', type: 'heading', level: 2 },
        { slot: 'problem.body', type: 'paragraph', role: 'body' },
      ],
    },
    {
      type: 'featureGrid',
      layout: { columns: 3 },
      purpose: 'features',
      children: [featureCard(1), featureCard(2), featureCard(3)],
    },
    {
      type: 'testimonial',
      purpose: 'proof',
      requiredContent: [
        { slot: 'proof.quote', type: 'quote' },
        { slot: 'proof.author', type: 'paragraph', role: 'attribution' },
      ],
    },
    {
      type: 'cta',
      variant: 'primary',
      layout: { align: 'center', density: 'spacious' },
      purpose: 'conversion',
      requiredContent: [
        { slot: 'conversion.title', type: 'heading', level: 2 },
        { slot: 'conversion.body', type: 'paragraph', role: 'body' },
        { slot: 'conversion.primaryCta', type: 'button', role: 'primaryCta', variant: 'primary' },
      ],
    },
    {
      type: 'footer',
      purpose: 'closing',
      requiredContent: [
        { slot: 'footer.body', type: 'paragraph', role: 'body' },
        { slot: 'footer.secondaryCta', type: 'button', role: 'secondaryCta' },
      ],
    },
  ],
};
