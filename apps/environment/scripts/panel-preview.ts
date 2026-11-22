// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// The Settings page locally, without a stage (SPI-1086, SPI-1337): the live page sits behind Access.
//
// `serve` answers the page and its API on 127.0.0.1 from in-memory fixture state, through the real routes
// (scripts/lib/panelPreview.ts says what is simulated and what is not in the preview); a restart resets it. The file mode
// writes the page rendered from its fixture state (test/fixtures/harnessPage.ts); `empty` renders the first-run state: no
// MCP server and no audit entry.
//
//   node apps/environment/scripts/panel-preview.ts serve [--port <n>]
//   node apps/environment/scripts/panel-preview.ts <out.html> [empty]
import fs from "node:fs";
import { parseArgs } from "node:util";

import { renderPage } from "../src/harness/page.ts";
import { fixturePage } from "../test/fixtures/harnessPage.ts";
import { DEFAULT_PREVIEW_PORT, servePreview } from "./lib/panelPreview.ts";

const USAGE = `usage: panel-preview.ts serve [--port <n>]   (default port ${DEFAULT_PREVIEW_PORT})\n       panel-preview.ts <out.html> [empty]`;

const [first, ...rest] = process.argv.slice(2);
if (first === "serve") {
  const { values } = parseArgs({ args: rest, options: { port: { type: "string" } } });
  const port = values.port === undefined ? DEFAULT_PREVIEW_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`--port is a TCP port, 0 to 65535 (0 takes a free one)\n${USAGE}`);
    process.exit(2);
  }
  const preview = await servePreview({ port });
  console.log(`Settings page preview at ${preview.url} (127.0.0.1 only; state is in memory and resets on restart; Ctrl-C stops it)`);
} else if (first === undefined) {
  console.error(USAGE);
  process.exit(2);
} else {
  fs.writeFileSync(first, renderPage(fixturePage(rest[0] === "empty" ? { mcp: [], audit: [] } : {})));
  console.log(`wrote ${first}`);
}
