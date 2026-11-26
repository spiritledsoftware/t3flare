// SPI-1450: a carried socket's messages from the Container, through workerd's own WebSocket at the Worker's
// compatibility date, where a binary message is a `Blob` unless the socket asks for an `ArrayBuffer`. The dev server is
// the far end of a `WebSocketPair`; the page is the stream of events `open` answers.
import { describe, expect, it } from "vitest";

import { ContainerPreview } from "../src/workspace/containerPreview.ts";
import { CONTAINER_PREVIEW_HEADER } from "../src/workspace/containerPreviewScript.ts";

/** The `data` of each event in `text`, a stream of server-sent events, by type. */
const eventsOf = (text: string) =>
  text
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") || block.startsWith("event: "))
    .map((block) => {
      const type = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
      return { type, data: JSON.parse(data) as Record<string, unknown> };
    });

describe("a carried socket's messages from the Container", () => {
  it("keep a binary message's bytes, in order with text", async () => {
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    const preview = new ContainerPreview({
      running: () => true,
      port: () =>
        ({
          fetch: async () => new Response(null, { status: 101, webSocket: pair[0] }),
        }) as unknown as Fetcher,
      used: async () => undefined,
      hold: () => () => undefined,
      newId: () => "a".repeat(64),
      keepAliveMs: () => 60_000,
      warn: () => undefined,
    });
    const response = await preview.serve(
      new Request("http://6080.t3flare.internal/__t3flare/ws/open?path=%2Fwebsockify&protocols=", {
        headers: { [CONTAINER_PREVIEW_HEADER]: "1" },
      }),
      6080,
    );
    expect(response.status).toBe(200);

    server.send(new TextEncoder().encode("RFB 003.008\n"));
    server.send("after");
    server.send(new Uint8Array([0, 255, 1]));
    server.close(1000, "done");

    const events = eventsOf(await response.text());
    const messages = events.filter((event) => event.type === "message");
    expect(messages.map((event) => event.data)).toEqual([
      { binary: btoa("RFB 003.008\n") },
      { text: "after" },
      { binary: btoa(String.fromCharCode(0, 255, 1)) },
    ]);
    expect(events.at(-1)).toEqual({ type: "close", data: { code: 1000, reason: "done" } });
  });
});
