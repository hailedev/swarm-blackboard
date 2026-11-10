import type { ModelCallDetail, ModelCallSummary } from '@team/server/api';

import { clockTime, compact, usd } from '../lib/format';
import { Badge, Button, cx, ErrorNote, type Tone } from './ui';

// Every model call of the run (CLAUDE.md architecture rule 6): what was asked, what came
// back, tokens estimated and actual, cost and latency.

const BILLING: Record<string, { label: string; tone: Tone }> = {
  api: { label: 'paid', tone: 'accent' },
  local: { label: 'local', tone: 'neutral' },
  fake: { label: 'fake', tone: 'neutral' },
};

const promptTokens = (call: ModelCallSummary): number | null =>
  call.inputTokens === null
    ? null
    : call.inputTokens + (call.cacheReadTokens ?? 0) + (call.cacheWriteTokens ?? 0);

const dash = (value: number | null, format: (n: number) => string = compact): string =>
  value === null ? '—' : format(value);

export interface TraceTableProps {
  calls: readonly ModelCallSummary[];
  selectedId: string | null;
  onSelect: (callId: string) => void;
}

export const TraceTable = ({ calls, selectedId, onSelect }: TraceTableProps) => {
  if (calls.length === 0) {
    return <p className="p-3 text-sm text-ink-2">No model calls have been traced for this run.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table data-testid="trace-table" className="w-full text-left text-sm">
        <thead className="text-xs text-ink-2">
          <tr className="border-b border-line">
            {[
              'Round',
              'Role',
              'Model',
              'Outcome',
              'Prompt tokens (est.)',
              'Output (thinking)',
              'Cost',
              'Latency',
              'At',
            ].map((heading) => (
              <th key={heading} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {calls.map((call) => {
            const billing = BILLING[call.billing] ?? { label: call.billing, tone: 'neutral' };
            return (
              <tr
                key={call.id}
                data-call-id={call.id}
                aria-selected={call.id === selectedId}
                tabIndex={0}
                onClick={() => {
                  onSelect(call.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onSelect(call.id);
                }}
                className={cx(
                  'cursor-pointer border-b border-line hover:bg-sunken',
                  call.id === selectedId && 'bg-sunken',
                )}
              >
                <td className="px-3 py-1.5">{dash(call.round, String)}</td>
                <td className="px-3 py-1.5">{call.role}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  {call.modelId} <Badge tone={billing.tone}>{billing.label}</Badge>
                </td>
                <td className="px-3 py-1.5">
                  <Badge
                    tone={call.outcome === 'ok' ? 'good' : 'critical'}
                    icon={call.outcome === 'ok' ? '✓' : '✕'}
                  >
                    {call.outcome}
                  </Badge>
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  {dash(promptTokens(call))}{' '}
                  <span className="text-ink-2">({dash(call.estimateTokens)})</span>
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  {dash(call.outputTokens)}{' '}
                  <span className="text-ink-2">({dash(call.reasoningTokens)})</span>
                </td>
                <td className="px-3 py-1.5">{dash(call.costUsd, usd)}</td>
                <td className="px-3 py-1.5">{(call.latencyMs / 1_000).toFixed(1)}s</td>
                <td className="px-3 py-1.5 whitespace-nowrap text-ink-2">{clockTime(call.at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const pretty = (json: string | null): string => {
  if (json === null) return '';
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
};

const warningsOf = (json: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const Block = ({ title, text }: { title: string; text: string }) => (
  <section className="mt-3">
    <h4 className="mb-1 text-xs font-semibold tracking-wide text-ink-2 uppercase">{title}</h4>
    <pre className="max-h-96 overflow-auto rounded border border-line bg-sunken p-2 text-xs break-words whitespace-pre-wrap">
      {text === '' ? '(empty)' : text}
    </pre>
  </section>
);

export interface CallDetailProps {
  /** The call in full, or undefined while it loads. */
  call: ModelCallDetail | undefined;
  error: string | null;
  onClose: () => void;
}

export const CallDetail = ({ call, error, onClose }: CallDetailProps) => (
  <div data-testid="call-detail" className="p-3">
    <div className="flex items-start justify-between gap-2">
      <h3 className="text-sm font-semibold">
        {call === undefined
          ? 'Model call'
          : `${call.role} · round ${dash(call.round, String)} · ${call.modelId}`}
      </h3>
      <Button variant="ghost" aria-label="Close call" onClick={onClose}>
        ✕
      </Button>
    </div>
    {error === null ? null : <ErrorNote>{error}</ErrorNote>}
    {call === undefined ? (
      error === null ? (
        <p className="text-sm text-ink-2">Loading the call…</p>
      ) : null
    ) : (
      <>
        <p className="mt-1 text-xs text-ink-2">
          {call.outcome} · {(call.latencyMs / 1_000).toFixed(1)}s · {dash(call.costUsd, usd)} ·
          output {dash(call.outputTokens)} of {dash(call.maxOutputTokens)} allowed, thinking{' '}
          {dash(call.reasoningTokens)} · estimate {dash(call.estimateChars)} chars at{' '}
          {dash(call.estimateCharsPerToken, (n) => n.toFixed(2))} per token
        </p>
        {call.error === null ? null : <Block title="Error" text={call.error} />}
        {warningsOf(call.warningsJson).length === 0 ? null : (
          <Block title="Warnings" text={warningsOf(call.warningsJson).join('\n')} />
        )}
        <Block title="System prompt" text={call.system ?? ''} />
        <Block title="Prompt" text={call.prompt ?? ''} />
        <Block title="Response" text={pretty(call.responseJson)} />
      </>
    )}
  </div>
);
