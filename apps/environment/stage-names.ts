// The names a stage's resources take (alchemy.run.ts), and the Stage names scripts/stage.ts accepts, kept together so
// the bound on a Stage name follows the derived names and cannot drift from them (SPI-1338).

/** The Workers, the stand-in tunnel and the auth rate-limit rule of `stage`. */
export const stageNames = (stage: string) => ({
  environment: `t3flare-environment-${stage}`,
  agents: `t3flare-agents-${stage}`,
  codemode: `t3flare-codemode-${stage}`,
  mcp: `t3flare-mcp-${stage}`,
  mcpFixture: `t3flare-mcpfixture-${stage}`,
  probe: `t3flare-probe-${stage}`,
  standin: `t3flare-${stage}-standin`,
  authRule: `t3flare-auth-${stage}`,
});

/**
 * Fixed by Cloudflare, the longest each limited name may be. A Worker's script name is at most 63 characters (a
 * workers.dev host is `<script>.<subdomain>.workers.dev`, one DNS label, for the Workers served there: the Environment,
 * the MCP fixture and the probe), as is the stand-in's hostname label. A Worker with version previews on is held to 54
 * ("Script names with previews enabled cannot be longer than 54 characters", found by a 43-character Stage's deploy):
 * the Environment Worker has them on wherever it is served at workers.dev, every Stage without a domain. The bound is
 * one rule for every Stage name, prod's too, so a name never fits only while it has a domain. The auth rate-limit
 * rule's ref has no limit a Stage name could reach.
 */
const DNS_LABEL_MAX = 63;
const PREVIEWS_SCRIPT_NAME_MAX = 54;
const NAME_MAX: Record<Exclude<keyof ReturnType<typeof stageNames>, "authRule">, number> = {
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
  ...Object.entries(NAME_MAX).map(([key, max]) => max - stageNames("")[key as keyof typeof NAME_MAX].length),
);

const STAGE_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Why `stage` cannot name a Stage, or undefined when it can. `prod` and `bump` are names like any other here. */
export const stageNameProblem = (stage: string): string | undefined => {
  if (!STAGE_NAME.test(stage))
    return `the Stage name "${stage}" must be lowercase letters, digits and dashes, starting and ending with a letter or digit`;
  if (stage.length > MAX_STAGE_NAME_LENGTH)
    return `the Stage name "${stage}" is ${stage.length} characters; at most ${MAX_STAGE_NAME_LENGTH} fit Cloudflare's limits on its Worker names`;
  return undefined;
};
