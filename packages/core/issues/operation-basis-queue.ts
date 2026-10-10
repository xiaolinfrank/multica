/** Limit concurrent reads across all observed surfaces without dropping selected IDs. */
export class OperationBasisReadQueue {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly limit = 4) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("A read queue needs a positive concurrency limit");
  }

  run<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancelled = () => {
        const error = new Error("Operation basis read cancelled");
        error.name = "AbortError";
        return error;
      };
      if (signal.aborted) { reject(cancelled()); return; }
      const abortQueued = () => {
        this.waiting = this.waiting.filter((candidate) => candidate !== start);
        reject(cancelled());
      };
      const start = () => {
        signal.removeEventListener("abort", abortQueued);
        if (signal.aborted) { reject(cancelled()); this.drain(); return; }
        this.active += 1;
        void Promise.resolve().then(read).then(resolve, reject).finally(() => {
          this.active -= 1;
          this.drain();
        });
      };
      signal.addEventListener("abort", abortQueued, { once: true });
      this.waiting.push(start);
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.limit && this.waiting.length) this.waiting.shift()!();
  }
}
