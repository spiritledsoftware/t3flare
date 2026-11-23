// Commands stopped before they started (SPI-1150, ADR-0032's Global mise config refinement): a Durable agent's command that
// timed out or was aborted while its Container started (and installed the Global mise config) is dispatched by
// computer once the connect returns, minutes later. The Session hands its id to the Workspace DO's `killExecs` when it
// stops it; the Workspace DO remembers the id here, and its backend refuses to send that command at all.
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";

/** The variable a command's environment carries its exec id in (computer-env's `EXEC_MARKER`). */
const EXEC_MARKER = "T3FLARE_EXEC";

/**
 * The ids the Session stopped. Each is kept until its command is refused, with no age limit (SPI-1359): a connect can
 * take as long as the Base wait and the Container start's time limits allow (each an Owner setting), and an id forgotten
 * early lets its command run. One stopped while it ran is never refused and stays: a few dozen bytes, lost with the
 * isolate.
 */
export class StoppedExecs {
  readonly #ids = new Set<string>();

  /** The Session stopped these commands. */
  stopped(ids: ReadonlyArray<string>): void {
    for (const id of ids) this.#ids.add(id);
  }

  has(id: string | undefined): boolean {
    return id !== undefined && this.#ids.has(id);
  }

  /** Whether `id` was stopped, forgetting it: its command is refused now. */
  take(id: string | undefined): boolean {
    return id !== undefined && this.#ids.delete(id);
  }
}

/** `inner` refusing to send a command whose exec id was stopped before it was sent. */
export class StoppedExecsBackend implements WorkspaceBackend {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly callable?: boolean;
  readonly #inner: WorkspaceBackend;
  readonly #stopped: StoppedExecs;

  constructor(inner: WorkspaceBackend, stopped: StoppedExecs) {
    this.#inner = inner;
    this.#stopped = stopped;
    this.id = inner.id;
    this.type = inner.type;
    this.description = inner.description ?? "";
    if (inner.callable !== undefined) this.callable = inner.callable;
  }

  async connect(host: Parameters<WorkspaceBackend["connect"]>[0]): Promise<BackendHandle> {
    const handle = await this.#inner.connect(host);
    const stopped = this.#stopped;
    const shell: BackendHandle["rpc"]["shell"] = {
      exec: (input) => {
        if (stopped.take(input.env?.[EXEC_MARKER]))
          return Promise.reject(new Error("t3flare: the command was stopped before it started; it was not run"));
        return handle.rpc.shell.exec(input);
      },
      getExec: (input) => handle.rpc.shell.getExec(input),
      killExec: (input) => handle.rpc.shell.killExec(input),
      disposeExec: (input) => handle.rpc.shell.disposeExec(input),
    };
    return {
      ...handle,
      rpc: {
        get sync() {
          return handle.rpc.sync;
        },
        shell,
      },
    };
  }
}
