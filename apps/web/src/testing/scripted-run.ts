import {
  createController,
  createDefaultAgents,
  InMemoryBoardStore,
  nullLogger,
  type BoardEvent,
  type Controller,
} from '@team/core';
import {
  createScriptedModels,
  ManualClock,
  SequentialIdGenerator,
  testRolePrompts,
} from '@team/core/testing';

// A real controller over the scripted swarm, so UI tests fold logs the controller itself
// wrote (pauses, notes, forced syntheses included) instead of hand-built ones.

export interface ScriptedRun {
  controller: Controller;
  /** Every event so far, in order; grows as the controller runs. */
  events: BoardEvent[];
  clock: ManualClock;
}

export const scriptedRun = async (
  /** Called after every event, the problem's own included; steer or move the clock here. */
  onEvent?: (event: BoardEvent, controller: Controller, clock: ManualClock) => void,
): Promise<ScriptedRun> => {
  const events: BoardEvent[] = [];
  const clock = new ManualClock();
  const ref: { controller: Controller | undefined } = { controller: undefined };
  const models = createScriptedModels(() => {
    if (ref.controller === undefined) throw new Error('controller not ready');
    return ref.controller.currentView();
  });
  const controller = createController({
    store: new InMemoryBoardStore(),
    clock,
    ids: new SequentialIdGenerator(),
    logger: nullLogger,
    agents: createDefaultAgents(models, testRolePrompts()),
    onEvent: (event) => {
      events.push(event);
      if (ref.controller !== undefined) onEvent?.(event, ref.controller, clock);
    },
  });
  ref.controller = controller;
  const started = await controller.start({ content: 'Should we adopt a monorepo?' });
  if (!started.ok) throw new Error(`the scripted run did not start: ${started.error.kind}`);
  return { controller, events, clock };
};

/**
 * The envelope of the event that would follow `events`, for the cases the script never
 * produces (a failed agent, a budget warning): spread it and add the event's own fields.
 */
export const nextEnvelope = (
  events: readonly BoardEvent[],
): Pick<BoardEvent, 'id' | 'runId' | 'seq' | 'at'> => {
  const last = events.at(-1);
  if (last === undefined) throw new Error('no event to follow');
  return {
    id: `00000000-0000-7000-8000-${(events.length + 0xf000).toString(16).padStart(12, '0')}`,
    runId: last.runId,
    seq: events.length,
    at: last.at,
  };
};
