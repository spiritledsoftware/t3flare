// Variables (SPI-1152, ADR-0032's Variables refinement, ADR-0046): `NAME=value` pairs every command in a Workspace starts
// with, kept in the Environment settings. A Variable may be secret, as stock t3's provider environment variables are
// (`t3code/packages/contracts/src/providerInstance.ts`): its value is then sealed with the Stage's credentials key before
// it is stored (`apps/environment/src/harness/variableSeal.ts`), and no read returns it. Validation keeps t3flare
// working and nothing more (ADR-0046 §3): a name a shell can export, a value without a NUL, and the limits below, which
// are Linux's on a command's environment (SPI-1365).
//
// Three forms of one Variable:
//   - as a change carries it in (the page, the Settings server, a script): `{ name, value, secret }`, where a secret
//     may instead say `valueRedacted: true` to keep the value stored under its name; the old `{ NAME: "value" }` set is
//     taken too, every Variable plain. `variableSeal.ts` turns it into the stored form before the change is applied;
//   - as stored (`StoredVariable`): a plain one's value, or a secret's `sealed` value and an empty `value`;
//   - as read (`Variable`, `fitVariables`): a stored secret is `value: ""`, `valueRedacted: true` and its fingerprint (an
//     HMAC of the value, never the value), so a change to it shows without it. Only the Environment DO's answer to a
//     Workspace DO opens a secret, into `value` (`openVariables`).

/**
 * The most bytes one `NAME=value` may take, its NUL included: Linux's MAX_ARG_STRLEN (32 pages of 4 KiB). A Variable
 * reaches every command through execve's environment (`commandEnv`, apps/agents/src/workspace/variables.ts), and execve
 * refuses a string past this with E2BIG, so every command would fail. A named constraint.
 */
export const MAX_ENV_STRING_BYTES = 128 * 1024;

/** The longest value a Variable may have, in bytes of UTF-8: MAX_ENV_STRING_BYTES less the shortest name, `=` and NUL. */
export const MAX_VARIABLE_VALUE_BYTES = MAX_ENV_STRING_BYTES - "A=".length - 1;

/**
 * The most bytes all the Variables together may take of a command's environment, each `NAME=value`, its NUL and its
 * envp pointer counted (`variableBytes`). A named constraint, provisional: Linux's ARG_MAX, a quarter of the stack limit
 * (2 MiB at the default 8 MiB), bounds argv and envp together, and execve refuses past it with E2BIG. Half of it is the
 * Variables'; the other half is left to the command itself (an agent's `bash -c` script is its argv) and to
 * t3flare's own environment. The Container's stack limit is not documented, so the 8 MiB default is assumed.
 */
export const MAX_VARIABLES_BYTES = 1024 * 1024;

/** An envp pointer's bytes, on the Container's 64-bit Linux. */
const POINTER_BYTES = 8;

const utf8 = new TextEncoder();

/** The bytes `NAME=value` takes as one environment string, its NUL included. */
const envStringBytes = (name: string, valueBytes: number): number => utf8.encode(name).length + 1 + valueBytes + 1;

/**
 * The longest sealed value's text kept: a value of MAX_VARIABLE_VALUE_BYTES, plus GCM's 16-byte tag, as base64. Only a
 * malformed record is longer.
 */
const MAX_SEALED_LENGTH = 4 * Math.ceil((MAX_VARIABLE_VALUE_BYTES + 16) / 3);

/** At most the bytes a sealed value opens to: its base64 less GCM's tag. */
const sealedValueBytes = (sealed: SealedValue): number => Math.max(0, Math.floor((sealed.data.length * 3) / 4) - 16);

/**
 * The bytes a stored Variable takes of a command's environment: its `NAME=value`, NUL and envp pointer. A secret's
 * counts the most its sealed value opens to.
 */
export const variableBytes = (variable: StoredVariable): number =>
  envStringBytes(
    variable.name,
    variable.sealed === undefined ? utf8.encode(variable.value).length : sealedValueBytes(variable.sealed),
  ) + POINTER_BYTES;

/**
 * A secret's value as stored: AES-GCM under the Stage's credentials key, and an HMAC fingerprint of the value. Only the
 * Environment DO makes one (`variableSeal.ts`): a change from outside gives a value or `valueRedacted`, never this.
 */
export interface SealedValue {
  readonly iv: string;
  readonly data: string;
  readonly fingerprint: string;
}

/** A Variable as stored: a secret has `sealed` and an empty `value`, so the settings value never holds it in clear. */
export interface StoredVariable {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
  readonly sealed?: SealedValue;
}

/**
 * A Variable as read. A stored secret reads `value: ""` with `valueRedacted` and its fingerprint; only the Environment
 * DO's answer to a Workspace DO carries a secret's value.
 */
