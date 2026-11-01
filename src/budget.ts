import { BudgetExceededError } from './errors.js';

export interface BudgetSnapshot {
  limitTokens: number;
  usedTokens: number;
  reservedTokens: number;
  remainingTokens: number;
  limitUsd: number | null;
  usedUsd: number;
  priced: boolean;
}

export class BudgetTracker {
  readonly limitTokens: number;
  readonly limitUsd: number | null;
  readonly warnAt: number;
  private usedTokens = 0;
  private reservedTokens = 0;
  private usedUsd = 0;
  private priced = true;

  constructor(limitTokens: number, limitUsd: number | null = null, warnAt = 0.8) {
    if (!Number.isFinite(limitTokens) || limitTokens <= 0) {
      throw new Error('Budget limit must be a positive number.');
    }
    this.limitTokens = limitTokens;
    this.limitUsd = limitUsd;
    this.warnAt = warnAt;
  }

  get remainingTokens(): number {
    return Math.max(0, this.limitTokens - this.usedTokens - this.reservedTokens);
  }

  isWarningTriggered(): boolean {
    return (
      this.usedTokens > 0 &&
      this.usedTokens >= this.limitTokens * this.warnAt &&
      this.usedTokens < this.limitTokens
    );
  }

  reserve(estimate: number): number {
    const amount = Math.max(0, Math.ceil(estimate));
    if (amount > this.remainingTokens) {
      throw new BudgetExceededError(
        `Token budget exceeded: need ${amount}, remaining ${this.remainingTokens} of ${this.limitTokens}.`,
      );
    }
    this.reservedTokens += amount;
    return amount;
  }

  settle(
    reservation: number,
    inputTokens: number,
    outputTokens: number,
    costUsd: number,
    priced: boolean,
  ): void {
    this.reservedTokens = Math.max(0, this.reservedTokens - reservation);
    this.usedTokens += Math.max(0, inputTokens) + Math.max(0, outputTokens);
    this.usedUsd += Math.max(0, costUsd);
    if (!priced) this.priced = false;
  }

  snapshot(): BudgetSnapshot {
    return {
      limitTokens: this.limitTokens,
      usedTokens: this.usedTokens,
      reservedTokens: this.reservedTokens,
      remainingTokens: this.remainingTokens,
      limitUsd: this.limitUsd,
      usedUsd: this.usedUsd,
      priced: this.priced,
    };
  }
}
