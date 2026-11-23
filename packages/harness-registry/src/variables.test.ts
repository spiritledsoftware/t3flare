// The Variables setting's seam (SPI-1152, ADR-0032, ADR-0046): what the panel may store (`applyEnvironmentChange`) and
// what every reader gets (`resolveEnvironment`): the shape (a name, a value, a Secret toggle), the old `{ NAME: "value" }`
// shape read as plain Variables, the limits, the refusals that keep t3flare working and no others, a secret's value
// stored sealed only and read as its fingerprint, and what a command gets (`variableEnv`). Sealing itself is the
// Environment DO's (apps/environment/test/variableSeal.test.ts); the names t3flare sets are derived from the code in
// apps/environment/test/variableNames.test.ts.
import { describe, expect, it } from "vitest";

import { applyEnvironmentChange, EMPTY_ENVIRONMENT, readStoredEnvironment, resolveEnvironment } from "./environment.ts";
import {
  fitVariableEnv,
  MAX_ENV_STRING_BYTES,
  MAX_VARIABLE_VALUE_BYTES,
  MAX_VARIABLES_BYTES,
  RESERVED_PREFIXES,
  SET_BY_T3FLARE,
  setByT3flare,
  variableEnv,
  withheldFromCommands,
} from "./variables.ts";

const apply = (variables: unknown) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { variables } });
const refusal = (variables: unknown) => {
  const applied = apply(variables);
  return applied.ok ? undefined : applied.error;
};
const plain = (name: string, value: string) => ({ name, value, secret: false });
const SEALED = { iv: "aXZpdml2aXZpdml2", data: "c2VhbGVk", fingerprint: "0a1b2c3d" };
const sealedSecret = (name: string, sealed = SEALED) => ({ name, value: "", secret: true, sealed });

