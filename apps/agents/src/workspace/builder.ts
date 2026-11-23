// @effect-diagnostics globalTimers:off
// The Builder's lean path (SPI-1332, ADR-0047 §1): the platform's raw `ctx.container` beside computer, which the Builder
// never uses (no computer Workspace, no `computer.internal` routes, no store in its Container). Leans on the Containers
// API's snapshots, a public beta (docs/upstream-fragility.md).
import { BUILDERS, type ContainerInstance, imageSetupTooLong } from "@t3flare/harness-registry";

import type { BuilderContainer } from "./baseBuild.ts";
import { WORKSPACE_CONTAINER } from "./constants.ts";

const utf8 = new TextEncoder();

/** The two Builders (ADR-0047 §1, §8): the Base build's, and the Test base build's (SPI-1334). */
export type BuilderKind = keyof typeof BUILDERS;

/** What a Builder keeps as its mark, so its alarm knows it when `ctx.id.name` is not given (the base's is SPI-1332's `true`). */
export const builderMark = (kind: BuilderKind): true | "test" => (kind === "base" ? true : "test");

/** Which Builder an object is: by its reserved name, else by the mark it kept; undefined for a Workspace. */
export const builderKindOf = (name: string | undefined, mark: unknown): BuilderKind | undefined => {
  if (name === BUILDERS.base) return "base";
  if (name === BUILDERS.test) return "test";
  return mark === true ? "base" : mark === "test" ? "test" : undefined;
};

/** A Test base build's proposed Image setup as an RPC carries it: text within the Image setup's own bound. */
export const proposedSetup = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("t3flare: a Test base build's Image setup is text");
  const tooLong = imageSetupTooLong(value);
  if (tooLong !== undefined) throw new Error(`t3flare: ${tooLong}`);
  return value;
};

/** The Workspace image's digest-pinned reference (`ctx.container.images`), or undefined where there is none (local tests). */
export const workspaceImage = (container: Container | undefined): string | undefined =>
  container?.images?.[WORKSPACE_CONTAINER];

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
