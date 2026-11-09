import { AGENT_ROLES, isPaidProvider, type ResolvedModel, type RunProfile } from '@team/core';
import type { BudgetResponse } from '@team/server/api';

import { percent, usd } from '../lib/format';
import { fractionOf } from '../lib/gauge';
import type { StartRunCheck, StartRunDraft, StartRunProblem } from '../lib/start-run';
import { Meter } from './cost-meter';
import { Badge, Button, ErrorNote } from './ui';

// The start-run dialog's form (docs/budget-guardrails.md §5): the same facts the CLI's
// banner prints before a paid run (profile, resolved models, per-run cap, month-to-date
// spend against the limit), and the same explicit yes before anything can be billed.
//
// It is controlled: the draft and the verdict of `checkStartRun` come in as props.

const field = 'rounded border border-line-strong bg-surface px-2 py-1.5 text-sm';

const ModelRow = ({ name, model }: { name: string; model: ResolvedModel }) => (
  <tr className="border-b border-line last:border-b-0">
    <th scope="row" className="py-1 pr-3 text-left font-normal capitalize">
      {name}
    </th>
    <td className="py-1 pr-3 font-mono text-xs">{model.alias}</td>
    <td className="py-1 pr-3 text-xs">
      {model.provider}/{model.model}
    </td>
    <td className="py-1 text-right">
      {isPaidProvider(model.provider) ? (
        <Badge tone="accent" icon="$">
          paid
        </Badge>
      ) : (
        <Badge>free</Badge>
      )}
    </td>
  </tr>
);

const explain = (problem: StartRunProblem): string | null => {
  switch (problem.kind) {
    case 'monthly_budget':
      return `This cap does not fit the month: ${usd(problem.spentUsd, 2)} of ${usd(problem.limitUsd, 2)} is spent, so a per-run cap of ${usd(problem.fitsCapUsd)} or less would fit.`;
    case 'budget_unknown':
      return 'This month’s spend has not been read yet, so a paid run cannot be checked against the monthly limit.';
    case 'bad_cap':
      return 'The per-run cap must be a number of dollars, zero or more.';
    case 'bad_rounds':
      return 'The round limit must be a whole number, one or more.';
    // Shown by the form itself: an empty problem and an unticked box need no error text.
    case 'no_problem':
    case 'no_profile':
    case 'unconfirmed':
      return null;
  }
};