export interface Variable {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
  readonly valueRedacted?: true;
  readonly fingerprint?: string;
  /**
   * A stored secret this Environment's credentials key does not open (set before the key changed, or without one): a
   * Container start leaves it out, so its value must be typed again. Only a read that tried to open it says so.
   */
  readonly unreadable?: true;
}

/**
 * The names the Container's shell sets for every command itself. A Variable under one never reaches a command
 * (`variableEnv`): t3flare's value wins (ADR-0046 §3, ADR-0032's Variables §7), as for every name in SET_BY_T3FLARE.
 */
export const SET_BY_THE_CONTAINER: ReadonlyArray<string> = ["PATH", "HOME", "PWD", "SHELL", "USER"];

/**
 * The prefixes of the names t3flare and t3 keep for themselves inside a Workspace: t3flare's internal markers
 * (`T3FLARE_PASSIVE_READ`, which lets a read skip the Global mise lay-down; `T3FLARE_EXEC`, a command's exec id that
 * the stop ledger and the kill helper find it by; the model and tool handles) and t3's own (`T3CODE_THREAD_ID`, which
 * the port discovery reads). A Variable under one never reaches a command (`variableEnv`): it would make a command look
 * like something t3flare made, so t3flare's correctness forces this, and the Settings page says so beside it.
 */
export const RESERVED_PREFIXES: ReadonlyArray<string> = ["T3FLARE_", "T3CODE_"];

/** Whether `name` is under one of RESERVED_PREFIXES: t3flare's or t3's own. */
export const reservedPrefix = (name: string): boolean => RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));

/** Whether a Variable named `name` is left out of every command: the Container's shell's own, or a reserved prefix. */
export const withheldFromCommands = (name: string): boolean =>
  SET_BY_THE_CONTAINER.includes(name) || reservedPrefix(name);

/**
 * Every name t3flare sets or pins for a command, a Terminal or a CLI agent: the Container's shell's own
 * (SET_BY_THE_CONTAINER), `COMMAND_ENV`, a CLI profile's environment or Codex's shell policy, the managed settings'
 * `env`, a Terminal's base environment or the shell variables its rc file assigns, and the model handle. A Variable may
 * have one of these names; t3flare's value wins over it wherever t3flare sets it, and the Settings page says so beside
 * it (ADR-0046 §3). Derived from the code by `apps/environment/test/variableNames.test.ts`, which fails when one of those
 * sets a name this list misses, or this list keeps one nothing sets.
 */
export const SET_BY_T3FLARE: ReadonlyArray<string> = [
  "ALL_PROXY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_UNIX_SOCKET",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "BASH_ENV",
  "CLAUDE_AGENT_ACP_EXPERIMENTAL_V2",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL",
  "CLAUDE_CODE_EXECUTABLE",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISABLE_AUTOUPDATER",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_FEEDBACK_COMMAND",
  "DISABLE_TELEMETRY",
  "DISABLE_UPDATES",
  "DISPLAY",
  "GIT_TERMINAL_PROMPT",
  "HISTFILE",
  "HISTFILESIZE",
  "HISTSIZE",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "MISE_CACHE_DIR",
  "MISE_CONFIG_DIR",
  "MISE_DATA_DIR",
  "MISE_DISABLE_BACKENDS",
  "MISE_DISABLE_TOOLS",
  "MISE_GITHUB_CREDENTIAL_COMMAND",
  "MISE_GITHUB_GH_CLI_TOKENS",
  "MISE_GITHUB_USE_GIT_CREDENTIALS",
  "MISE_GLOBAL_CONFIG_FILE",
  "MISE_STATE_DIR",
  "MISE_SYSTEM_CONFIG_FILE",
  "MISE_TRUSTED_CONFIG_PATHS",
  "MISE_YES",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NO_PROXY",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_FREE_MODELS",
  "OPENCODE_DISABLE_LSP_DOWNLOAD",
  "OPENCODE_DISABLE_MODELS_FETCH",
  "PATH",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_OFFLINE",
  "PI_SKIP_VERSION_CHECK",
  "PI_TELEMETRY",
  "PROMPT_COMMAND",
  "PS0",
  "PS1",
  "PWD",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "T3FLARE_EXEC",
  "T3FLARE_MODEL_HANDLE",
  "T3FLARE_RELAY_SERVERS",
  "T3FLARE_TOOL_HANDLE",
  "T3_MCP_BEARER_TOKEN",
  "T3_MCP_URL",
  "T3_PI_MCP_EXTENSION_PATH",
  "T3_PI_RUNTIME_MODE",
  "TERM",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "http_proxy",
  "https_proxy",
];

