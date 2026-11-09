import { Button } from './ui';

// Round by round through any run, past or live. Round 0 is the board before the first
// round; "Latest" follows the head of the log again.

export interface ReplayScrubberProps {
  /** Rounds that have completed. */
  rounds: number;
  /** The round on screen, or null when following the head of the log. */
  cursor: number | null;
  /** Whether new events can still arrive. */
  live: boolean;
  onChange: (cursor: number | null) => void;
}

export const ReplayScrubber = ({ rounds, cursor, live, onChange }: ReplayScrubberProps) => {
  const shown = cursor ?? rounds;
  return (
    <div data-testid="replay" className="flex flex-wrap items-center gap-3">
      <Button
        aria-label="Previous round"
        disabled={shown <= 0}
        onClick={() => {
          onChange(Math.max(0, shown - 1));
        }}
      >
        ◀
      </Button>
      <input
        type="range"
        aria-label="Round"
        min={0}
        max={Math.max(rounds, 0)}
        step={1}
        value={shown}
        disabled={rounds === 0}
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
        className="min-w-40 flex-1 accent-accent"
      />
      <Button
        aria-label="Next round"
        disabled={shown >= rounds}
        onClick={() => {
          onChange(Math.min(rounds, shown + 1));
        }}
      >
        ▶
      </Button>
      <span data-testid="replay-position" className="text-sm tabular-nums">
        {cursor === null
          ? `Latest · ${String(rounds)} ${rounds === 1 ? 'round' : 'rounds'} completed`
          : `Round ${String(cursor)} of ${String(rounds)}`}
      </span>
      <Button
        variant={cursor === null ? 'ghost' : 'primary'}
        disabled={cursor === null}
        onClick={() => {
          onChange(null);
        }}
      >
        {live ? 'Back to live' : 'Latest'}
      </Button>
    </div>
  );
};
