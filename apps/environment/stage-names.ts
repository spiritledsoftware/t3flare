// The names a stage's resources take (alchemy.run.ts), and the Stage names scripts/stage.ts accepts, kept together so
// the bound on a Stage name follows the derived names and cannot drift from them (SPI-1338).

/** The Workers and the stand-in tunnel of `stage`. */
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
 * Fixed by Cloudflare, the longest each derived name may be. Each is one DNS label (a workers.dev host, the stand-in's
 * host), at most 63 characters and not ending in a dash. The Environment Worker keeps workers.dev's version preview URLs
 * on every Stage but prod (only prod has a domain, alchemy.run.ts), and Cloudflare refuses a script name over 54
 * characters with previews enabled ("Script names with previews enabled cannot be longer than 54 characters", found by
 * a 43-character Stage's deploy); the other Workers have previews off.
 */
const DNS_LABEL_MAX = 63;
const PREVIEWS_SCRIPT_NAME_MAX = 54;
const NAME_MAX: Record<keyof ReturnType<typeof stageNames>, number> = {
  environment: PREVIEWS_SCRIPT_NAME_MAX,
  agents: DNS_LABEL_MAX,
  codemode: DNS_LABEL_MAX,
  mcp: DNS_LABEL_MAX,
  mcpFixture: DNS_LABEL_MAX,
  probe: DNS_LABEL_MAX,
  standin: DNS_LABEL_MAX,
};

/** The longest Stage name whose every derived name fits its limit (34: `t3flare-environment-` under the previews limit). */
export const MAX_STAGE_NAME_LENGTH = Math.min(
  ...Object.entries(stageNames("")).map(([key, fixed]) => NAME_MAX[key as keyof typeof NAME_MAX] - fixed.length),
);

const STAGE_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Why `stage` cannot name a Stage, or undefined when it can. `prod` and `bump` are names like any other here. */
export const stageNameProblem = (stage: string): string | undefined => {
  if (!STAGE_NAME.test(stage)) return `the Stage name "${stage}" must be lowercase letters, digits and dashes, starting and ending with a letter or digit`;
  if (stage.length > MAX_STAGE_NAME_LENGTH) return `the Stage name "${stage}" is ${stage.length} characters; at most ${MAX_STAGE_NAME_LENGTH} fit Cloudflare's limits on its Worker names`;
  return undefined;
};
