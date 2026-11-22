// Secret Variables at the Environment DO's edge (ADR-0046 §1): a change's secret values are sealed with the Stage's
// credentials key before the change is validated, tiered, shown, kept as an Open change or stored, and are opened only
// for a Workspace DO's Container start (`environmentDO.ts`'s `environmentSettings()`). The settings value, the audit log,
// the Change page, an Open change's arguments and every read hold a secret's fingerprint, never its value.
import {
  fitStoredVariables,
  isRecord,
  isSealedValue,
  readVariable,
  type ResolvedEnvironment,
  resolveEnvironment,
  type SealedValue,
  type StoredEnvironment,
  type Variable,
  variableEntries,
  variableNameProblem,
  variableValueProblem,
} from "@t3flare/harness-registry";

import type { ValueSealer } from "../credentials/sealed.ts";

/** What a secret Variable's value is sealed under: its name, so a sealed value moved to another name does not open. */
const labelOf = (name: string): string => `t3flare/variables/${name}`;

/**
 * Whether a change's sealed values were sealed by the Settings server's door: only its replay of an Open change says
 * so (`changeEnvironment`, `sealVariablesIn`).
 */
export interface Sealing {
  readonly sealedAtDoor?: boolean;
}

/**
 * `settings` (an Environment change) with each secret Variable in its stored form: a value given is sealed, and
 * `valueRedacted: true` keeps the value stored under that name (as stock t3's redacted secrets round-trip). A change
 * from outside (the page, the Settings server's door) gives only those two (ADR-0046 §1): a `sealed` value from it is
 * refused on any entry, plain or secret, since a sealed value seen once could bring back an old value.
 * `sealing.sealedAtDoor` is the Open change's replay through the ops, whose arguments the door sealed: a secret already
 * sealed is kept there if it opens under its name.
 * Everything else is left for the change function to judge. Refused besides: a kept secret with nothing stored under
 * its name, a secret with no value, a value that is no Variable's, and any secret to seal without a credentials key.
 */
export const sealVariablesIn = async (
  settings: Readonly<Record<string, unknown>>,
  stored: StoredEnvironment,
  sealer: ValueSealer | undefined,
  sealing: Sealing = {},
): Promise<{ readonly ok: true; readonly settings: Readonly<Record<string, unknown>> } | { readonly ok: false; readonly error: string }> => {
  if (!Object.hasOwn(settings, "variables")) return { ok: true, settings };
  const entries = variableEntries(settings.variables);
  if (entries === undefined) return { ok: true, settings };
  const kept = new Map<string, SealedValue>();
  for (const variable of fitStoredVariables(stored.settings.variables)) if (variable.sealed !== undefined) kept.set(variable.name, variable.sealed);
  const out: Array<unknown> = [];
  const problems: Array<string> = [];
  for (const entry of entries) {
    if (isRecord(entry) && entry.sealed !== undefined && (sealing.sealedAtDoor !== true || entry.secret !== true)) {
      problems.push(`${JSON.stringify(entry.name)} gives a sealed value: give its value, or valueRedacted to keep the one stored`);
      continue;
    }
    if (!isRecord(entry) || entry.secret !== true || typeof entry.name !== "string") {
      out.push(entry);
      continue;
    }
    const { name } = entry;
    const quoted = JSON.stringify(name);
    if (entry.sealed !== undefined) {
      const opens = isSealedValue(entry.sealed) && sealer !== undefined && (await sealer.open(labelOf(name), entry.sealed)) !== undefined;
      if (opens) out.push({ name, value: "", secret: true, sealed: entry.sealed });
      else problems.push(`${quoted}'s sealed value does not open here: give its value`);
      continue;
    }
    if (entry.valueRedacted === true) {
      const sealed = kept.get(name);
      if (sealed === undefined) problems.push(`${quoted} keeps a secret value, and none is stored under that name: give its value`);
      else out.push({ name, value: "", secret: true, sealed });
      continue;
    }
    if (typeof entry.value !== "string") {
      out.push(entry);
      continue;
    }
    // An empty value with no redacted mark is a stored secret's box left blank (a page that lost its mark), not a value
    // to seal: sealing it would blank the secret without a word.
    const why = variableNameProblem(name) ?? variableValueProblem(name, entry.value) ?? (entry.value === "" ? `${quoted} is secret and has no value: give its value` : undefined);
    if (why !== undefined) {
      problems.push(why);
      continue;
    }
    // A Secret toggle needs somewhere to seal: without a credentials key no secret is stored (ADR-0016's sealed store).
    if (sealer === undefined || !sealer.available) return { ok: false, error: "variables: this Environment has no credentials key (T3FLARE_CREDENTIALS_KEY), so it stores no secret Variable" };
    out.push({ name, value: "", secret: true, sealed: await sealer.seal(labelOf(name), entry.value) });
  }
  if (problems.length > 0) return { ok: false, error: `variables: ${problems.join("; ")}` };
  return { ok: true, settings: { ...settings, variables: out } };
};

/**
 * The stored Variables as a Container start takes them, each secret's value opened. A secret this credentials key does
 * not open (set before the key changed) is left out and named in `unreadable`: it must be given again.
 */
export const openVariables = async (
  stored: StoredEnvironment,
  sealer: ValueSealer | undefined,
): Promise<{ readonly variables: ReadonlyArray<Variable>; readonly unreadable: ReadonlyArray<string> }> => {
  const variables: Array<Variable> = [];
  const unreadable: Array<string> = [];
  for (const variable of fitStoredVariables(stored.settings.variables)) {
    if (variable.sealed === undefined) {
      variables.push({ name: variable.name, value: variable.value, secret: variable.secret });
      continue;
    }
    const value = await sealer?.open(labelOf(variable.name), variable.sealed);
    if (value === undefined) unreadable.push(variable.name);
    else variables.push({ name: variable.name, value, secret: true });
  }
  return { variables, unreadable };
};

/**
 * The stored Variables as a read shows them (`fitVariables`), each secret this credentials key does not open marked
 * `unreadable` (ADR-0046): the Settings page and the Settings server say it must be typed again, since a Container
 * start leaves it out. Never a value.
 */
export const readVariables = async (stored: StoredEnvironment, sealer: ValueSealer | undefined): Promise<ReadonlyArray<Variable>> =>
  Promise.all(
    fitStoredVariables(stored.settings.variables).map(async (variable) => {
      const read = readVariable(variable);
      if (variable.sealed === undefined) return read;
      const opens = (await sealer?.open(labelOf(variable.name), variable.sealed)) !== undefined;
      return opens ? read : { ...read, unreadable: true as const };
    }),
  );

/** The Environment settings as a read shows them: resolved, with the Variables as `readVariables` reads them. */
export const resolvedForRead = async (stored: StoredEnvironment, sealer: ValueSealer | undefined): Promise<ResolvedEnvironment> => ({
  ...resolveEnvironment(stored),
  variables: await readVariables(stored, sealer),
});
