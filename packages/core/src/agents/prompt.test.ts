import { describe, expect, it } from 'vitest';

import { AGENT_ROLES } from '../schemas/role';
import { agentContext } from '../testing/agent-context';
import { BoardFixture } from '../testing/board-fixture';
import { testRolePrompts } from '../testing/role-prompts';
import { freshBoard, lateBoard, midRunBoard } from '../testing/sample-boards';
import { renderAgentPrompt, renderRepairPrompt } from './prompt';
import { roleDefinitions } from './roster';

const PROMPTS = testRolePrompts();

// Prompt inputs are snapshot-tested (CLAUDE.md): the same board must always render the
// same prompt. Each role sees the mid-run board with the targets its own trigger picks.
describe('renderAgentPrompt snapshots', () => {
  it.each(AGENT_ROLES)('renders the mid-run board for the %s', (role) => {
    const { fx } = midRunBoard();
    const view = fx.view();
    const probe = agentContext({ runId: fx.runId, round: 4 });
    const trigger = roleDefinitions[role].trigger(view, probe);
    const ctx = agentContext({ runId: fx.runId, round: 4, targetIds: trigger.targetIds });
    const rendered = renderAgentPrompt(role, view, ctx, PROMPTS[role]);
    expect(rendered.system).toBe(PROMPTS[role]);
    expect(rendered.prompt).toMatchSnapshot();
  });

  it('renders the fresh board for the planner and the late board for the synthesizer', () => {
    const fresh = freshBoard();
    const planner = renderAgentPrompt(
      'planner',
      fresh.fx.view(),
      agentContext({ runId: fresh.fx.runId, targetIds: [fresh.problem.id] }),
      PROMPTS.planner,
    );
    expect(planner.prompt).toMatchSnapshot();
    expect(planner.handles).toEqual(['P1']);

    const late = lateBoard();
    const view = late.fx.view();
    const trigger = roleDefinitions.synthesizer.trigger(view, agentContext({ round: 5 }));
    const synthesizer = renderAgentPrompt(
      'synthesizer',
      view,
      agentContext({ runId: late.fx.runId, round: 5, targetIds: trigger.targetIds }),
      PROMPTS.synthesizer,
    );
    expect(synthesizer.prompt).toMatchSnapshot();
  });
});

describe('renderAgentPrompt', () => {
  it('shows the problem by handle, every human note, the targets and the active flags', () => {
    const { fx, hypotheses } = midRunBoard();
    const target = hypotheses[0];
    if (target === undefined) throw new Error('fixture changed');
    const { prompt, handles } = renderAgentPrompt(
      'critic',
      fx.view(),
      agentContext({ round: 4, targetIds: [target.id], flags: { criticForced: true } }),
      PROMPTS.critic,
    );
    expect(prompt).toContain('Round 4 of 12.');
    expect(prompt).toContain('# Problem (P1)');
    expect(prompt).toContain('Constraints:\n- No more than two weeks of migration effort');
    expect(prompt).toContain('Success criteria:\n- A recommendation that names the main risk');
    expect(prompt).toContain('# Human notes\n- N1 (priority high): ');
    expect(prompt).toContain(
      'Prefer any option that keeps the three deploy pipelines independent.',
    );
    expect(prompt).toContain('## [hypothesis] H1 (target)');
    expect(prompt).toContain('parents: S1, S2');
    expect(prompt).toContain('source=repository audit, October 2026 supports=H1 contradicts=-');
    expect(prompt).toContain('# Your targets\nH1');
    expect(prompt).toContain('Control flags: criticForced');
    expect(prompt).toMatch(
      /Return JSON matching the schema\. Reference entries only by the handles shown above \(P problem, [^)]*N human note\), copied exactly\.$/,
    );
    // Every handle the prompt names, and nothing else, is offered as a link.
    expect(handles).toEqual(['P1', 'S1', 'S2', 'S3', 'H1', 'E1', 'E2', 'C1', 'Q1', 'N1']);
    for (const handle of handles) expect(prompt).toMatch(new RegExp(`\\b${handle}\\b`));
    expect(prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('hides superseded entries and shows what a live entry supersedes', () => {
    const { fx, subproblems } = midRunBoard();
    const claimed = subproblems[0];
    if (claimed?.supersedes === undefined) throw new Error('fixture changed');
    const { prompt } = renderAgentPrompt(
      'solver',
      fx.view(),
      agentContext({ round: 4, targetIds: [claimed.id] }),
      PROMPTS.solver,
    );
    expect(prompt).toContain('## [subproblem] S3 (target)');
    expect(prompt).toContain('round 2, by solver, supersedes S1');
    expect(prompt).not.toContain('## [subproblem] S1');
    expect(prompt).not.toContain('[subproblem] S1 r');
  });

  it('copes with an empty board and no targets', () => {
    const { prompt, handles } = renderAgentPrompt(
      'solver',
      new BoardFixture().view(),
      agentContext({ targetIds: ['not-an-id'] }),
      PROMPTS.solver,
    );
    expect(prompt).toContain('# Problem\n(no problem entry on the board)');
    expect(prompt).toContain('# Entries in focus\n(none)');
    expect(prompt).toContain('# Rest of the board\n(nothing else)');
    expect(prompt).toContain('# Your targets\n(none: act on the board as a whole)');
    expect(prompt).not.toContain('# Human notes');
    expect(prompt).not.toContain('Control flags');
    expect(handles).toEqual([]);
  });
});

describe('renderRepairPrompt', () => {
  it('appends the schema issues and the clipped previous answer', () => {
    const repaired = renderRepairPrompt('BOARD', { issues: ['a: bad'], raw: 'x'.repeat(5_000) });
    expect(repaired.startsWith('BOARD\n\n# Your previous answer was rejected')).toBe(true);
    expect(repaired).toContain('- a: bad');
    expect(repaired).toContain(`${'x'.repeat(4_000)}…`);
    expect(repaired).not.toContain('x'.repeat(4_001));
    expect(repaired).toMatch(/by the handles shown on the board, copied exactly\.$/);
  });

  it('clips an issue that lists every allowed handle', () => {
    const issue = `parents.0: Invalid option: expected one of ${Array.from({ length: 80 }, (_, i) => `"H${String(i)}"`).join('|')}`;
    const repaired = renderRepairPrompt('BOARD', { issues: [issue], raw: '{}' });
    expect(repaired).toContain(`- ${issue.slice(0, 200)}…`);
    expect(repaired).not.toContain(issue);
  });
});
