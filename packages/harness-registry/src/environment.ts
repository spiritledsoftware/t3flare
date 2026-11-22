// The Environment settings (SPI-1149, ADR-0032): what the Cloud Environment gives every Workspace and its Container,
// apart from the Harness settings (ADR-0026). Kept in the Environment DO under their own key and revision, so a change
// here never makes a Session take the Harness settings again. Edited in the Settings page's Environment section; read by
// each Workspace DO before a Container start, and by the Environment DO's Sweep for the Grace (ADR-0043), which the page
// edits in its Workspaces section. Imported by both Workers.
//
// One schema (`ENVIRONMENT_SETTINGS`), one resolve (`resolveEnvironment`), one change (`applyEnvironmentChange`): a later
// setting (the Global mise config, SPI-1150; Variables, SPI-1152) is one entry in `ENVIRONMENT_SETTINGS`. The resolved
// type, the resolve, the validation and the panel's section all follow from it.
import { type EnvironmentSettingEntry, type EnvironmentValue, fieldProblem, normalizeField } from "./fields.ts";
import { fitVariables, MAX_VARIABLES, type Variable } from "./variables.ts";

export * from "./variables.ts";

/**
 * The Container budget's default (step 2a cost guardrails): at most this many Containers run at once across the deploy.
 * The owner changes it in the Environment settings (`containerBudget`, 1 to 10: a cost guard, far under the account's
 * concurrent limits); each Workspace DO carries it with its lease request.
 */
export const DEFAULT_CONTAINER_BUDGET = 3;

/** The most the Container budget may be set to. */
export const MAX_CONTAINER_BUDGET = 10;

/** The largest Global mise config, in bytes of UTF-8. */
export const MAX_GLOBAL_MISE_BYTES = 16 * 1024;

/**
 * The largest Image setup and Container setup, each, in bytes of UTF-8 (ADR-0047 §9). Fixed by a constraint: every
 * Environment setting is one stored value of at most 2 MB, and the Environment settings are one value together.
 */
export const MAX_SETUP_BYTES = 256 * 1024;

/** Why `text` cannot be an Image setup (a Test base build's proposal included): past `MAX_SETUP_BYTES`; undefined when it fits. */
export const imageSetupTooLong = (text: string): string | undefined => {
  const bytes = new TextEncoder().encode(text).length;
  return bytes > MAX_SETUP_BYTES ? `the Image setup is at most ${MAX_SETUP_BYTES / 1024} KiB, not ${bytes} bytes` : undefined;
};

/**
 * The most of a setup's output a report may keep, in KiB (`setupOutputKiB`'s bound). Fixed by a constraint: the
 * Environment DO keeps the last report, output and all, as one Durable Object value, which holds at most 2 MB.
 */
export const MAX_SETUP_OUTPUT_KIB = 256;

/** What a Container whose setup failed does (ADR-0047 §7): carries on, or refuses every command but a passive read. */
export const CONTAINER_SETUP_FAILURES = ["carryOn", "refuse"] as const;
export type ContainerSetupFailure = (typeof CONTAINER_SETUP_FAILURES)[number];

/**
 * The most days a scheduled rebuild may wait (ADR-0047 §3): the platform expires a snapshot 30 days after its creation
 * or last restore, and t3flare counts one older than 29 days as gone.
 */
export const MAX_REBUILD_DAYS = 29;

/** The Builder's size setting's value for "the Container size" (ADR-0047 §9). */
export const BUILDER_SAME_SIZE = "sameAsContainer";

/** The Environment settings a Base build reads besides the Global mise config and the Variables (ADR-0047 §9). */
export const BASE_BUILD_SETTING_KEYS = ["imageSetup", "imageSetupMinutes", "snapshotMinutes", "builderSize", "builderInBudget", "rebuildEveryDays"] as const;

/** The Grace's default and bounds, in days (ADR-0043 §1): no zero, since at once is the Owner's own Purge. */
export const DEFAULT_GRACE_DAYS = 7;
export const MAX_GRACE_DAYS = 3650;

/**
 * The Environment settings the Sweep reads (ADR-0043) and no Container does: they apply at the next Sweep, not at a
 * Container start, and the Settings page shows them in its Workspaces section, not its Environment section.
 */
export const SWEEP_SETTING_KEYS = ["sweepPurges", "graceDays"] as const;

