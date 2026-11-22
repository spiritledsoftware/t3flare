// The Base snapshot's key (SPI-1332, ADR-0047 §3). The platform does not tie a snapshot to the image it was made on (an
// old one starts, silently, on the old image after the image changes), so t3flare keys it to what made it: the Workspace
// image's digest, the Image setup, the Global mise config, the Variables, and the Builder's own format. The Container size
// is not in it: every size starts from any snapshot.
//
// A secret Variable's value enters the key only as an HMAC under a random key the Builder keeps (ADR-0046): the key is
// kept in storage and shown on Status, and a plain SHA-256 of a short secret could be guessed back.

/** Bumped when what the Builder does to a Container changes, so every Base snapshot is built again. */
export const BUILDER_FORMAT = 1;

export interface BaseKeyInputs {
  /** `ctx.container.images.WorkspaceContainer`: a digest-pinned reference, stable across a deploy that leaves it alone. */
  readonly imageDigest: string;
  readonly imageSetup: string;
  readonly globalMiseConfig: string;
  /** The Variables as a Container start gets them: secret values opened. */
  readonly variables: ReadonlyArray<{ readonly name: string; readonly value: string; readonly secret: boolean }>;
}

/** `bytes` in lowercase hex. */
export const hex = (bytes: ArrayBuffer | Uint8Array): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** `text` (lowercase hex) as bytes. */
export const unhex = (text: string): Uint8Array => new Uint8Array((text.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));

const utf8 = new TextEncoder();

/** The SHA-256 of `text`'s UTF-8, in hex. */
export const sha256Hex = async (text: string): Promise<string> => hex(await crypto.subtle.digest("SHA-256", utf8.encode(text)));

/** The key of `inputs`: a SHA-256 in hex. `secretKey` is the Builder's own random HMAC key. */
export const baseKey = async (inputs: BaseKeyInputs, secretKey: Uint8Array, format: number = BUILDER_FORMAT): Promise<string> => {
  const hmac = await crypto.subtle.importKey("raw", secretKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // Sorted by name: their order reaches no command (each is one variable of the environment).
  const variables = await Promise.all(
    [...inputs.variables]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(async (variable) => [variable.name, variable.secret, variable.secret ? hex(await crypto.subtle.sign("HMAC", hmac, utf8.encode(variable.value))) : variable.value] as const),
  );
  const canonical = JSON.stringify([format, inputs.imageDigest, inputs.imageSetup, inputs.globalMiseConfig, variables]);
  return sha256Hex(canonical);
};
