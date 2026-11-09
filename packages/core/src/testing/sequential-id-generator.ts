import type { IdGenerator } from '../ports/ids';

const PREFIX = '00000000-0000-7000-8000-';

// A valid UUID v7-shaped id whose last 12 hex digits are `n`. Lets scripted
// contributions and test assertions refer to the n-th generated id.
export const sequentialId = (n: number): string => `${PREFIX}${n.toString(16).padStart(12, '0')}`;

export class SequentialIdGenerator implements IdGenerator {
  #counter: number;

  /** `start` lets a second generator continue after ids another one already issued. */
  constructor(start = 0) {
    this.#counter = start;
  }

  next(): string {
    this.#counter += 1;
    return sequentialId(this.#counter);
  }

  get issued(): number {
    return this.#counter;
  }
}
