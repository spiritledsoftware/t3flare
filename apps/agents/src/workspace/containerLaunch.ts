// @effect-diagnostics globalTimers:off
// What a Workspace's Container starts with (SPI-1149, ADR-0032): the Environment settings, read from the Environment DO
// before a start with a bounded wait, as a Session reads the Harness settings at a turn's start; on no answer the copy
// the Workspace DO last kept, else the defaults. A start never waits on the Environment longer than the bound, and
// never omits `instance` (an omitted one starts `lite`).
import {
  type ContainerInstance,
  containerInstance,
  digestOf,
  type ContainerSize,
  EMPTY_ENVIRONMENT,
  type ResolvedEnvironment,
  resolveEnvironment,
  type SettingsSource,
  variableEnv,
} from "@t3flare/harness-registry";

import type { ContainerSetupLaunch } from "./containerSetup.ts";
import type { GlobalMiseLaunch } from "./globalMise.ts";

/** How long a Container start waits for the Environment's settings before it starts with the ones it kept. */
export const ENVIRONMENT_READ_MS = 5_000;

export interface TakeEnvironmentDeps {
  /** The Environment DO's `environmentSettings()`. */
  readonly read: () => Promise<ResolvedEnvironment>;
  readonly kept: () => ResolvedEnvironment | undefined;
  readonly keep: (settings: ResolvedEnvironment) => void;
  readonly waitMs: number;
}

/** Settings for a start and where they came from: only an `environment` read is fresh. */
export interface TakenEnvironment {
  readonly settings: ResolvedEnvironment;
  readonly source: SettingsSource;
}

/**
 * The settings for the next Container start, and where they came from. Never fails. The Environment's answer and the
 * kept copy are both read against this Worker's schema (a newer or older version may hold a value this one does not
 * know, which reads as its default, or lack a setting, which gets its default); the answer is then kept.
 */
export const takeEnvironment = async (deps: TakeEnvironmentDeps): Promise<TakenEnvironment> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      deps.read(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), deps.waitMs);
      }),
    ]);
    if (answer !== undefined) {
      const settings = resolveEnvironment({ revision: answer.revision, settings: answer });
      deps.keep(settings);
      return { settings, source: "environment" };
    }
  } catch {
    // The Environment DO failed: the kept copy below.
  } finally {
    clearTimeout(timer);
  }
  // The kept copy is read against this Worker's schema too: another version may have kept a size this one does not
  // offer, or lack a setting this one has.
  const kept = deps.kept();
  return kept === undefined
    ? { settings: resolveEnvironment(EMPTY_ENVIRONMENT), source: "default" }
    : { settings: resolveEnvironment({ revision: kept.revision, settings: kept }), source: "kept" };
};

/** What one Container start launches with, kept while it runs: a running Container keeps its size and idle time. */
export interface ContainerLaunch {
  readonly size: ContainerSize;
  readonly instance: ContainerInstance;
  readonly idleMs: number;
  /**
   * The Container budget carried with this start's lease request (the budget DO judges it, ADR-0032): only from a fresh
   * read, so a kept copy or the defaults never overwrite the owner's newer budget in the budget DO.
   */
  readonly budget?: number;
  /** The Environment settings' revision it came from. */
  readonly revision: number;
  /**
   * The Variables every command in the Workspace starts with until the next start (SPI-1152, `variables.ts`). A launch
   * recorded before them has none.
   */
  readonly variables?: Readonly<Record<string, string>>;
  /**
   * Which of `variables` are secret (ADR-0046): `containerState()` shows them as set, never their values, and the
   * Container setup's reported output has their values blanked (`secretValuesOf`).
   */
  readonly secretVariables?: ReadonlyArray<string>;
  /**
   * The Global mise config this start lays down (SPI-1150), with its digest and where the settings came from. Absent in
   * a launch recorded before SPI-1150; `containerState()` shows only its digest.
   */
  readonly globalMise?: GlobalMiseLaunch;
  /**
   * The Container setup this start runs (ADR-0047 §7), with its digest, time limit and failure policy. Absent in a
   * launch recorded before it; `containerState()` shows only its digest.
   */
  readonly containerSetup?: ContainerSetupLaunch;
}

/** `launch` with the Global mise config and the Container setup of `taken` (their digests are async, so apart from `launchOf`). */
export const withScripts = async (launch: ContainerLaunch, { settings, source }: TakenEnvironment): Promise<ContainerLaunch> => ({
  ...launch,
  globalMise: { text: settings.globalMiseConfig, ...(await digestOf(settings.globalMiseConfig)), revision: settings.revision, source },
  containerSetup: {
    text: settings.containerSetup,
    ...(await digestOf(settings.containerSetup)),
    revision: settings.revision,
    source,
    minutes: settings.containerSetupMinutes,
    failure: settings.containerSetupFailure,
    outputBytes: settings.setupOutputKiB * 1024,
  },
});

/** What `containerState()` shows for a secret Variable's value. */
export const SECRET_SHOWN = "(secret, set)";

/** The opened values of the secret Variables `launch` started with (`secretVariables`): blanked in the setup's output. */
export const secretValuesOf = (launch: ContainerLaunch | undefined): ReadonlyArray<string> => {
  const secrets = new Set(launch?.secretVariables ?? []);
  return Object.entries(launch?.variables ?? {})
    .filter(([name]) => secrets.has(name))
    .map(([, value]) => value);
};

/**
 * A launch as `containerState()` shows it: the Global mise config's and the Container setup's digests, never their
 * text; a secret Variable as set.
 */
export const shownLaunch = (
  launch: ContainerLaunch,
): Omit<ContainerLaunch, "globalMise" | "containerSetup"> & { readonly globalMise?: Omit<GlobalMiseLaunch, "text">; readonly containerSetup?: Omit<ContainerSetupLaunch, "text"> } => {
  const { globalMise, containerSetup, ...rest } = launch;
  const secrets = new Set(launch.secretVariables ?? []);
  const variables = rest.variables === undefined || secrets.size === 0 ? rest.variables : Object.fromEntries(Object.entries(rest.variables).map(([name, value]) => [name, secrets.has(name) ? SECRET_SHOWN : value]));
  const digestOnly = <T extends { readonly text: string }>(script: T): Omit<T, "text"> => {
    const { text: _text, ...digest } = script;
    return digest;
  };
  return {
    ...rest,
    ...(variables === undefined ? {} : { variables }),
    ...(globalMise === undefined ? {} : { globalMise: digestOnly(globalMise) }),
    ...(containerSetup === undefined ? {} : { containerSetup: digestOnly(containerSetup) }),
  };
};

/** The launch for the settings `taken` (`takeEnvironment`'s, already read against this Worker's schema). */
export const launchOf = ({ settings, source }: TakenEnvironment): ContainerLaunch => ({
  size: settings.containerSize,
  instance: containerInstance(settings.containerSize),
  idleMs: settings.containerIdleMinutes * 60_000,
  ...(source === "environment" ? { budget: settings.containerBudget } : {}),
  revision: settings.revision,
  variables: variableEnv(settings.variables),
  ...(settings.variables.some((variable) => variable.secret) ? { secretVariables: settings.variables.filter((variable) => variable.secret).map((variable) => variable.name) } : {}),
});
