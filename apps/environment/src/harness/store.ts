// @effect-diagnostics globalConsole:off
// The Settings page's two entities and its audit log in the Environment DO's storage: the Harness settings (ADR-0026) and
// the Environment settings (ADR-0032), each under its own key with its own revision, so a change to one never makes the
// other's readers take it again. Sessions take a new Harness revision at a turn's start; Workspace DOs take a new
// Environment revision before a Container start. One audit log for both, append-only, 1 000 entries kept, fewer when
// they would not fit the one Durable Object value it is (SPI-1365), each with its `entity`; it holds no secret value (parts 2-4's secrets are masked before an entry is written).
import {
  type BaseBuildRecord,
  baseBuildRecord,
  type ContainerSetupReport,
  containerSetupReport,
  DO_VALUE_BYTES,
  EMPTY_ENVIRONMENT,
  EMPTY_HARNESS,
  type GlobalMiseReport,
  globalMiseReport,
  type StoredEnvironment,
  STORED_CHARACTER_BYTES,
  storedBytes,
  type StoredHarness,
  type T3ToolListing,
  t3ToolListing,
} from "@t3flare/harness-registry";

import { keptKey, type KvStorage } from "./keys.ts";

export const SETTINGS_KEY = "t3flare:harness:settings";
export const ENVIRONMENT_KEY = "t3flare:environment:settings";
export const AUDIT_KEY = "t3flare:harness:audit";
const CSRF_KEY = "t3flare:harness:csrf-key";
const READ_KEY = "t3flare:harness:last-read";
const ENVIRONMENT_READ_KEY = "t3flare:environment:last-read";
const GLOBAL_MISE_KEY = "t3flare:environment:global-mise";
const CONTAINER_SETUP_KEY = "t3flare:environment:container-setup";
/** The Base build's record, as the Builder last reported it (SPI-1332). */
export const BASE_BUILD_KEY = "t3flare:base-build";
/** The last Test base build's record, as the test Builder last reported it (SPI-1334): kept until the next test. */
export const TEST_BASE_BUILD_KEY = "t3flare:test-base-build";
const T3_TOOLS_KEY = "t3flare:harness:t3-tools";
export const AUDIT_KEPT = 1_000;

/**
 * Which entity on the panel's page a change was to: an open set, `"harness"` and `"environment"` today (the Model
 * endpoints, SPI-1162, add theirs). An entry written before SPI-1149 has none and was to the Harness settings.
 */
export type AuditEntity = "harness" | "environment" | (string & {});

/**
 * Who made a change and through which door (plan D15). Every field but `caller` is optional; an entry without `via` was
 * made on the panel.
 */
export interface AuditActor {
  /** `owner:<sub>`, `service-token`, `agent:<thread>` or `oauth`. */
  readonly caller: string;
  readonly via?: "panel" | "mcp";
  /** The calling thread and its agent kind (t3flare's own agents). */
  readonly thread?: string;
  readonly agent?: string;
  /** An Owner client's own label, unverified. */
  readonly client?: { readonly name: string; readonly source: string };
  readonly tier?: "free" | "asked";
  /** The Open change's Elicitation mode, for an asked change. */
  readonly mode?: "card" | "browser" | "native" | "model";
  /** What answered an asked change. */
  readonly answeredBy?: "card" | "page" | "client" | "agent";
  /** The Open change's id. */
  readonly change?: string;
}

