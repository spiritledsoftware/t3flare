// @effect-diagnostics globalTimers:off
// The Builder's lean path (SPI-1332, ADR-0047 §1): the platform's raw `ctx.container` beside computer, which the Builder
// never uses (no computer Workspace, no `computer.internal` routes, no store in its Container). Leans on the Containers
// API's snapshots, a public beta (docs/upstream-fragility.md).
import type { ContainerInstance } from "@t3flare/harness-registry";

import type { BuilderContainer } from "./baseBuild.ts";
import { WORKSPACE_CONTAINER } from "./constants.ts";

const utf8 = new TextEncoder();

/** The Workspace image's digest-pinned reference (`ctx.container.images`), or undefined where there is none (local tests). */
export const workspaceImage = (container: Container | undefined): string | undefined => container?.images?.[WORKSPACE_CONTAINER];

/** `ctx.container` as a build drives it. */
export const platformContainer = (ctx: DurableObjectState): BuilderContainer => {
  const container = (): Container => {
    if (ctx.container === undefined) throw new Error("t3flare: this Durable Object has no Container");
    return ctx.container;
  };
  return {
    running: () => ctx.container?.running === true,
    start: ({ from, entrypoint, instance }) => {
      const base = {
        enableInternet: true,
        // Never omitted: an omitted `instance` starts `lite`, whose disk is too small for the image.
        instance: instance as Exclude<ContainerInstance, "lite">,
        ...(entrypoint === undefined ? {} : { entrypoint: [...entrypoint] }),
      };
      if ("image" in from) container().start({ ...base, image: from.image });
      else container().start({ ...base, containerSnapshot: { id: from.snapshot } });
    },
    exec: async (argv, { stdin, env, timeoutMs }) => {
      const process = await container().exec([...argv], {
        stdout: "pipe",
        stderr: "pipe",
        ...(stdin === undefined ? {} : { stdin: "pipe" as const }),
        ...(env === undefined ? {} : { env: { ...env } }),
      });
      if (stdin !== undefined) {
        const writer = process.stdin?.getWriter();
        await writer?.write(utf8.encode(stdin));
        await writer?.close();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const [output, exitCode] = await Promise.race([
          Promise.all([process.output(), process.exitCode.catch(() => null)]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`the exec ran past ${timeoutMs} ms`)), timeoutMs);
          }),
        ]);
        return { exitCode, stdout: new TextDecoder().decode(output.stdout) };
      } catch (error) {
        process.kill(9);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    snapshot: (name) => container().snapshotContainer({ name }),
    monitor: () => container().monitor(),
    destroy: () => container().destroy(),
  };
};