describe("Variables", () => {
  it("are none by default, and a change stores them as a list, bumps the revision and resolves them", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT).variables).toEqual([]);
    const applied = apply([plain("DATABASE_URL", "postgres://localhost/dev"), plain("NODE_ENV", "development")]);
    if (!applied.ok) throw new Error(applied.error);
    expect(applied.changed).toEqual(["variables"]);
    expect(applied.environment.revision).toBe(1);
    expect(resolveEnvironment(applied.environment).variables).toEqual([
      plain("DATABASE_URL", "postgres://localhost/dev"),
      plain("NODE_ENV", "development"),
    ]);
  });

  it("reads the old stored { NAME: value } shape as plain Variables, and takes it in a change too", () => {
    const old = { revision: 3, settings: { variables: { NODE_ENV: "test", LOG_LEVEL: "debug" } } };
    expect(resolveEnvironment(old).variables).toEqual([plain("NODE_ENV", "test"), plain("LOG_LEVEL", "debug")]);
    // The same Variables in the new shape are no change; a change stores the new shape.
    expect(
      applyEnvironmentChange(old, {
        settings: { variables: [plain("NODE_ENV", "test"), plain("LOG_LEVEL", "debug")] },
      }),
    ).toMatchObject({ ok: true, changed: [] });
    const moved = applyEnvironmentChange(old, { settings: { variables: { NODE_ENV: "production" } } });
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.environment.settings.variables).toEqual([plain("NODE_ENV", "production")]);
  });

  it("a save with the same Variables moves nothing; a changed value, a Secret toggle or a removed Variable moves them", () => {
    const first = apply([plain("A", "1"), plain("B", "2")]);
    if (!first.ok) throw new Error(first.error);
    expect(
      applyEnvironmentChange(first.environment, {
        settings: { variables: [plain("A", "1"), plain("B", "2")], containerBudget: 3 },
      }),
    ).toMatchObject({ ok: true, changed: [] });
    expect(
      applyEnvironmentChange(first.environment, { settings: { variables: [plain("A", "1"), plain("B", "3")] } }),
    ).toMatchObject({ ok: true, changed: ["variables"] });
    expect(
      applyEnvironmentChange(first.environment, { settings: { variables: [plain("A", "1"), sealedSecret("B")] } }),
    ).toMatchObject({ ok: true, changed: ["variables"] });
    const removed = applyEnvironmentChange(first.environment, { settings: { variables: [plain("A", "1")] } });
    if (!removed.ok) throw new Error(removed.error);
    expect(resolveEnvironment(removed.environment).variables).toEqual([plain("A", "1")]);
  });

  it("bounds each NAME=value by Linux's MAX_ARG_STRLEN and all of them by their share of ARG_MAX, not by a count", () => {
    // No count: past the old 50 Variables, and names past the old 128 characters, are taken.
    const many = Array.from({ length: 500 }, (_, at) => plain(`V${at}`, "x"));
    expect(apply(many)).toMatchObject({ ok: true });
    expect(apply([plain(`N${"A".repeat(1000)}`, "x")])).toMatchObject({ ok: true });
    // A value up to the per-string bound, counted in bytes of UTF-8 with its name, "=" and the NUL: a kubeconfig fits.
    expect(MAX_ENV_STRING_BYTES).toBe(128 * 1024);
    const fits = MAX_ENV_STRING_BYTES - "BIG=".length - 1;
    expect(apply([plain("BIG", "y".repeat(fits))])).toMatchObject({ ok: true });
    expect(refusal([plain("BIG", "y".repeat(fits + 1))])).toBe(
      `variables: "BIG"=value is ${MAX_ENV_STRING_BYTES + 1} bytes, past the ${MAX_ENV_STRING_BYTES} Linux takes for one variable`,
    );
    expect(refusal([plain("BIG", "é".repeat(fits / 2 + 1))])).toMatch(/past the 131072 Linux takes for one variable/);
    expect(MAX_VARIABLE_VALUE_BYTES).toBe(MAX_ENV_STRING_BYTES - "A=".length - 1);
    // All of them together: their share of ARG_MAX, refused whole on a change.
    expect(MAX_VARIABLES_BYTES).toBe(1024 * 1024);
    const big = (at: number) => plain(`B${at}`, "z".repeat(100 * 1024));
    const ten = Array.from({ length: 10 }, (_, at) => big(at));
    expect(apply(ten)).toMatchObject({ ok: true });
    expect(refusal([...ten, big(10)])).toMatch(
      /^variables: the Variables take \d+ bytes of a command's environment, past the 1048576 they may$/,
    );
  });

  it("reads a stored set past the total as the Variables that fit, in order, dropping only the rest", () => {
    const stored = Array.from({ length: 11 }, (_, at) => plain(`B${at}`, "z".repeat(100 * 1024)));
    const read = resolveEnvironment({ revision: 1, settings: { variables: stored } }).variables;
    expect(read.map((variable) => variable.name)).toEqual(stored.slice(0, 10).map((variable) => variable.name));
  });

  it("takes only names a shell can export, each once, and text values without a NUL", () => {
    for (const name of ["", "1ABC", "MY-VAR", "MY VAR", "É"])
      expect(refusal([plain(name, "x")])).toMatch(/^variables: /);
    expect(refusal([plain("1ABC", "x")])).toBe(
      'variables: "1ABC" is not a name a shell can export: letters, digits and _, not starting with a digit',
    );
    expect(refusal([plain("OK", "a\u0000b")])).toBe(
      'variables: "OK"\'s value holds a NUL character, which no environment can',
    );
    expect(refusal([{ name: "OK", value: 3 }])).toBe('variables: "OK"\'s value is not text');
    expect(refusal([plain("A", "1"), plain("A", "2")])).toBe('variables: "A" is listed twice');
    expect(refusal("A=1")).toBe(
      'variables: a list of Variables, [{ "name": "NAME", "value": "value", "secret": false }]',
    );
    expect(apply([plain("_private", "x"), plain("lower_case", "multi\nline")])).toMatchObject({ ok: true });
  });

  it("refuses nothing else: the old refused names, prefixes, loader hooks, credential segments and credential values all store (ADR-0046 §3)", () => {
    const names = [
      "PATH",
      "HOME",
      "T3CODE_THREAD_ID",
      "MISE_ENV",
      "GIT_DIR",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "SSH_AUTH_SOCK",
      "LD_PRELOAD",
      "NODE_OPTIONS",
      "BASH_ENV",
      "ENV",
      "PROMPT_COMMAND",
      "NPM_TOKEN",
      "STRIPE_API_KEY",
      "DB_PASSWORD",
      "ANTHROPIC_BASE_URL",
      "HTTPS_PROXY",
    ];
    expect(apply(names.map((name) => plain(name, "x")))).toMatchObject({ ok: true });
    const values = [
      `sk-${"a".repeat(24)}`,
      `ghp_${"b".repeat(36)}`,
      `npm_${"f".repeat(36)}`,
      "AKIAABCDEFGHIJKLMNOP",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    ];
    expect(apply(values.map((value, at) => plain(`V${at}`, value)))).toMatchObject({ ok: true });
  });

  it("names every refused Variable in one answer", () => {
    expect(refusal([plain("1A", "x"), plain("OK", "y"), plain("B", "a\u0000")])).toBe(
      'variables: "1A" is not a name a shell can export: letters, digits and _, not starting with a digit; "B"\'s value holds a NUL character, which no environment can',
    );
  });

  it("reads a stored Variable that no longer fits as gone, keeping the others", () => {
    const stored = {
      revision: 7,
      settings: {
        variables: [
          plain("NODE_ENV", "test"),
          plain("BAD-NAME", "x"),
          { name: "N", value: 3 },
          plain("NODE_ENV", "again"),
        ],
      },
    };
    expect(resolveEnvironment(stored).variables).toEqual([plain("NODE_ENV", "test")]);
    expect(resolveEnvironment({ revision: 7, settings: { variables: "A=1" } }).variables).toEqual([]);
  });
});

