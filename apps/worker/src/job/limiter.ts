// A small concurrency limit (§19): at most `size` tasks run at once; the rest wait their turn, in
// order. The verify job has one for recording slots (2) and one for the judge queue.
export class Limiter {
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  readonly size: number;

  constructor(size: number) {
    this.size = size;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.size) await new Promise<void>((go) => this.#waiting.push(go));
    this.#active++;
    try {
      return await task();
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }
}
