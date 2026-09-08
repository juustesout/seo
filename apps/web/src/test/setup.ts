import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// RTL registers its own cleanup when it sees a global afterEach; vitest runs
// with globals disabled here, so wire cleanup explicitly to avoid leaked
// rendered trees (and their intervals) between tests.
afterEach(() => cleanup());
