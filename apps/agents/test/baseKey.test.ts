// The Base snapshot's key (SPI-1332, ADR-0047 §3): what made it, so a snapshot of other settings or another image is
// never taken for the current one. A secret Variable's value enters it only through a keyed digest.
import { describe, expect, it } from "vitest";

import { BUILDER_FORMAT, baseKey, type BaseKeyInputs } from "../src/workspace/baseKey.ts";

const SECRET_KEY = new Uint8Array(32).fill(7);

const inputs: BaseKeyInputs = {
  imageDigest: "registry/workspace@sha256:1111",
  imageSetup: "apt-get install -y jq\n",
  globalMiseConfig: "[tools]\nnode = '24'\n",
  variables: [
    { name: "PLAIN", value: "one", secret: false },
    { name: "TOKEN", value: "hunter2", secret: true },
  ],
};

describe("baseKey", () => {
  it("is a SHA-256 in hex, the same for the same inputs", async () => {
    const key = await baseKey(inputs, SECRET_KEY);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await baseKey({ ...inputs }, SECRET_KEY)).toBe(key);
  });

  it("moves with each input: the image, the Image setup, the Global mise config, each Variable and the format", async () => {
    const key = await baseKey(inputs, SECRET_KEY);
    const moved = [
      { ...inputs, imageDigest: "registry/workspace@sha256:2222" },
      { ...inputs, imageSetup: "apt-get install -y yq\n" },
      { ...inputs, globalMiseConfig: "" },
      { ...inputs, variables: [inputs.variables[0]!] },
      { ...inputs, variables: [{ ...inputs.variables[0]!, value: "two" }, inputs.variables[1]!] },
      { ...inputs, variables: [inputs.variables[0]!, { ...inputs.variables[1]!, value: "hunter3" }] },
      { ...inputs, variables: [{ ...inputs.variables[0]!, secret: true }, inputs.variables[1]!] },
    ];
    for (const each of moved) expect(await baseKey(each, SECRET_KEY)).not.toBe(key);
    expect(await baseKey(inputs, SECRET_KEY, BUILDER_FORMAT + 1)).not.toBe(key);
  });

  it("ignores the Variables' order, which reaches no command", async () => {
    expect(await baseKey({ ...inputs, variables: [...inputs.variables].reverse() }, SECRET_KEY)).toBe(await baseKey(inputs, SECRET_KEY));
  });

  it("takes a secret value through the Builder's own key: another key gives another digest, a plain one does not", async () => {
    const other = new Uint8Array(32).fill(9);
    expect(await baseKey(inputs, other)).not.toBe(await baseKey(inputs, SECRET_KEY));
    const plainOnly = { ...inputs, variables: [inputs.variables[0]!] };
    expect(await baseKey(plainOnly, other)).toBe(await baseKey(plainOnly, SECRET_KEY));
  });
});
