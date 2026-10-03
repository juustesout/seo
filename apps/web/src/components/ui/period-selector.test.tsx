import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_PERIOD_DAYS, PERIOD_OPTIONS, PeriodSelector, periodRange } from './period-selector';

describe('PeriodSelector', () => {
  it('renders every shared option and marks the active one', () => {
    render(<PeriodSelector value={DEFAULT_PERIOD_DAYS} onChange={() => {}} />);
    expect(screen.getAllByRole('button')).toHaveLength(PERIOD_OPTIONS.length);
    expect(screen.getByRole('button', { name: 'Last 28 days' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('reports the chosen period', () => {
    const onChange = vi.fn();
    render(<PeriodSelector value={DEFAULT_PERIOD_DAYS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Last 90 days' }));
    expect(onChange).toHaveBeenCalledWith(90);
  });
});

describe('periodRange', () => {
  it('returns an inclusive window ending on the given day', () => {
    expect(periodRange(28, new Date('2026-10-03T12:00:00Z'))).toEqual({
      startDate: '2026-09-06',
      endDate: '2026-10-03',
    });
  });
});