/**
 * The dotfiles toggles (ADR-0047 §9): whether the Owner's own config in their home reaches Terminals and CLI agents. The
 * Settings page shows them in a row of their own. `terminalsReadBashrc` applies at a Container start (the Workspace DO
 * keeps it with the launch); `agentsReadDotfiles` at each CLI agent's start (the Environment DO reads it at the spawn).
 */
export const DOTFILES_SETTING_KEYS = ["terminalsReadBashrc", "agentsReadDotfiles"] as const;

/** A Container's resources, as `ctx.container.start({ instance })` takes a custom size. */
export interface ContainerResources {
  readonly vcpu: number;
  /** Mebibytes. */
  readonly memoryMib: number;
  /** Megabytes. */
  readonly diskMb: number;
}

/** The named types the runtime accepts under `schedulingPolicy: "durable_object"` that t3flare offers. */
export type NamedContainerType = "standard-1" | "standard-2" | "standard-3" | "standard-4";

/** What a start passes as `instance`: a named type, or a custom size's resources. Never omitted (that starts `lite`). */
export type ContainerInstance = NamedContainerType | ContainerResources;

/**
 * The Container sizes, by the name kept in the settings, smallest memory first. `cpu-1` is t3flare's size before this
 * setting (1 vCPU, 3 GiB, 12 GB), a custom size started as its resources; the others are Cloudflare's
 * named types, started by name, with the resources its limits page gives
 * (docs-archive-1:docs/steps/spi-1001-research-container-sizes.md §2). Not offered: `lite` and `basic` (the runtime refuses `basic`),
 * and other custom sizes. A stored name never changes meaning: adding a size is free, removing one needs a
 * rename map.
 */
export const CONTAINER_SIZES = {
  "cpu-1": { custom: true, resources: { vcpu: 1, memoryMib: 3072, diskMb: 12_000 } },
  "standard-1": { custom: false, resources: { vcpu: 0.5, memoryMib: 4096, diskMb: 8_000 } },
  "standard-2": { custom: false, resources: { vcpu: 1, memoryMib: 6144, diskMb: 12_000 } },
  "standard-3": { custom: false, resources: { vcpu: 2, memoryMib: 8192, diskMb: 16_000 } },
  "standard-4": { custom: false, resources: { vcpu: 4, memoryMib: 12_288, diskMb: 20_000 } },
} as const satisfies Readonly<Record<string, { readonly custom: boolean; readonly resources: ContainerResources }>>;

export type ContainerSize = keyof typeof CONTAINER_SIZES;

export const CONTAINER_SIZE_NAMES = Object.keys(CONTAINER_SIZES) as ReadonlyArray<ContainerSize>;

export const DEFAULT_CONTAINER_SIZE: ContainerSize = "cpu-1";

/**
 * What `ctx.container.start({ instance })` takes for `size`: a custom size's resources, a named type's name. Never
 * undefined (an omitted `instance` starts `lite`); a stored name t3flare does not offer resolves to the default first
 * (`resolveEnvironment`).
 */
export const containerInstance = (size: ContainerSize): ContainerInstance => {
  const entry = CONTAINER_SIZES[size];
  return entry.custom ? entry.resources : (size as NamedContainerType);
};

/** What the Builder's Container starts with (ADR-0047 §9): its own size, or the Container size. */
export const builderInstance = (settings: Pick<ResolvedEnvironment, "containerSize" | "builderSize">): ContainerInstance =>
  containerInstance(settings.builderSize === BUILDER_SAME_SIZE ? settings.containerSize : (settings.builderSize as ContainerSize));

/** What the Environment DO stores (`t3flare:environment:settings`): the settings set explicitly. */
export interface StoredEnvironment {
  /** Bumped by every change; never moved by a Harness settings change (and the reverse). */
  readonly revision: number;
  readonly settings: Readonly<Record<string, EnvironmentValue>>;
}

export const EMPTY_ENVIRONMENT: StoredEnvironment = { revision: 0, settings: {} };

