// The flag a credential leak leaves in the Workspace DO (`LEAK_FLAG_KEY`), which `leakCheck` reads back as `flagged`:
// when, which credentials, and where. One Durable Object value holds it, so its paths are bounded by that value.
import { DO_VALUE_BYTES, STORED_CHARACTER_BYTES, storedBytes } from "@t3flare/harness-registry";

export interface LeakFlag {
  readonly at: number;
  readonly names: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string>;
  /** How many more paths were hit than the flag holds; absent when it holds them all. */
  readonly more?: number;
}

/**
 * The flag for `hits`: every credential name once, and the hit paths in order, as many as one Durable Object value
 * (`DO_VALUE_BYTES`, a named constraint) holds beside the rest, the others counted in `more`. The leakscan's hit list is
 * not bounded, and a flag that failed its write would flag nothing.
 */
export const leakFlag = (
  hits: ReadonlyArray<{ readonly name: string; readonly path: string }>,
  at: number,
): LeakFlag => {
  const names = [...new Set(hits.map((hit) => hit.name))];
  const all = hits.map((hit) => hit.path);
  const whole: LeakFlag = { at, names, paths: all };
  if (storedBytes(whole) <= DO_VALUE_BYTES) return whole;
  const room = DO_VALUE_BYTES - storedBytes({ at, names, paths: [], more: all.length });
  const paths: Array<string> = [];
  let used = 0;
  for (const path of all) {
    const bytes = storedBytes(path) + STORED_CHARACTER_BYTES;
    if (used + bytes > room) break;
    paths.push(path);
    used += bytes;
  }
  return { at, names, paths, more: all.length - paths.length };
};