/**
 * Whether t3flare sets or keeps `name` itself, so its own value wins over a Variable's, or the Variable reaches no
 * command (the Settings page's note): SET_BY_T3FLARE, and every name under RESERVED_PREFIXES.
 */
export const setByT3flare = (name: string): boolean => SET_BY_T3FLARE.includes(name) || reservedPrefix(name);

/** Whether `value` is a plain object: a Variable's entry, a set of them in the old shape, a sealed value. */
export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Why `name` cannot be a Variable's, or undefined when it can. */
export const variableNameProblem = (name: string): string | undefined => {
  const quoted = JSON.stringify(name);
  if (name === "") return "a Variable's name may not be empty";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    return `${quoted} is not a name a shell can export: letters, digits and _, not starting with a digit`;
  return undefined;
};

/** Why `value` cannot be Variable `name`'s, or undefined when it can. */
export const variableValueProblem = (name: string, value: string): string | undefined => {
  const quoted = JSON.stringify(name);
  if (value.includes("\u0000")) return `${quoted}'s value holds a NUL character, which no environment can`;
  // A UTF-16 unit is at most 3 bytes of UTF-8: only a long name and value need encoding.
  if (name.length + value.length * 3 + 2 <= MAX_ENV_STRING_BYTES) return undefined;
  const bytes = envStringBytes(name, utf8.encode(value).length);
  return bytes > MAX_ENV_STRING_BYTES
    ? `${quoted}=value is ${bytes} bytes, past the ${MAX_ENV_STRING_BYTES} Linux takes for one variable`
    : undefined;
};

/** AES-GCM's 12-byte IV as base64 (16 characters), with room: `valueSealer` (sealed.ts) makes it. */
const MAX_IV_LENGTH = 32;
/** The fingerprint `valueSealer` makes: 8 hex digits of an HMAC-SHA-256 (64 at most, the whole digest in hex). */
const MAX_FINGERPRINT_LENGTH = 64;

/** Whether `value` is a sealed value's shape (whether it opens is the Environment DO's to say). */
export const isSealedValue = (value: unknown): value is SealedValue =>
  isRecord(value) &&
  typeof value.iv === "string" &&
  value.iv.length <= MAX_IV_LENGTH &&
  typeof value.data === "string" &&
  value.data.length <= MAX_SEALED_LENGTH &&
  typeof value.fingerprint === "string" &&
  value.fingerprint.length <= MAX_FINGERPRINT_LENGTH;

/**
 * A set of Variables as a list of entries: a list as given, the old `{ NAME: "value" }` set as plain Variables in its
 * order. Anything else is undefined.
 */
export const variableEntries = (value: unknown): ReadonlyArray<unknown> | undefined => {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.entries(value).map(([name, text]) => ({ name, value: text, secret: false }));
  return undefined;
};

/** The stored form of a set of Variables: the old `{ NAME: "value" }` set becomes a list, anything else is unchanged. */
export const normalizeVariables = (value: unknown): unknown => (isRecord(value) ? variableEntries(value) : value);

/** Why `entry` cannot be stored as a Variable, or undefined. */
const storedEntryProblem = (entry: unknown): string | undefined => {
  if (!isRecord(entry) || typeof entry.name !== "string")
    return 'a Variable is { "name": "NAME", "value": "value", "secret": false }';
  const { name } = entry;
  const quoted = JSON.stringify(name);
  const nameProblem = variableNameProblem(name);
  if (nameProblem !== undefined) return nameProblem;
  if (entry.secret !== undefined && typeof entry.secret !== "boolean") return `${quoted}'s secret is true or false`;
  if (entry.secret === true) {
    // The sealing step (`variableSeal.ts`) turns a secret's value, or `valueRedacted`, into `sealed` before this runs:
    // a secret without it here would be stored in clear, so it is refused.
    if (entry.sealed === undefined)
      return entry.valueRedacted === true
        ? `${quoted} keeps a secret value, and none is stored under that name: give its value`
        : `${quoted}'s secret value is not sealed`;
    if (!isSealedValue(entry.sealed)) return `${quoted}'s sealed value is malformed`;
    if (entry.value !== undefined && entry.value !== "") return `${quoted} is secret: its value is stored sealed only`;
    return undefined;
  }
  if (entry.sealed !== undefined) return `${quoted} is not secret: a sealed value is a secret's only`;
  if (entry.valueRedacted === true) return `${quoted} is not secret: give its value`;
  if (typeof entry.value !== "string") return `${quoted}'s value is not text`;
  return variableValueProblem(name, entry.value);
};