/** The Environment settings' schema: the panel renders its section from it and the API validates against it. */
export const ENVIRONMENT_SETTINGS = {
  containerSize: {
    title: "Container size",
    description: "The vCPU, memory and disk a Workspace's Container starts with. Applies at each Workspace's next Container start; a running Container keeps its size.",
    schema: { type: "enum", values: CONTAINER_SIZE_NAMES, default: DEFAULT_CONTAINER_SIZE },
  },
  containerIdleMinutes: {
    title: "Idle time (minutes)",
    description: "A Container stops after this long without a command. Applies at each Workspace's next Container start.",
    schema: { type: "integer", minimum: 1, maximum: 60, default: 2 },
    tier: "free",
  },
  containerBudget: {
    title: "Container budget",
    description:
      "How many Containers may run at once across the Environment. Applies at the next start; lowering it stops no running Container, and new starts wait until fewer run.",
    schema: { type: "integer", minimum: 1, maximum: MAX_CONTAINER_BUDGET, default: DEFAULT_CONTAINER_BUDGET },
    tier: "down-free",
  },
  variables: {
    title: "Variables",
    description: `NAME=value pairs every command in a Workspace starts with: agents' commands, Terminals and CLI agents. A Secret one's value is stored sealed and never shown again, but every agent and command in a Workspace can read it, as on stock t3. Anything t3flare, t3, mise's [env] or the command itself sets wins over them. At most ${MAX_VARIABLES}. Applies at each Workspace's next Container start.`,
    schema: { type: "variables", default: [] },
  },
  globalMiseConfig: {
    title: "Global mise config",
    description:
      "A mise.toml every Container's commands get, under a repository's own and over the image's base tools. Laid down and installed at each Workspace's next Container start; a running Container keeps what it started with. Kept only if git and gh still run under it. Left empty, mise uses your dotfiles' ~/.config/mise/config.toml instead, if git and gh still run under that; the Dotfiles toggles don't change this. disable_tools and disable_backends are ignored. Agents can read this file: put no secret in it, [env] included.",
    schema: { type: "file", maxBytes: MAX_GLOBAL_MISE_BYTES, default: "" },
  },
  containerSetup: {
    title: "Container setup",
    description:
      "A bash script run once in every new Container before its first command, after the Global mise config: as root in / with HOME=/root and the Variables. Commands, Terminals and CLI agents wait for it. Status shows its exit and the end of its output, secret Variables blanked. Applies at each Workspace's next Container start.",
    schema: { type: "file", maxBytes: MAX_SETUP_BYTES, default: "" },
  },
  containerSetupMinutes: {
    title: "Container setup time limit (minutes)",
    description: "How long it may run before it is stopped and counts as failed.",
    schema: { type: "integer", minimum: 1, maximum: 60, default: 5 },
    tier: "down-free",
    row: "containerSetup",
  },
  containerSetupFailure: {
    title: "When the Container setup fails",
    description: "A non-zero exit, the time limit, or a Container that could not run it. Refuse commands: that Container runs no command, Terminal or CLI agent until a new Container starts.",
    schema: { type: "enum", values: CONTAINER_SETUP_FAILURES, default: "carryOn", labels: { carryOn: "Carry on", refuse: "Refuse commands" } },
    row: "containerSetup",
  },
  setupOutputKiB: {
    title: "Setup output kept (KiB)",
    description:
      "The last part of a setup's output that the Status section keeps and shows, secret Variables blanked: the Container setup's and the Base build's Image setup's. 4 to 256 KiB, 32 by default. Applies at each Workspace's next Container start and the next Base build; a report already kept stays as it is.",
    schema: { type: "integer", minimum: 4, maximum: MAX_SETUP_OUTPUT_KIB, default: 32 },
    tier: "down-free",
    row: "containerSetup",
  },
  imageSetup: {
    title: "Image setup",
    description:
      "A bash script run once, as root with HOME=/root and every Variable (secret ones included), on the Workspace image after the Global mise config is laid down; its result is the Base snapshot. Once saved, a change builds a new one in the Builder, as a deploy and Rebuild do. Whatever it writes, a secret included, is in every Workspace's Container until the next Base build. Empty with no Global mise config, there is nothing to build.",
    schema: { type: "file", maxBytes: MAX_SETUP_BYTES, default: "" },
  },
  imageSetupMinutes: {
    title: "Image setup time limit (minutes)",
    description: "How long the Builder's Container may take to start and run the Image setup before the Base build fails.",
    schema: { type: "integer", minimum: 1, maximum: 120, default: 30 },
    tier: "down-free",
    row: "imageSetup",
  },
  snapshotMinutes: {
    title: "Snapshot time limit (minutes)",
    description: "How long the snapshot and the start from it that proves it may take before the Base build is reported failed. A snapshot that finishes later is still kept if nothing changed meanwhile.",
    schema: { type: "integer", minimum: 1, maximum: 15, default: 5 },
    tier: "down-free",
    row: "imageSetup",
  },
  builderSize: {
    title: "Builder size",
    description: "The vCPU, memory and disk the Builder's Container runs the Image setup with. Every Container size starts from the Base snapshot it makes.",
    schema: { type: "enum", values: [BUILDER_SAME_SIZE, ...CONTAINER_SIZE_NAMES], default: BUILDER_SAME_SIZE, labels: { [BUILDER_SAME_SIZE]: "Same as Container size" } },
    row: "imageSetup",
  },
  builderInBudget: {
    title: "Builder counts against the Container budget",
    description: "On, the Builder waits for room under the Container budget before it starts, and holds one place while it runs. Off, it runs beside the budget's Containers.",
    schema: { type: "boolean", default: false },
    row: "imageSetup",
  },
  rebuildEveryDays: {
    title: "Rebuild every (days)",
    description: `Builds the Base snapshot again this many days after the last good one, so the Image setup's downloads stay current. 0 is off. At most ${MAX_REBUILD_DAYS}: a Base snapshot expires 30 days after it was made.`,
    schema: { type: "integer", minimum: 0, maximum: MAX_REBUILD_DAYS, default: 0 },
    row: "imageSetup",
  },
  terminalsReadBashrc: {
    title: "Terminals read ~/.bashrc",
    description:
      "A Terminal's shell runs your ~/.bashrc, so your aliases, functions and prompt are there. Off, it starts with t3flare's shell setup alone. Applies at each Workspace's next Container start.",
    schema: { type: "boolean", default: true },
    tier: "down-free",
  },
  agentsReadDotfiles: {
    title: "CLI agents read your dotfiles",
    description:
      "Each CLI agent starts with a copy of your config for it (~/.claude and ~/.claude.json, ~/.codex, ~/.config/opencode, ~/.pi/agent, except its auth.json): your instructions, settings, hooks, skills and plugins. t3flare's model routing and managed settings still win, and Codex's shells get t3flare's environment (its inherit, exclude and include_only). An Environment skill wins over one of yours of the same name in Claude Code, OpenCode and pi; Codex shows both skills. Off, an agent starts with t3flare's config alone. Applies at each CLI agent's next start.",
    schema: { type: "boolean", default: true },
    tier: "down-free",
  },
  sweepPurges: {
    title: "Purge after the Grace",
    description:
      "Whether the Sweep purges a Workspace nothing references, a Tombstone with a date, and a deleted thread's Session once the Grace has passed. Off, the Sweep still marks what is unreferenced and purges nothing. Turned on, nothing is purged until one Grace after. Applies at the next Sweep.",
    schema: { type: "boolean", default: true },
    tier: "down-free",
  },
  graceDays: {
    title: "Grace (days)",
    description:
      "How many days the Sweep keeps a Workspace nothing references, a Tombstone with a date, and a deleted thread's Session before it purges them. A change moves the date of everything already waiting. Applies at the next Sweep.",
    schema: { type: "integer", minimum: 1, maximum: MAX_GRACE_DAYS, default: DEFAULT_GRACE_DAYS },
    tier: "up-free",
  },
} as const satisfies Readonly<Record<string, EnvironmentSettingEntry>>;

