import type { RunRecordStatus } from '@team/server/api';
import { describe, expect, it } from 'vitest';

import { hasFlag, render, text } from '../testing/markup';
import { Controls, type ControlsProps } from './controls';
import { ReplayScrubber } from './replay-scrubber';

const controls = (status: RunRecordStatus, overrides: Partial<ControlsProps> = {}): string =>
  render(
    <Controls
      status={status}
      replaying={false}
      synthesisPending={false}
      busy={null}
      error={null}
      onAction={() => undefined}
      onNote={() => undefined}
      {...overrides}
    />,
  );

/** Each button's label and whether it is disabled, in order. */
const buttons = (html: string): [string, boolean][] =>
  [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(([tag, label = '']) => [
    label,
    hasFlag(tag.slice(0, tag.indexOf('>') + 1), 'disabled'),
  ]);

describe('Controls', () => {
  it('offers pause, force synthesis and stop to a running run', () => {
    expect(buttons(controls('running'))).toEqual([
      ['Pause', false],
      ['Force synthesis', false],
      ['Stop', false],
      // Nothing to add until something is typed.
      ['Add note', true],
    ]);
  });

  it('offers resume in place of pause to a paused run, and still takes notes and requests', () => {
    expect(buttons(controls('paused')).map(([label]) => label)).toEqual([
      'Resume',
      'Force synthesis',
      'Stop',
      'Add note',
    ]);
    expect(controls('paused')).toContain('Add a note the agents will read next round');
  });

  it('has nothing to steer once a run has ended', () => {
    for (const status of ['completed', 'failed', 'stopped'] as const) {
      const html = controls(status);
      expect(buttons(html)).toEqual([]);
      expect(text(html)).toBe('This run has ended; it can be replayed but not steered.');
    }
  });

  it('shows a synthesis that is already owed instead of asking for another', () => {
    const html = controls('running', { synthesisPending: true });
    expect(buttons(html)).toContainEqual(['Synthesis requested', true]);
    expect(buttons(html)).toContainEqual(['Pause', false]);
  });

  it('locks while an action is on its way and says which', () => {
    const pausing = buttons(controls('running', { busy: 'pause' }));
    expect(pausing[0]).toEqual(['Pausing after this round…', true]);
    expect(pausing.every(([, disabled]) => disabled)).toBe(true);
    expect(buttons(controls('running', { busy: 'stop' }))[2]?.[0]).toBe(
      'Stopping after this round…',
    );
    expect(buttons(controls('paused', { busy: 'resume' }))[0]?.[0]).toBe('Resuming…');
    expect(buttons(controls('running', { busy: 'note' })).at(-1)?.[0]).toBe('Adding…');
  });

  it('locks while an earlier round is on screen, and says how to get back', () => {
    const html = controls('running', { replaying: true });
    expect(buttons(html).every(([, disabled]) => disabled)).toBe(true);
    expect(text(html)).toContain('Return to the latest round to steer the run.');
  });

  it('shows what the server said when an action was refused', () => {
    const html = controls('running', { error: 'the run is completed' });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain('the run is completed');
  });
});

describe('ReplayScrubber', () => {
  const scrubber = (rounds: number, cursor: number | null, live = false): string =>
    render(
      <ReplayScrubber rounds={rounds} cursor={cursor} live={live} onChange={() => undefined} />,
    );
  const range = (html: string): string => /<input type="range"[^>]*>/.exec(html)?.[0] ?? '';

  it('follows the head of the log until a round is picked', () => {
    const html = scrubber(12, null);
    expect(text(html)).toContain('Latest · 12 rounds completed');
    expect(range(html)).toContain('max="12"');
    expect(range(html)).toContain('value="12"');
    expect(buttons(html)).toEqual([
      ['◀', false],
      ['▶', true],
      ['Latest', true],
    ]);
    expect(text(scrubber(1, null))).toContain('Latest · 1 round completed');
  });

  it('shows the round being replayed and offers the way back', () => {
    const html = scrubber(12, 3, true);
    expect(text(html)).toContain('Round 3 of 12');
    expect(range(html)).toContain('value="3"');
    expect(buttons(html)).toEqual([
      ['◀', false],
      ['▶', false],
      ['Back to live', false],
    ]);
    // Round 0 is the board before the first round: there is nothing earlier.
    expect(buttons(scrubber(12, 0))[0]).toEqual(['◀', true]);
  });

  it('has nothing to scrub before the first round completes', () => {
    const html = scrubber(0, null, true);
    expect(hasFlag(range(html), 'disabled')).toBe(true);
    expect(buttons(html).every(([, disabled]) => disabled)).toBe(true);
  });
});