/**
 * Why `value` is not a set of Variables as stored (a list of `{ name, value, secret }`, a secret's value sealed; or the
 * old `{ NAME: "value" }` set), every problem named; undefined when it is one.
 */
export const variablesProblem = (value: unknown): string | undefined => {
  const entries = variableEntries(value);
  if (entries === undefined) return 'a list of Variables, [{ "name": "NAME", "value": "value", "secret": false }]';
  const seen = new Set<string>();
  let bytes = 0;
  const problems = entries.flatMap((entry) => {
    const why = storedEntryProblem(entry);
    if (why !== undefined) return [why];
    const { name } = entry as StoredVariable;
    if (seen.has(name)) return [`${JSON.stringify(name)} is listed twice`];
    seen.add(name);
    bytes += variableBytes(entry as StoredVariable);
    return [];
  });
  if (problems.length === 0 && bytes > MAX_VARIABLES_BYTES)
    return `the Variables take ${bytes} bytes of a command's environment, past the ${MAX_VARIABLES_BYTES} they may`;
  return problems.length === 0 ? undefined : problems.join("; ");
};

/**
 * The Variables of a set that still fit, in order, within MAX_VARIABLES_BYTES, each name once (the first kept), in
 * their stored form: one that no longer fits is dropped alone, not the whole set. A secret fits with its sealed value, or, in
 * the Environment DO's answer to a Workspace DO, with its value opened. Anything that is not a set reads as none.
 */
export const fitStoredVariables = (value: unknown): ReadonlyArray<StoredVariable> => {
  const kept: Array<StoredVariable> = [];
  const seen = new Set<string>();
  let bytes = 0;
  const keep = (variable: StoredVariable): boolean => {
    const more = variableBytes(variable);
    if (bytes + more > MAX_VARIABLES_BYTES) return false;
    bytes += more;
    kept.push(variable);
    return true;
  };
  for (const entry of variableEntries(value) ?? []) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      variableNameProblem(entry.name) !== undefined ||
      seen.has(entry.name)
    )
      continue;
    const { name } = entry;
    const fits =
      entry.secret === true && isSealedValue(entry.sealed)
        ? keep({
            name,
            value: "",
            secret: true,
            sealed: { iv: entry.sealed.iv, data: entry.sealed.data, fingerprint: entry.sealed.fingerprint },
          })
        : entry.sealed === undefined &&
          entry.valueRedacted !== true &&
          typeof entry.value === "string" &&
          variableValueProblem(name, entry.value) === undefined &&
          keep({ name, value: entry.value, secret: entry.secret === true });
    if (!fits) continue;
    seen.add(name);
  }
  return kept;
};

/** A stored Variable as read: a sealed secret redacted to its fingerprint. */
export const readVariable = (stored: StoredVariable): Variable =>
  stored.sealed === undefined
    ? { name: stored.name, value: stored.value, secret: stored.secret }
    : { name: stored.name, value: "", secret: true, valueRedacted: true, fingerprint: stored.sealed.fingerprint };

/** The Variables of a set as read (`fitStoredVariables`, then `readVariable`): no stored secret's value is in it. */
export const fitVariables = (value: unknown): ReadonlyArray<Variable> => fitStoredVariables(value).map(readVariable);

/**
 * What a command gets from the Variables, `{ NAME: "value" }`: every Variable with its value, a secret's opened in the
 * Environment DO's answer. Left out: a redacted secret (no value to give), a name the Container's shell sets for every
 * command (SET_BY_THE_CONTAINER, whose value wins), and a name under RESERVED_PREFIXES (t3flare's and t3's own markers).
 */
export const variableEnv = (variables: ReadonlyArray<Variable>): Readonly<Record<string, string>> =>
  Object.fromEntries(
    variables
      .filter((variable) => variable.valueRedacted !== true && !withheldFromCommands(variable.name))
      .map((variable) => [variable.name, variable.value]),
  );

/**
 * A kept `{ NAME: "value" }` (a Container launch's Variables) that still fits: names a shell can export, text values
 * without a NUL, none withheld from commands (`withheldFromCommands`), within MAX_VARIABLES_BYTES. Anything else reads
 * as none.
 */
export const fitVariableEnv = (value: unknown): Readonly<Record<string, string>> => {
  if (!isRecord(value)) return {};
  let bytes = 0;
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => {
      const [name, text] = entry;
      if (
        typeof text !== "string" ||
        variableNameProblem(name) !== undefined ||
        variableValueProblem(name, text) !== undefined ||
        withheldFromCommands(name)
      )
        return false;
      const more = variableBytes({ name, value: text, secret: false });
      if (bytes + more > MAX_VARIABLES_BYTES) return false;
      bytes += more;
      return true;
    }),
  );
};
