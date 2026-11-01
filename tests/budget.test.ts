import { describe, expect, it } from 'vitest';
import { BudgetTracker } from '../src/budget';

describe('budget warnings', () => {
  it('triggers the configured warning threshold', () => {
    const warning = new BudgetTracker(1000, null, 0.8);
    warning.settle(0, 700, 100, 0, true);
    expect(warning.isWarningTriggered()).toBe(true);

    const below = new BudgetTracker(1000, null, 0.8);
    below.settle(0, 700, 99, 0, true);
    expect(below.isWarningTriggered()).toBe(false);
  });
});
