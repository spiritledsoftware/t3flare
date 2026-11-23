// @effect-diagnostics nodeBuiltinImport:off
// The file `stage.ts run <stage> <script>` runs (SPI-1338): a bare name is one of scripts/, as `health` is
// scripts/health.ts; an argument with a path separator or a `.ts` suffix is a path from the cwd, so an ad-hoc probe
// runs against a stage without becoming a committed script.
import * as path from "node:path";

export const stageScript = (script: string, where: { readonly scriptsDir: string; readonly cwd: string }): string =>
  script.includes("/") || script.includes(path.sep) || script.endsWith(".ts")
    ? path.resolve(where.cwd, script)
    : path.join(where.scriptsDir, `${script}.ts`);
