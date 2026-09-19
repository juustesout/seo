/**
 * Bounded planner context tests (Stage 8E.6, Phase 3.2).
 *
 * The planner context must never be unbounded: a large document would blow up
 * the prompt and cost, and unbounded text is an injection surface. These tests
 * pin the pure bounds.
 */
import { describe, expect, it } from 'vitest';
import {
  PLANNER_CONTEXT_BLOCK_TEXT_MAX_CHARS,
  PLANNER_CONTEXT_MAX_BLOCKS,
  PLANNER_CONTEXT_MAX_HEADINGS,
  PLANNER_CONTEXT_HEADING_TEXT_MAX_CHARS,
  boundDesignerPlannerBlocks,
  boundDesignerPlannerHeadings,
} from './plannerContext.js';

describe('boundDesignerPlannerBlocks', () => {
  it('caps the number of blocks', () => {
    const blocks = Array.from({ length: PLANNER_CONTEXT_MAX_BLOCKS + 5 }, (_, i) => ({
      ref: `b${i}`,
      type: 'paragraph',
      text: 'x',
    }));
    expect(boundDesignerPlannerBlocks(blocks)).toHaveLength(PLANNER_CONTEXT_MAX_BLOCKS);
  });

  it('truncates each block text', () => {
    const long = 'y'.repeat(PLANNER_CONTEXT_BLOCK_TEXT_MAX_CHARS + 50);
    const [block] = boundDesignerPlannerBlocks([{ ref: 'b0', type: 'paragraph', text: long }]);
    expect(block!.text).toHaveLength(PLANNER_CONTEXT_BLOCK_TEXT_MAX_CHARS);
  });

  it('does not mutate the input', () => {
    const blocks = [{ ref: 'b0', type: 'paragraph', text: 'short' }];
    boundDesignerPlannerBlocks(blocks);
    expect(blocks[0]!.text).toBe('short');
  });
});

describe('boundDesignerPlannerHeadings', () => {
  it('caps the count and truncates text', () => {
    const headings = Array.from({ length: PLANNER_CONTEXT_MAX_HEADINGS + 3 }, () => ({
      level: 2,
      text: 'z'.repeat(PLANNER_CONTEXT_HEADING_TEXT_MAX_CHARS + 10),
    }));
    const bounded = boundDesignerPlannerHeadings(headings);
    expect(bounded).toHaveLength(PLANNER_CONTEXT_MAX_HEADINGS);
    expect(bounded[0]!.text).toHaveLength(PLANNER_CONTEXT_HEADING_TEXT_MAX_CHARS);
  });
});
