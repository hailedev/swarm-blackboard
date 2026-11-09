import { err, ok, type Result } from '../ports/result';
import { AGENT_ROLES, type AgentRole } from '../schemas/role';
import {
  isPaidProvider,
  NO_FALLBACK,
  RosterSchema,
  type ResolvedModel,
  type Roster,
  type RunProfile,
} from '../schemas/roster';

// Load-time validation of agents.yaml (docs/budget-guardrails.md §1, ADR-0009). The host
// parses the file; core checks that every alias resolves and that no profile can reach a
// paid model by accident.

export type RosterError =
  | { kind: 'invalid_roster'; issues: readonly string[] }
  | { kind: 'unknown_default_profile'; name: string; known: readonly string[] }
  | {
      kind: 'unknown_model_alias';
      profile: string;
      role: string;
      alias: string;
      known: readonly string[];
    }
  | { kind: 'unknown_fallback_alias'; profile: string; alias: string; known: readonly string[] }
  /** Every role is local but the fallback is paid: almost certainly a mistake. */
  | { kind: 'paid_fallback_on_local_profile'; profile: string; fallback: string };

export type ProfileError =
  | { kind: 'unknown_profile'; name: string; known: readonly string[] }
  | Extract<RosterError, { kind: 'unknown_model_alias' | 'unknown_fallback_alias' }>;

const aliasIsPaid = (roster: Roster, alias: string): boolean => {
  const model = roster.models[alias];
  return model !== undefined && isPaidProvider(model.provider);
};

export const loadRoster = (raw: unknown): Result<Roster, RosterError> => {
  const parsed = RosterSchema.safeParse(raw);
  if (!parsed.success) {
    return err({
      kind: 'invalid_roster',
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
      ),
    });
  }
  const roster = parsed.data;
  const known = Object.keys(roster.models);
  if (!(roster.defaultProfile in roster.profiles)) {
    return err({
      kind: 'unknown_default_profile',
      name: roster.defaultProfile,
      known: Object.keys(roster.profiles),
    });
  }
  for (const [name, profile] of Object.entries(roster.profiles)) {
    const roleAliases: [string, string][] = [];
    for (const [role, alias] of Object.entries(profile.roles)) {
      if (!(alias in roster.models)) {
        return err({ kind: 'unknown_model_alias', profile: name, role, alias, known });
      }
      roleAliases.push([role, alias]);
    }
    if (profile.fallback === NO_FALLBACK) continue;
    if (!(profile.fallback in roster.models)) {
      return err({ kind: 'unknown_fallback_alias', profile: name, alias: profile.fallback, known });
    }
    const everyRoleLocal = roleAliases.every(([, alias]) => !aliasIsPaid(roster, alias));
    if (everyRoleLocal && aliasIsPaid(roster, profile.fallback)) {
      return err({
        kind: 'paid_fallback_on_local_profile',
        profile: name,
        fallback: profile.fallback,
      });
    }
  }
  return ok(roster);
};

export const resolveProfile = (
  roster: Roster,
  name: string = roster.defaultProfile,
): Result<RunProfile, ProfileError> => {
  const profile = roster.profiles[name];
  if (profile === undefined) {
    return err({ kind: 'unknown_profile', name, known: Object.keys(roster.profiles) });
  }
  const known = Object.keys(roster.models);
  const resolve = (alias: string): ResolvedModel | undefined => {
    const model = roster.models[alias];
    return model === undefined ? undefined : { alias, ...model };
  };

  const entries: [AgentRole, ResolvedModel][] = [];
  for (const role of AGENT_ROLES) {
    const alias = profile.roles[role];
    const resolved = resolve(alias);
    if (resolved === undefined) {
      return err({ kind: 'unknown_model_alias', profile: name, role, alias, known });
    }
    entries.push([role, resolved]);
  }
  const roles = Object.fromEntries(entries) as Record<AgentRole, ResolvedModel>;

  let bidder: ResolvedModel | null = null;
  if (profile.roles.bidder !== undefined) {
    const resolved = resolve(profile.roles.bidder);
    if (resolved === undefined) {
      return err({
        kind: 'unknown_model_alias',
        profile: name,
        role: 'bidder',
        alias: profile.roles.bidder,
        known,
      });
    }
    bidder = resolved;
  }

  let fallback: ResolvedModel | null = null;
  if (profile.fallback !== NO_FALLBACK) {
    const resolved = resolve(profile.fallback);
    if (resolved === undefined) {
      return err({ kind: 'unknown_fallback_alias', profile: name, alias: profile.fallback, known });
    }
    fallback = resolved;
  }

  const paid = [...Object.values(roles), bidder, fallback].some(
    (model) => model !== null && isPaidProvider(model.provider),
  );
  return ok({ name, roles, bidder, fallback, paid });
};

const list = (names: readonly string[]): string => names.map((n) => `"${n}"`).join(', ');

export const describeRosterError = (error: RosterError | ProfileError): string => {
  switch (error.kind) {
    case 'invalid_roster':
      return `agents.yaml is invalid: ${error.issues.join('; ')}`;
    case 'unknown_default_profile':
      return `defaultProfile "${error.name}" is not defined; profiles are ${list(error.known)}`;
    case 'unknown_profile':
      return `unknown profile "${error.name}"; valid profiles are ${list(error.known)}`;
    case 'unknown_model_alias':
      return `profile "${error.profile}" gives role ${error.role} the unknown model alias "${error.alias}"; known aliases are ${list(error.known)}`;
    case 'unknown_fallback_alias':
      return `profile "${error.profile}" falls back to the unknown model alias "${error.alias}"; known aliases are ${list(error.known)}`;
    case 'paid_fallback_on_local_profile':
      return `profile "${error.profile}" runs every role locally but falls back to the paid model "${error.fallback}"; use "fallback: none" or make the paid choice explicit in a role`;
  }
};