export interface AuditEntry extends AuditActor {
  readonly at: number;
  readonly entity: AuditEntity;
  readonly action: string;
  readonly target: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

/**
 * An entry under `workspaces` (ADR-0044 §4): the Owner's Purge, Restore and Stop, a run of the Sweep, and each
 * Workspace the Sweep purges.
 */
export const auditWorkspace = (input: {
  readonly at: number;
  readonly actor: AuditActor;
  readonly action: string;
  readonly target: string;
  readonly before?: unknown;
  readonly after: unknown;
}): AuditEntry => ({
  at: input.at,
  entity: "workspaces",
  ...input.actor,
  action: input.action,
  target: input.target,
  ...(input.before === undefined ? {} : { before: input.before }),
  after: input.after,
});

/** A Session or a Workspace DO took the settings: when, and which revision. */
export interface LastRead {
  readonly revision: number;
  readonly at: number;
}

export interface HarnessStore {
  load(): StoredHarness;
  save(harness: StoredHarness): void;
  loadEnvironment(): StoredEnvironment;
  saveEnvironment(environment: StoredEnvironment): void;
  audit(entry: AuditEntry): void;
  auditLog(limit: number): ReadonlyArray<AuditEntry>;
  /** The CSRF HMAC key, made on first use. */
  csrfKey(): Uint8Array<ArrayBuffer>;
  /** A Session took the Harness settings (Status shows when, and which revision). */
  noteRead(revision: number, at: number): void;
  lastRead(): LastRead | undefined;
  /** A Workspace DO took the Environment settings. */
  noteEnvironmentRead(revision: number, at: number): void;
  lastEnvironmentRead(): LastRead | undefined;
  /**
   * A Workspace DO's Global mise lay-down (SPI-1150): kept when it is a well-formed report, the last one only, across
   * all Workspaces. Answers whether it was kept.
   */
  noteGlobalMise(report: unknown): boolean;
  lastGlobalMise(): GlobalMiseReport | undefined;
  /**
   * A Workspace DO's Container setup (ADR-0047 §7): kept when it is a well-formed report, the last one only, across all
   * Workspaces. Answers whether it was kept.
   */
  noteContainerSetup(report: unknown): boolean;
  lastContainerSetup(): ContainerSetupReport | undefined;
  /**
   * The Builder's record of the Base build (SPI-1332): kept when well-formed and no older than the one kept (its reports
   * may arrive out of order). Answers whether it was kept.
   */
  noteBaseBuild(record: unknown): boolean;
  lastBaseBuild(): BaseBuildRecord | undefined;
  /** The test Builder's record of a Test base build (SPI-1334), kept as `noteBaseBuild` keeps the Base build's. */
  noteTestBaseBuild(record: unknown): boolean;
  lastTestBaseBuild(): BaseBuildRecord | undefined;
  /** t3's tools as a Session last listed them (the t3-code card's list): kept when well-formed. Answers whether it was kept. */
  noteT3Tools(listing: unknown): boolean;
  lastT3Tools(): T3ToolListing | undefined;
}

/**
 * Keeps a Builder's record under `key` when well-formed, of the right Builder (`test`), and no older than the one kept (its
 * reports may arrive out of order). Answers whether it was kept.
 */
const noteBuild = (kv: KvStorage, key: string, record: unknown, test: boolean): boolean => {
  const valid = baseBuildRecord(record);
  if (valid === undefined || (valid.test === true) !== test) return false;
  const kept = baseBuildRecord(kv.get<unknown>(key));
  if (kept !== undefined && kept.at > valid.at) return false;
  kv.put(key, valid);
  return true;
};

/**
 * The most one audit entry may take of the log's one value: half of it, so a single change (Variables or endpoints near
 * their own value's size, before and after) never pushes most of the log out. A larger entry keeps its record and says
 * how large its values were in their place.
 */
const AUDIT_ENTRY_BYTES = DO_VALUE_BYTES / 2;

/** `entry`, its values replaced by their size when it is past `AUDIT_ENTRY_BYTES`. */
const fitAuditEntry = (entry: AuditEntry): AuditEntry => {
  const bytes = storedBytes(entry);
  if (bytes <= AUDIT_ENTRY_BYTES) return entry;
  const omitted = { omitted: `${bytes} bytes stored, more than one audit entry keeps` };
  return {
    ...entry,
    ...(entry.before === undefined ? {} : { before: omitted }),
    ...(entry.after === undefined ? {} : { after: omitted }),
  };
};

/**
 * `log` with `entry` as one Durable Object value holds it (`DO_VALUE_BYTES`): the new entry fitted first
 * (`fitAuditEntry`), then the oldest entries dropped until the rest fit.
 */
const fitAuditLog = (log: ReadonlyArray<AuditEntry>, entry: AuditEntry): ReadonlyArray<AuditEntry> => {
  const all = [...log, fitAuditEntry(entry)].slice(-AUDIT_KEPT);
  // Each entry with its comma, and the list's brackets, as `storedBytes` counts the whole list.
  const sizes = all.map((each) => storedBytes(each) + STORED_CHARACTER_BYTES);
  let total = sizes.reduce((sum, size) => sum + size, STORED_CHARACTER_BYTES);
  let from = 0;
  while (total > DO_VALUE_BYTES && from < all.length - 1) total -= sizes[from++]!;
  return all.slice(from);
};

export const harnessStore = (kv: KvStorage): HarnessStore => ({
  load: () => kv.get<StoredHarness>(SETTINGS_KEY) ?? EMPTY_HARNESS,
  save: (harness) => kv.put(SETTINGS_KEY, harness),
  loadEnvironment: () => kv.get<StoredEnvironment>(ENVIRONMENT_KEY) ?? EMPTY_ENVIRONMENT,
  saveEnvironment: (environment) => kv.put(ENVIRONMENT_KEY, environment),
  audit: (entry) => {
    const log = kv.get<AuditEntry[]>(AUDIT_KEY) ?? [];
    kv.put(AUDIT_KEY, fitAuditLog(log, entry));
    // One line per change for Workers Logs, never a value.
    console.log(
      JSON.stringify({
        t3flare: "harness-change",
        entity: entry.entity,
        caller: entry.caller.split(":")[0],
        action: entry.action,
        target: entry.target,
        via: entry.via,
        tier: entry.tier,
        mode: entry.mode,
        answeredBy: entry.answeredBy,
      }),
    );
  },
  auditLog: (limit) =>
    (kv.get<Array<Omit<AuditEntry, "entity"> & { readonly entity?: AuditEntity }>>(AUDIT_KEY) ?? [])
      .slice(-limit)
      .reverse()
      .map((entry) => ({ ...entry, entity: entry.entity ?? "harness" })),
  csrfKey: () => keptKey(kv, CSRF_KEY),
  noteRead: (revision, at) => kv.put(READ_KEY, { revision, at }),
  lastRead: () => kv.get<LastRead>(READ_KEY),
  noteEnvironmentRead: (revision, at) => kv.put(ENVIRONMENT_READ_KEY, { revision, at }),
  noteGlobalMise: (report) => {
    const valid = globalMiseReport(report);
    if (valid === undefined) return false;
    kv.put(GLOBAL_MISE_KEY, valid);
    return true;
  },
  lastGlobalMise: () => globalMiseReport(kv.get<unknown>(GLOBAL_MISE_KEY)),
  noteContainerSetup: (report) => {
    const valid = containerSetupReport(report);
    if (valid === undefined) return false;
    kv.put(CONTAINER_SETUP_KEY, valid);
    return true;
  },
  lastContainerSetup: () => containerSetupReport(kv.get<unknown>(CONTAINER_SETUP_KEY)),
  // A test's record is never kept as the Base build's, nor the other way (SPI-1334): its snapshot is never used.
  noteBaseBuild: (record) => noteBuild(kv, BASE_BUILD_KEY, record, false),
  lastBaseBuild: () => baseBuildRecord(kv.get<unknown>(BASE_BUILD_KEY)),
  noteTestBaseBuild: (record) => noteBuild(kv, TEST_BASE_BUILD_KEY, record, true),
  lastTestBaseBuild: () => baseBuildRecord(kv.get<unknown>(TEST_BASE_BUILD_KEY)),
  noteT3Tools: (listing) => {
    const valid = t3ToolListing(listing);
    if (valid === undefined) return false;
    // The latest listing wins: a Session waking on an older catalog does not replace a newer thread's.
    const kept = t3ToolListing(kv.get<unknown>(T3_TOOLS_KEY));
    if (kept !== undefined && kept.listedAt >= valid.listedAt) return false;
    kv.put(T3_TOOLS_KEY, valid);
    return true;
  },
  lastT3Tools: () => t3ToolListing(kv.get<unknown>(T3_TOOLS_KEY)),
  lastEnvironmentRead: () => kv.get<LastRead>(ENVIRONMENT_READ_KEY),
});
