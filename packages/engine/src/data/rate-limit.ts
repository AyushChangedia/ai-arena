import { sleep } from './http';

/** Token-bucket limiter: at most `ratePerSecond` acquisitions per second, with a burst of `burst`. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly ratePerSecond: number,
    private readonly burst = 1,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSecond);
    this.last = t;
  }

  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.wait(Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000));
    }
  }
}
