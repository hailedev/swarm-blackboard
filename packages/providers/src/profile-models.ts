import {
  AGENT_ROLES,
  err,
  isPaidProvider,
  ok,
  type AgentRole,
  type Model,
  type ResolvedModel,
  type Result,
  type RunProfile,
} from '@team/core';

import { createModelFactory, describeFactoryError, type ModelFactoryOptions } from './factory';
import {
  describeOllamaPreflightError,
  preflightOllama,
  type OllamaPreflightOptions,
  type OllamaPreflightReport,
} from './ollama-preflight';

// How a host turns a resolved profile into the models a run uses: the factory builds one
// traced, retrying model per alias, then the local tags are checked and warmed so the
// first real call does not pay a cold load or fail on a sleeping server. The CLI and the
// server share this so neither can build models any other way (CLAUDE.md rule 6).

export interface ProfileModels {
  roles: Record<AgentRole, Model>;
  fallback: Model | undefined;
  /** The pre-flight report when local tags were checked; null when there were none. */
  ollama: OllamaPreflightReport | null;
}

export type ProfileModelsError =
  { kind: 'factory'; message: string } | { kind: 'ollama'; message: string };

export type PreflightOverrides = Partial<
  Pick<OllamaPreflightOptions, 'fetch' | 'timeoutMs' | 'loadTimeoutMs' | 'keepAlive' | 'warm'>
>;

export interface ProfileModelsOptions extends ModelFactoryOptions {
  /** Tune the Ollama pre-flight, or `false` to skip it (tests, or a host that did it already). */
  preflight?: PreflightOverrides | false;
  /** Progress lines a host may print: the pre-flight can take seconds to a minute. */
  onProgress?: (message: string) => void;
}

/** The distinct local model tags a profile can call: every local role plus a local fallback. */
export const localTags = (profile: RunProfile): string[] => [
  ...new Set(
    [...AGENT_ROLES.map((role) => profile.roles[role]), profile.fallback]
      .filter((m): m is ResolvedModel => m !== null && !isPaidProvider(m.provider))
      .map((m) => m.model),
  ),
];

export const createProfileModels = async (
  profile: RunProfile,
  options: ProfileModelsOptions,
): Promise<Result<ProfileModels, ProfileModelsError>> => {
  const factory = createModelFactory(options);
  const roles: Partial<Record<AgentRole, Model>> = {};
  for (const role of AGENT_ROLES) {
    const built = factory.modelFor(profile.roles[role]);
    if (!built.ok) return err({ kind: 'factory', message: describeFactoryError(built.error) });
    roles[role] = built.value;
  }
  let fallback: Model | undefined;
  if (profile.fallback !== null) {
    const built = factory.modelFor(profile.fallback);
    if (!built.ok) return err({ kind: 'factory', message: describeFactoryError(built.error) });
    fallback = built.value;
  }

  let ollama: OllamaPreflightReport | null = null;
  const tags = localTags(profile);
  if (tags.length > 0 && options.preflight !== false) {
    options.onProgress?.(
      `Checking Ollama at ${options.ollamaBaseUrl} and warming ${tags.join(', ')}…`,
    );
    const ready = await preflightOllama({
      baseUrl: options.ollamaBaseUrl,
      models: tags,
      ...options.preflight,
    });
    if (!ready.ok) {
      return err({ kind: 'ollama', message: describeOllamaPreflightError(ready.error) });
    }
    ollama = ready.value;
    options.onProgress?.(`Ollama ${ollama.version} is ready.`);
  }
  return ok({ roles: roles as Record<AgentRole, Model>, fallback, ollama });
};

export const describeProfileModelsError = (error: ProfileModelsError): string => error.message;
