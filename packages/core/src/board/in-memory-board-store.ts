import type { BoardStore, StoreError } from '../ports/board-store';
import { err, ok, type Result } from '../ports/result';
import type { BoardEvent } from '../schemas/event';

// Pure in-memory event log. Events must arrive with contiguous `seq` per run.
export class InMemoryBoardStore implements BoardStore {
  readonly #runs = new Map<string, BoardEvent[]>();

  append(event: BoardEvent): Promise<Result<void, StoreError>> {
    const events = this.#runs.get(event.runId) ?? [];
    if (event.seq !== events.length) {
      return Promise.resolve(
        err({
          kind: 'out_of_order',
          runId: event.runId,
          expected: events.length,
          actual: event.seq,
        }),
      );
    }
    events.push(event);
    this.#runs.set(event.runId, events);
    return Promise.resolve(ok(undefined));
  }

  eventsFor(runId: string): Promise<readonly BoardEvent[]> {
    return Promise.resolve([...(this.#runs.get(runId) ?? [])]);
  }

  runIds(): readonly string[] {
    return [...this.#runs.keys()];
  }
}