export type EnvironmentKey = keyof typeof ENVIRONMENT_SETTINGS;

const ENVIRONMENT_KEYS = Object.keys(ENVIRONMENT_SETTINGS) as ReadonlyArray<EnvironmentKey>;

/** The value a field of `schema` holds: an enum's own names, a number, a boolean or text (a `file` field's too). */
type ValueOf<Schema> = Schema extends { readonly type: "enum"; readonly values: ReadonlyArray<infer Name> }
  ? Name
  : Schema extends { readonly type: "integer" }
    ? number
    : Schema extends { readonly type: "boolean" }
      ? boolean
      : Schema extends { readonly type: "variables" }
        ? ReadonlyArray<Variable>
        : string;

/** What a Workspace DO reads: every setting resolved, a stored value that no longer fits read as its default. */
export type ResolvedEnvironment = { readonly revision: number } & {
  readonly [Key in EnvironmentKey]: ValueOf<(typeof ENVIRONMENT_SETTINGS)[Key]["schema"]>;
};

/** Setting `key`'s entry, typed as any Environment setting (the schema's own type is narrower per key). */
export const settingOf = (key: EnvironmentKey): EnvironmentSettingEntry => ENVIRONMENT_SETTINGS[key];

/** Whether `value` fits setting `key`'s schema. */
export const fitsEnvironmentSetting = (key: EnvironmentKey, value: unknown): boolean =>
  fieldProblem(settingOf(key).schema, value) === undefined;

