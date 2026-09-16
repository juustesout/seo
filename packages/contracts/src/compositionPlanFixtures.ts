/**
 * Representative composition plan fixture (Stage 6).
 *
 * A deterministic marketing storyboard for the SEO application. It declares
 * structure and required content only - no headlines, no copy, no image URLs,
 * no statistics. It exists so the compiler and the renderer can be exercised
 * against one shared, realistic plan; it is not wired into production UI.
 */

import { COMPOSITION_PLAN_VERSION, type CompositionPlan, type CompositionPlanNode } from './compositionPlan.js';

function featureCard(): CompositionPlanNode {
  return {
    type: 'featureCard',
    variant: 'elevated',
    purpose: 'features',
    requiredContent: [
      { type: 'heading', level: 3 },
      { type: 'paragraph', role: 'body' },
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
        { type: 'heading', level: 1, role: 'title' },
        { type: 'paragraph', role: 'intro' },
        { type: 'image', role: 'media' },
        { type: 'button', role: 'primaryCta', variant: 'primary' },
      ],
    },
    {
      type: 'section',
      purpose: 'problem',
      requiredContent: [
        { type: 'heading', level: 2 },
        { type: 'paragraph', role: 'body' },
      ],
    },
    {
      type: 'featureGrid',
      layout: { columns: 3 },
      purpose: 'features',
      children: [featureCard(), featureCard(), featureCard()],
    },
    {
      type: 'testimonial',
      purpose: 'proof',
      requiredContent: [
        { type: 'quote' },
        { type: 'paragraph', role: 'attribution' },
      ],
    },
    {
      type: 'cta',
      variant: 'primary',
      layout: { align: 'center', density: 'spacious' },
      purpose: 'conversion',
      requiredContent: [
        { type: 'heading', level: 2 },
        { type: 'paragraph', role: 'body' },
        { type: 'button', role: 'primaryCta', variant: 'primary' },
      ],
    },
    {
      type: 'footer',
      purpose: 'closing',
      requiredContent: [
        { type: 'paragraph', role: 'body' },
        { type: 'button', role: 'secondaryCta' },
      ],
    },
  ],
};
