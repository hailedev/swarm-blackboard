import type { Trigger } from '../agents/agent';

export interface Candidate {
  agentId: string;
  trigger: Trigger;
}

/** Selected in each of this many consecutive previous rounds → skipped, unless nobody else is eligible. */
export const DIVERSITY_WINDOW = 2;

// Rule-based priority selection (docs/PLAN.md §2.3 step 4; bidding arrives in Phase 5).
// Stable sort by priority, so ties fall back to roster order.
export const selectAgents = (
  candidates: readonly Candidate[],
  parallelism: number,
  history: readonly (readonly string[])[],
): string[] => {
  const eligible = candidates.filter((c) => c.trigger.eligible);
  const recent = history.slice(-DIVERSITY_WINDOW);
  const blocked = new Set(
    recent.length === DIVERSITY_WINDOW
      ? eligible
          .filter((c) => recent.every((round) => round.includes(c.agentId)))
          .map((c) => c.agentId)
      : [],
  );
  const ranked = [...eligible].sort((a, b) => b.trigger.priority - a.trigger.priority);
  const allowed = ranked.filter((c) => !blocked.has(c.agentId));
  const pool = allowed.length > 0 ? allowed : ranked;
  return pool.slice(0, parallelism).map((c) => c.agentId);
};
