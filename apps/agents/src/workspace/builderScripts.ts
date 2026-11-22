// The bash the Builder runs on its Container (SPI-1332, ADR-0047 §1), through the platform's exec. No Node imports: the
// agents Worker imports it, and the docker test runs it on the real image.
//
// The Image setup runs detached (`setsid`), writing its output to a log and its exit code to a file the Builder's alarm
// polls, so a deploy that resets the Builder's object loses nothing. Everything the Builder writes is under `/run`, a
// tmpfs the snapshot does not capture: the Base snapshot holds what the Global mise lay-down and the Image setup wrote,
// and nothing of the Builder's.
import { GLOBAL_MISE_SCRIPT } from "@t3flare/sandbox-image/globalMise";

/** The Builder's work directory on its Container: on `/run`, which is tmpfs (not captured by a snapshot). */
export const BUILDER_DIR = "/run/t3flare-builder";

/** The files the Builder writes there before it starts the run, each from an exec's stdin. */
export const BUILDER_FILES = {
  setup: `${BUILDER_DIR}/image-setup.sh`,
  mise: `${BUILDER_DIR}/global-mise.toml`,
  laydown: `${BUILDER_DIR}/global-mise.sh`,
  run: `${BUILDER_DIR}/run.sh`,
} as const;

export const BUILDER_LOG = `${BUILDER_DIR}/log`;
export const BUILDER_EXIT = `${BUILDER_DIR}/exit`;

/** What `BUILDER_FILES.laydown` holds: the Workspace DO's own Global mise lay-down, unchanged. */
export const LAYDOWN_SCRIPT = GLOBAL_MISE_SCRIPT;

/**
 * The run (`BUILDER_FILES.run`): `bash run.sh <revision> <sha256> <source>`, under the environment the launch gave it
 * (every Variable, `COMMAND_ENV`, `HOME=/root`). The Global mise config is laid down first, on the Workspace DO's model
 * (its answer goes to the log; a file it does not keep fails nothing here, as at a Container start); then the Image setup
 * runs as root from `/root`. Its exit code is written last, atomically.
 */
export const RUN_SCRIPT = `set -u
dir=${BUILDER_DIR}
if [ -s ${BUILDER_FILES.mise} ]; then
  echo "t3flare: laying down the Global mise config"
  bash ${BUILDER_FILES.laydown} "$1" "$2" "$3" < ${BUILDER_FILES.mise}
fi
echo "t3flare: running the Image setup"
cd /root
bash ${BUILDER_FILES.setup}
code=$?
echo "t3flare: the Image setup exited $code"
echo "$code" > "$dir/exit.tmp" && mv "$dir/exit.tmp" ${BUILDER_EXIT}
`;

/** Writes stdin to the file `$1` under the work directory (made first). */
export const WRITE_SCRIPT = `mkdir -p ${BUILDER_DIR} && cat > "$1"`;

/** Starts the run detached and answers at once: `bash -c <this> t3flare-builder <revision> <sha256> <source>`. */
export const LAUNCH_SCRIPT = `rm -f ${BUILDER_EXIT} ${BUILDER_LOG}
setsid bash ${BUILDER_FILES.run} "$@" > ${BUILDER_LOG} 2>&1 < /dev/null &
echo launched`;

/** The run's exit code once it ended: prints it, or nothing while it runs. */
export const EXIT_SCRIPT = `cat ${BUILDER_EXIT} 2>/dev/null || true`;

/** The end of the run's log (`blankSecrets` cuts it by byte offset): `bash -c <this> t3flare-builder <bytes>`. */
export const TAIL_SCRIPT = `tail -c "$1" ${BUILDER_LOG} 2>/dev/null || true`;

/**
 * The proof that a start from the candidate works (ADR-0047 §2): the image's own entrypoint runs computerd, and this
 * command succeeds. Read from `/proc`, which every image has (procps may not be installed).
 */
export const PROOF_SCRIPT = `grep -qx computerd /proc/[0-9]*/comm 2>/dev/null`;