export interface StartRunFormProps {
  draft: StartRunDraft;
  profiles: readonly RunProfile[];
  /** Undefined while the month's figure has not been read. */
  budget: BudgetResponse | undefined;
  check: StartRunCheck;
  /** The request is on its way (a local profile warms its model first, which can take a minute). */
  starting: boolean;
  /** What the server said when it refused, in its own words. */
  serverError: string | null;
  /** The fields the user just changed. */
  onChange: (patch: Partial<StartRunDraft>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export const StartRunForm = ({
  draft,
  profiles,
  budget,
  check,
  starting,
  serverError,
  onChange,
  onSubmit,
  onCancel,
}: StartRunFormProps) => {
  const profile = profiles.find((p) => p.name === draft.profile);
  const set = onChange;
  const explanations = check.problems.flatMap((problem) => {
    const text = explain(problem);
    return text === null ? [] : [{ kind: problem.kind, text }];
  });

  return (
    <form
      data-testid="start-run-form"
      data-paid={check.paid ? 'true' : 'false'}
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (check.canStart && !starting) onSubmit();
      }}
    >
      <label className="flex flex-col gap-1 text-sm font-medium">
        Problem
        <textarea
          name="problem"
          required
          rows={4}
          value={draft.problem}
          placeholder="What should the team work out?"
          onChange={(event) => {
            set({ problem: event.target.value });
          }}
          className={`${field} font-normal`}
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Constraints <span className="text-xs font-normal text-ink-2">one per line, optional</span>
          <textarea
            name="constraints"
            rows={2}
            value={draft.constraints}
            onChange={(event) => {
              set({ constraints: event.target.value });
            }}
            className={`${field} font-normal`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Success criteria{' '}
          <span className="text-xs font-normal text-ink-2">one per line, optional</span>
          <textarea
            name="successCriteria"
            rows={2}
            value={draft.successCriteria}
            onChange={(event) => {
              set({ successCriteria: event.target.value });
            }}
            className={`${field} font-normal`}
          />
        </label>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Profile</legend>
        {profiles.map((option) => (
          <label key={option.name} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="profile"
              value={option.name}
              checked={draft.profile === option.name}
              onChange={() => {
                // A different profile is a different decision: the yes does not carry over.
                set({ profile: option.name, confirmed: false });
              }}
            />
            <span className="font-medium">{option.name}</span>
            {option.paid ? (
              <Badge tone="accent" icon="$">
                paid: calls the Anthropic API
              </Badge>
            ) : (
              <Badge>free: local models only</Badge>
            )}
          </label>
        ))}
      </fieldset>

      {profile === undefined ? null : (
        <table data-testid="resolved-models" className="w-full text-sm">
          <caption className="mb-1 text-left text-sm font-medium">
            Models for “{profile.name}”
          </caption>
          <tbody>
            {AGENT_ROLES.map((role) => (
              <ModelRow key={role} name={role} model={profile.roles[role]} />
            ))}
            {profile.fallback === null ? (
              <tr>
                <th scope="row" className="py-1 pr-3 text-left font-normal">
                  Fallback
                </th>
                <td colSpan={3} className="py-1 text-xs text-ink-2">
                  none: an answer that fails its schema is repaired once, then discarded
                </td>
              </tr>
            ) : (
              <ModelRow name="fallback" model={profile.fallback} />
            )}
          </tbody>
        </table>
      )}

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Per-run cap (USD)
          <input
            name="maxCostUsd"
            inputMode="decimal"
            value={draft.maxCostUsd}
            onChange={(event) => {
              set({ maxCostUsd: event.target.value });
            }}
            className={`${field} font-normal tabular-nums`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Round limit
          <input
            name="maxRounds"
            inputMode="numeric"
            value={draft.maxRounds}
            onChange={(event) => {
              set({ maxRounds: event.target.value });
            }}
            className={`${field} font-normal tabular-nums`}
          />
        </label>
      </div>

      <div data-testid="month-budget">
        {budget === undefined ? (
          <p className="text-sm text-ink-2">Reading this month’s spend…</p>
        ) : (
          <>
            <Meter
              id="dialog-month"
              label="This month (API)"
              value={budget.spentUsd}
              limit={budget.limitUsd}
              warnAt={budget.warnAtFraction}
              format={(amount) => usd(amount, 2)}
            />
            <p className="mt-1 text-xs text-ink-2">
              {check.paid
                ? `A paid run may spend up to its cap on top of this: ${percent(fractionOf(budget.spentUsd, budget.limitUsd))} of the month is used.`
                : 'This profile spends nothing: every role runs on a local model.'}
            </p>
          </>
        )}
      </div>

      {check.paid ? (
        <label className="flex items-start gap-2 rounded border border-line-strong p-2 text-sm">
          <input
            type="checkbox"
            name="confirmed"
            checked={draft.confirmed}
            onChange={(event) => {
              set({ confirmed: event.target.checked });
            }}
            className="mt-0.5"
          />
          <span>
            I understand this run calls paid models and may spend up to{' '}
            <strong>{draft.maxCostUsd === '' ? 'its cap' : `$${draft.maxCostUsd}`}</strong> of the
            API budget.
          </span>
        </label>
      ) : null}

      {explanations.map(({ kind, text }) => (
        <ErrorNote key={kind}>{text}</ErrorNote>
      ))}
      {serverError === null ? null : <ErrorNote>{serverError}</ErrorNote>}

      <div className="flex items-center justify-end gap-2">
        {starting ? (
          <span className="mr-auto text-xs text-ink-2">
            Starting… a local profile checks Ollama and warms its model first, which can take a
            minute.
          </span>
        ) : null}
        <Button onClick={onCancel} disabled={starting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!check.canStart || starting}>
          {starting ? 'Starting…' : 'Start run'}
        </Button>
      </div>
    </form>
  );
};
