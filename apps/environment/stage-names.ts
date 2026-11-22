// The names a stage's resources take (alchemy.run.ts), and the Stage names scripts/stage.ts accepts, kept together so
// the bound on a Stage name follows the longest derived name and cannot drift from it (SPI-1338).

/** The Workers and the stand-in tunnel of `stage`; each is a DNS label (a workers.dev host, the stand-in's host). */
export const stageNames = (stage: string) => ({
  environment: `t3flare-environment-${stage}`,
  agents: `t3flare-agents-${stage}`,
  codemode: `t3flare-codemode-${stage}`,
  mcp: `t3flare-mcp-${stage}`,
  mcpFixture: `t3flare-mcpfixture-${stage}`,
  probe: `t3flare-probe-${stage}`,
  standin: `t3flare-${stage}-standin`,
});

/**
 * Fixed by Cloudflare: a Worker served on workers.dev has a name of at most 63 characters (one DNS label) that does not
 * end in a dash, and every Stage but prod is served there (only prod may have a domain). So a Stage name is at most 63
 * less the longest fixed part of a derived name (`t3flare-environment-`, 43 characters left).
 */
const DNS_LABEL_MAX = 63;
export const MAX_STAGE_NAME_LENGTH = DNS_LABEL_MAX - Math.max(...Object.values(stageNames("")).map((name) => name.length));

const STAGE_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Why `stage` cannot name a Stage, or undefined when it can. `prod` and `bump` are names like any other here. */
export const stageNameProblem = (stage: string): string | undefined => {
  if (!STAGE_NAME.test(stage)) return `the Stage name "${stage}" must be lowercase letters, digits and dashes, starting and ending with a letter or digit`;
  if (stage.length > MAX_STAGE_NAME_LENGTH) return `the Stage name "${stage}" is ${stage.length} characters; at most ${MAX_STAGE_NAME_LENGTH} fit a workers.dev host`;
  return undefined;
};