/**
 * The settings every Workspace DO starts its Container with. `settings` is what was stored, or an answer from an
 * Environment newer or older than this Worker: a value that is missing or no longer fits reads as its default.
 */
export const resolveEnvironment = (stored: { readonly revision: number; readonly settings: Readonly<Record<string, unknown>> }): ResolvedEnvironment => {
  const resolved: Record<string, unknown> = { revision: stored.revision };
  for (const key of ENVIRONMENT_KEYS) {
    const value = stored.settings[key];
    const schema = settingOf(key).schema;
    // Variables: one a later rule refuses is dropped alone, never the whole set (ADR-0032's Variables refinement).
    if (schema.type === "variables") resolved[key] = fitVariables(value);
    else resolved[key] = value !== undefined && fitsEnvironmentSetting(key, value) ? value : schema.default;
  }
  // SAFETY: every key of the schema was set above, each to a value its schema accepts.
  return resolved as ResolvedEnvironment;
};

/**
 * The stored Environment settings as a read shows them (ADR-0046): a set of Variables as `fitVariables` reads it, each
 * secret's sealed value as its fingerprint. Everything else as stored.
 */
export const readStoredEnvironment = (stored: StoredEnvironment): StoredEnvironment =>
  stored.settings.variables === undefined ? stored : { ...stored, settings: { ...stored.settings, variables: fitVariables(stored.settings.variables) } };

/**
 * Whether two settings' values, as read, are equal: a scalar by identity, Variables by their names, values and Secret
 * toggles in order, a secret by its fingerprint (the same value sealed again is no change).
 */
const sameValue = (a: unknown, b: unknown): boolean => a === b || (typeof a === "object" && a !== null && typeof b === "object" && b !== null && JSON.stringify(a) === JSON.stringify(b));

/** One change from the panel or a script: some of the settings. */
export interface EnvironmentChange {
  readonly settings: Readonly<Record<string, unknown>>;
}

/**
 * `stored` with `change` applied, or why it is refused. `changed` names the settings whose resolved value moved; only
 * they are stored and the revision is bumped only when there is one (a form posts every setting on each save).
 */
export const applyEnvironmentChange = (
  stored: StoredEnvironment,
  change: EnvironmentChange,
): { readonly ok: true; readonly environment: StoredEnvironment; readonly changed: ReadonlyArray<EnvironmentKey> } | { readonly ok: false; readonly error: string } => {
  if (Object.keys(change.settings).length === 0) return { ok: false, error: "the change sets nothing" };
  for (const key of Object.keys(change.settings)) if (!Object.hasOwn(ENVIRONMENT_SETTINGS, key)) return { ok: false, error: `${key}: no such setting` };
  const entries = Object.entries(change.settings).map(([key, value]) => [key, normalizeField(settingOf(key as EnvironmentKey).schema, value)] as const);
  for (const [key, value] of entries) {
    const why = fieldProblem(settingOf(key as EnvironmentKey).schema, value);
    if (why !== undefined) return { ok: false, error: `${key}: ${why}` };
  }
  const before: Readonly<Record<string, unknown>> = resolveEnvironment(stored);
  // Compared as read: a set of Variables as `fitVariables` reads it, its secrets by their fingerprints.
  const moved = entries.filter(([key, value]) => !sameValue(before[key], settingOf(key as EnvironmentKey).schema.type === "variables" ? fitVariables(value) : value));
  if (moved.length === 0) return { ok: true, environment: stored, changed: [] };
  return {
    ok: true,
    environment: { revision: stored.revision + 1, settings: { ...stored.settings, ...(Object.fromEntries(moved) as Record<string, EnvironmentValue>) } },
    changed: moved.map(([key]) => key as EnvironmentKey),
  };
};
