import type { BoardEvent } from '../schemas/event';
import type { Result } from './result';

export type StoreError =
  | { kind: 'out_of_order'; runId: string; expected: number; actual: number }
  | { kind: 'unavailable'; message: string };

// Append-only event log per run (ADR-0004). Async so that the SQLite and any later
// Postgres implementation fit the same contract.
export interface BoardStore {
  append(event: BoardEvent): Promise<Result<void, StoreError>>;
  eventsFor(runId: string): Promise<readonly BoardEvent[]>;
}