describe("secret Variables (ADR-0046)", () => {
  it("are stored sealed only: a secret's value in clear, or one not sealed, is refused", () => {
    expect(apply([sealedSecret("NPM_TOKEN")])).toMatchObject({ ok: true });
    expect(refusal([{ name: "NPM_TOKEN", value: "npm_x", secret: true }])).toBe(
      'variables: "NPM_TOKEN"\'s secret value is not sealed',
    );
    expect(refusal([{ name: "NPM_TOKEN", value: "npm_x", secret: true, sealed: SEALED }])).toBe(
      'variables: "NPM_TOKEN" is secret: its value is stored sealed only',
    );
    expect(refusal([{ name: "NPM_TOKEN", value: "", secret: true, valueRedacted: true }])).toBe(
      'variables: "NPM_TOKEN" keeps a secret value, and none is stored under that name: give its value',
    );
    expect(refusal([{ name: "NPM_TOKEN", value: "", secret: true, sealed: { iv: 1 } }])).toBe(
      'variables: "NPM_TOKEN"\'s sealed value is malformed',
    );
    expect(refusal([{ name: "A", value: "", secret: false, valueRedacted: true }])).toBe(
      'variables: "A" is not secret: give its value',
    );
    expect(refusal([{ name: "A", value: "1", secret: false, sealed: SEALED }])).toBe(
      'variables: "A" is not secret: a sealed value is a secret\'s only',
    );
    expect(refusal([{ name: "A", value: "1", secret: "yes" }])).toBe('variables: "A"\'s secret is true or false');
  });

  it("read as set, never with a value: the resolve, and the stored settings as a read shows them, carry the fingerprint", () => {
    const applied = apply([plain("A", "1"), sealedSecret("NPM_TOKEN")]);
    if (!applied.ok) throw new Error(applied.error);
    const shown = { name: "NPM_TOKEN", value: "", secret: true, valueRedacted: true, fingerprint: "0a1b2c3d" };
    expect(resolveEnvironment(applied.environment).variables).toEqual([plain("A", "1"), shown]);
    expect(readStoredEnvironment(applied.environment).settings.variables).toEqual([plain("A", "1"), shown]);
    expect(JSON.stringify(readStoredEnvironment(applied.environment))).not.toContain(SEALED.data);
  });

  it("moves on a new fingerprint only: the same value sealed again is no change", () => {
    const first = apply([sealedSecret("T")]);
    if (!first.ok) throw new Error(first.error);
    expect(
      applyEnvironmentChange(first.environment, {
        settings: { variables: [sealedSecret("T", { ...SEALED, iv: "b3RoZXJpdm90aGVy", data: "b3RoZXI=" })] },
      }),
    ).toMatchObject({ ok: true, changed: [] });
    expect(
      applyEnvironmentChange(first.environment, {
        settings: { variables: [sealedSecret("T", { ...SEALED, fingerprint: "ffffffff" })] },
      }),
    ).toMatchObject({ ok: true, changed: ["variables"] });
  });

  it("keep their value in the Environment DO's answer to a Workspace DO, and reach a command", () => {
    const answer = {
      revision: 2,
      settings: { variables: [plain("A", "1"), { name: "NPM_TOKEN", value: "npm_live", secret: true }] },
    };
    const variables = resolveEnvironment(answer).variables;
    expect(variables).toEqual([plain("A", "1"), { name: "NPM_TOKEN", value: "npm_live", secret: true }]);
    expect(variableEnv(variables)).toEqual({ A: "1", NPM_TOKEN: "npm_live" });
  });
});

