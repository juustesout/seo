import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// RTL registers its own cleanup when it sees a global afterEach; vitest runs
// with globals disabled here, so wire cleanup explicitly to avoid leaked
// rendered trees (and their intervals) between tests.
afterEach(() => cleanup());

// jsdom does not implement Range geometry. ProseMirror's coordsAtPos calls
// Range#getClientRects/getBoundingClientRect when Tiptap's focus command
// scrolls a selection into view, which would throw an unhandled error outside
// the test. Provide zeroed geometry so the call is a no-op.
const rangeProto = Range.prototype as unknown as {
  getClientRects?: () => DOMRectList;
  getBoundingClientRect?: () => DOMRect;
};
if (typeof rangeProto.getClientRects !== 'function') {
  rangeProto.getClientRects = () => [] as unknown as DOMRectList;
}
if (typeof rangeProto.getBoundingClientRect !== 'function') {
  rangeProto.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect;
}