describe("what a command gets (variableEnv)", () => {
  it("leaves out a redacted secret, which has no value to give, and the names the Container's shell sets", () => {
    const variables = resolveEnvironment({
      revision: 1,
      settings: {
        variables: [plain("A", "1"), sealedSecret("S"), plain("PATH", "/nope"), plain("HOME", "/elsewhere")],
      },
    }).variables;
    expect(variableEnv(variables)).toEqual({ A: "1" });
  });

  it("leaves out every name under t3flare's and t3's reserved prefixes: their internal markers win (ADR-0046 §3)", () => {
    const variables = ["T3FLARE_PASSIVE_READ", "T3FLARE_EXEC", "T3CODE_THREAD_ID", "T3_OK", "NODE_ENV"].map((name) =>
      plain(name, "1"),
    );
    // Stored as the Owner gave them; only what a command gets leaves them out.
    expect(apply(variables)).toMatchObject({ ok: true });
    expect(variableEnv(variables)).toEqual({ T3_OK: "1", NODE_ENV: "1" });
    expect(RESERVED_PREFIXES).toEqual(["T3FLARE_", "T3CODE_"]);
    for (const name of ["T3FLARE_PASSIVE_READ", "T3CODE_THREAD_ID", "PATH"])
      expect(withheldFromCommands(name)).toBe(true);
    expect(withheldFromCommands("T3_OK")).toBe(false);
  });

  it("reads a kept launch's { NAME: value } against the same rules", () => {
    expect(fitVariableEnv({ A: "1", PATH: "/nope", "BAD-NAME": "x", N: 3 })).toEqual({ A: "1" });
    expect(fitVariableEnv({ T3FLARE_PASSIVE_READ: "1", B: "2" })).toEqual({ B: "2" });
    expect(fitVariableEnv(["A=1"])).toEqual({});
  });
});

describe("the names t3flare sets (the Settings page's note)", () => {
  it("are listed once each, and looked up by setByT3flare", () => {
    expect(new Set(SET_BY_T3FLARE).size).toBe(SET_BY_T3FLARE.length);
    for (const name of ["PATH", "HOME", "ANTHROPIC_BASE_URL", "MISE_YES", "BASH_ENV", "T3FLARE_MODEL_HANDLE"])
      expect(setByT3flare(name)).toBe(true);
    expect(setByT3flare("NODE_ENV")).toBe(false);
    // Every name under a reserved prefix is noted, listed or not.
    expect(setByT3flare("T3FLARE_PASSIVE_READ")).toBe(true);
    expect(setByT3flare("T3CODE_ANYTHING")).toBe(true);
  });
});
