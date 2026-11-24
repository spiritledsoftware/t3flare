// The Settings page's structure (SPI-1086): a snapshot of its markup from the fixture state, and checks over the
// parsed tags (balanced, ids unique, every section in the navigation, every control named), every state it draws, the
// CSP's limits (no inline style or handler, one script), and escaping of hostile strings in every server-supplied field.
// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { Script } from "node:vm";

import {
  applyChange,
  applyToolsChange,
  BUILTIN_TOOLS,
  EMPTY_ENVIRONMENT,
  EMPTY_HARNESS,
  resolveEnvironment,
  resolveHarness,
  SETTINGS_PAGE_PLACES,
  SETTINGS_SERVER_LIMIT_KEYS,
  SETTINGS_SERVER_LIMITS_NOTE,
  settingPlace,
} from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { escapeHtml, LIMIT_GROUPS, type McpRow, renderPage, type SkillsView } from "../src/harness/page.ts";
import { SCRIPT } from "../src/harness/pageScript.ts";

const NO_SKILLS: SkillsView = {
  skills: [],
  totals: { count: 0, enabled: 0, disabled: 0, bytes: 0, disabledBytes: 0, maxBytes: 8_388_608 },
  unauthenticated: false,
};
const SKILL: SkillsView["skills"][number] = {
  name: "grill-me",
  description: "Grill the plan.",
  repo: "mattpocock/skills",
  path: "skills/grill-me",
  ref: null,
  commit: "5863806dd4e15c63174bee4e7515a4256792ecfa",
  enabled: true,
  savedAt: Date.UTC(2026, 10, 14),
  files: 2,
  bytes: 1024,
};
import { FIXTURE_MCP, FIXTURE_NOW, FIXTURE_WORKSPACES, fixturePage } from "./fixtures/harnessPage.ts";
import { WORKSPACES_SCRIPT } from "../src/harness/pageWorkspaces.ts";

/** One section of a rendered page, by its id. */
const section = (html: string, id: string): string => {
  const start = html.indexOf(`<section id="${id}"`);
  return html.slice(start, html.indexOf("</section>", start));
};

interface Tag {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly index: number;
}

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** The page's markup with its constant stylesheet and script bodies left out. */
const markup = (html: string) =>
  html
    .replace(/<style>[\s\S]*?<\/style>/, "<style></style>")
    .replace(/<script>[\s\S]*?<\/script>/, "<script></script>");

/** Every tag, in order, with its attributes (values unescaped only as far as the checks need: not at all). */
const tagsOf = (html: string): Array<Tag> => {
  const tags: Array<Tag> = [];
  for (const match of markup(html).matchAll(
    /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g,
  )) {
    const attrs: Record<string, string> = {};
    for (const attr of match[3]!.matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) attrs[attr[1]!] = attr[2] ?? "";
    tags.push({
      name: match[2]!.toLowerCase(),
      attrs,
      closing: match[1] === "/",
      selfClosing: match[4] === "/",
      index: match.index,
    });
  }
  return tags;
};

/** The open elements at the end, or the first mismatch. */
const balance = (tags: ReadonlyArray<Tag>): string => {
  const stack: Array<string> = [];
  for (const tag of tags) {
    if (tag.name === "!doctype" || VOID.has(tag.name) || tag.selfClosing) continue;
    if (!tag.closing) stack.push(tag.name);
    else if (stack.pop() !== tag.name) return `mismatched </${tag.name}> at ${tag.index}`;
  }
  return stack.length === 0 ? "balanced" : `unclosed: ${stack.join(" > ")}`;
};

/** The text inside the element opened by `tags[start]` (tags stripped). */
const textOf = (html: string, tags: ReadonlyArray<Tag>, start: number): string => {
  let depth = 0;
  for (let i = start; i < tags.length; i++) {
    const tag = tags[i]!;
    if (tag.name !== tags[start]!.name) continue;
    depth += tag.closing ? -1 : 1;
    if (depth === 0)
      return markup(html)
        .slice(tags[start]!.index, tag.index)
        .replace(/<[^>]*>/g, "")
        .trim();
  }
  return "";
};

describe("harness page", () => {
  const html = renderPage(fixturePage());
  const tags = tagsOf(html);

  it("matches its snapshot (markup only; the stylesheet and script are constants under their own hashes)", async () => {
    await expect(markup(html)).toMatchFileSnapshot("./__snapshots__/harnessPage.html");
  });

  it("is well formed, with unique ids", () => {
    expect(balance(tags)).toBe("balanced");
    const ids = tags.flatMap((tag) => (tag.attrs.id === undefined ? [] : [tag.attrs.id]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("links every section from the navigation, in order, each with its heading", () => {
    const nav = tags.filter(
      (tag) =>
        tag.name === "a" &&
        tag.attrs.href?.startsWith("#") &&
        tag.attrs.href !== "#main" &&
        tag.attrs.href !== "#add-server" &&
        tag.attrs["data-jump"] === undefined,
    );
    expect(nav.map((tag) => tag.attrs.href)).toEqual([
      "#tools",
      "#extensions",
      "#mcp",
      "#environment",
      "#workspaces",
      "#skills",
      "#status",
      "#audit",
    ]);
    for (const link of nav) {
      const section = tags.find((tag) => tag.name === "section" && tag.attrs.id === link.attrs.href!.slice(1));
      expect(section?.attrs["aria-labelledby"]).toBeDefined();
      expect(tags.some((tag) => tag.name === "h2" && tag.attrs.id === section!.attrs["aria-labelledby"])).toBe(true);
    }
    expect(tags.filter((tag) => tag.name === "h1" && !tag.closing)).toHaveLength(1);
  });

  it("names every control: a label, aria-labelledby or aria-label for each field, text or aria-label for each button", () => {
    const labelled = new Set(
      tags.filter((tag) => tag.name === "label" && tag.attrs.for !== undefined).map((tag) => tag.attrs.for),
    );
    tags.forEach((tag, index) => {
      if (tag.closing) return;
      if (tag.name === "input" || tag.name === "select") {
        const insideLabel =
          tags
            .slice(0, index)
            .reduce((depth, other) => (other.name === "label" ? depth + (other.closing ? -1 : 1) : depth), 0) > 0;
        expect(
          insideLabel ||
            labelled.has(tag.attrs.id) ||
            tag.attrs["aria-labelledby"] !== undefined ||
            tag.attrs["aria-label"] !== undefined,
          `${tag.name} ${JSON.stringify(tag.attrs)}`,
        ).toBe(true);
      }
      if (tag.name === "button")
        expect(tag.attrs["aria-label"] ?? textOf(html, tags, index), JSON.stringify(tag.attrs)).not.toBe("");
    });
  });

  it("draws each server's state: connected, error with its last error, not listed, signed out, a header set by fingerprint", () => {
    expect(html).toContain('<span class="pill pill-ok">Connected</span>');
    expect(html).toContain('<span class="pill pill-err">Error</span>');
    expect(html).toContain("Unreachable: The server is unavailable (HTTP 530)");
    expect(html).toContain('<span class="pill">Not listed yet</span>');
    expect(html).toContain("OAuth, signed out");
    expect(html).toContain('data-mcp-oauth="linear"');
    expect(html).toContain("#9e2b");
    expect(html).toMatch(/<span class="flag" role="img" aria-label="1 server failing">/);
    // Every server has its switch, its Test and its result line; only direct servers can be removed.
    for (const row of FIXTURE_MCP) {
      expect(html).toContain(`data-mcp-test="${row.name}"`);
      expect(html).toContain(`data-test-result="${row.name}"`);
      expect(html).toContain(escapeHtml(JSON.stringify({ op: "server", server: row.name, enabled: false })));
      expect(html.includes(escapeHtml(JSON.stringify({ op: "remove", server: row.name })))).toBe(
        row.setting.kind === "direct",
      );
    }
    // The owner's class override is marked, with a way back to the tool's hint.
    expect(html).toContain("Set by you; its hint says read");
    expect(html).toContain(
      escapeHtml(JSON.stringify({ op: "class", server: "fixture", tool: "fixture_echo", class: null })),
    );
    expect(html).toContain("1 tool refused");
  });

  it("draws an Exposure select for each server and each tool, saving through the JSON API's own values", () => {
    const selects = tags.filter((tag) => tag.name === "select" && tag.attrs["data-mcp-exposure"] !== undefined);
    const optionsOf = (select: Tag) => {
      const end = tags.findIndex((tag, index) => index > tags.indexOf(select) && tag.name === "select" && tag.closing);
      return tags.slice(tags.indexOf(select) + 1, end).filter((tag) => tag.name === "option" && !tag.closing);
    };
    // One per server, one per tool.
    expect(
      selects.filter((tag) => tag.attrs["data-tool"] === undefined).map((tag) => tag.attrs["data-mcp-exposure"]),
    ).toEqual(FIXTURE_MCP.map((row) => row.name));
    expect(selects.filter((tag) => tag.attrs["data-tool"] !== undefined)).toHaveLength(
      FIXTURE_MCP.reduce((sum, row) => sum + row.tools.length, 0),
    );
    const server = selects.find(
      (tag) => tag.attrs["data-mcp-exposure"] === "fixture" && tag.attrs["data-tool"] === undefined,
    )!;
    expect(optionsOf(server).map((option) => option.attrs.value)).toEqual(["direct", "deferred", "codemode", "hidden"]);
    expect(optionsOf(server).find((option) => option.attrs.selected !== undefined)?.attrs.value).toBe("deferred");
    // A tool without its own Exposure follows its server's; the owner's is selected.
    const echo = selects.find((tag) => tag.attrs["data-tool"] === "fixture_echo")!;
    expect(optionsOf(echo).map((option) => option.attrs.value)).toEqual([
      "",
      "direct",
      "deferred",
      "codemode",
      "hidden",
    ]);
    expect(optionsOf(echo).find((option) => option.attrs.selected !== undefined)?.attrs.value).toBe("");
    const note = selects.find((tag) => tag.attrs["data-tool"] === "fixture_note")!;
    expect(optionsOf(note).find((option) => option.attrs.selected !== undefined)?.attrs.value).toBe("hidden");
    expect(note.attrs["aria-label"]).toBe("fixture_note exposure");
  });

  it("draws the add form's three sign-in kinds, the header fields hidden until chosen", () => {
    for (const kind of ["oauth", "header", "none"])
      expect(tags.some((tag) => tag.name === "input" && tag.attrs.name === "auth" && tag.attrs.value === kind)).toBe(
        true,
      );
    expect(tags.find((tag) => tag.attrs["data-header-fields"] !== undefined)?.attrs.hidden).toBe("");
    expect(tags.find((tag) => tag.attrs.name === "value")?.attrs.type).toBe("password");
  });

  it("draws the extension forms from the registry's schemas: tools first, then switches and settings; only permissions is locked", () => {
    expect(
      tags
        .filter((tag) => tag.name === "form" && tag.attrs["data-extension"] !== undefined)
        .map((tag) => tag.attrs["data-extension"]),
    ).toEqual([
      "codemode",
      "tool-search",
      "coding-tools",
      "files",
      "ask-user",
      "web",
      "todo",
      "context",
      "termctrl",
      "tool-output",
      "guardian",
      "advisor",
      "skills",
      "prompt-suggestions",
      // SPI-1321: no longer locked, "Always on" with its settings; permissions stays locked.
      "project-context",
    ]);
    expect(tags.find((tag) => tag.attrs["data-setting"] === "inlineBudget")).toMatchObject({
      attrs: { type: "number", min: "0", value: "3000" },
    });
    // No maximum (SPI-1368): the browser is given none to name.
    expect(tags.find((tag) => tag.attrs["data-setting"] === "inlineBudget")?.attrs.max).toBeUndefined();
    expect(tags.filter((tag) => tag.attrs["data-enabled"] !== undefined)).toHaveLength(3);
    expect(html).toContain("locked: the thread&#39;s modes and the link fence depend on it");
    expect(html).not.toContain("a core extension: always on");
    expect(tags.find((tag) => tag.attrs.id === "project-context-maxFileCharacters")).toMatchObject({
      attrs: { type: "number", min: "1", max: "1000000", value: "16000" },
    });
    expect(tags.find((tag) => tag.attrs.id === "project-context-maxFileCharacters")?.attrs.disabled).toBeUndefined();
  });

  it("draws one Exposure select per built-in tool, codemode and tool_search with only direct or hidden, and the three presets", () => {
    const selects = tags.filter(
      (tag) =>
        tag.name === "select" && tag.attrs["data-tool-exposure"] !== undefined && tag.attrs["data-t3"] === undefined,
    );
    expect(selects.map((tag) => tag.attrs["data-tool-exposure"])).toEqual(BUILTIN_TOOLS.map((tool) => tool.name));
    expect(
      tags.filter((tag) => tag.attrs["data-tools-preset"] !== undefined).map((tag) => tag.attrs["data-tools-preset"]),
    ).toEqual(["core", "codemode-only", "everything"]);
    const tools = section(html, "tools");
    expect(tools).toContain(
      '<select class="sel-sm" data-tool-exposure="codemode" aria-label="codemode exposure"><option value="direct" selected title="in every request">direct</option><option value="hidden" title="not offered">hidden</option></select>',
    );
    expect(tools).toContain('<option value="hidden" selected title="not offered">hidden</option>');
    expect(tools).toContain('<span class="pill" title="Every tool hidden">Off</span>');
  });

  it("says an extension's settings do nothing while every one of its tools is hidden", () => {
    const hidden = applyToolsChange(EMPTY_HARNESS, {
      tools: Object.fromEntries(
        ["terminal_start", "terminal_send", "terminal_stop", "terminal_list", "terminal_wait"].map((tool) => [
          tool,
          "hidden",
        ]),
      ),
    });
    if (!hidden.ok) throw new Error(hidden.error);
    const terminals = (resolved: ReturnType<typeof resolveHarness>) => {
      const tools = section(renderPage(fixturePage({ resolved })), "tools");
      return tools.slice(
        tools.indexOf('data-extension="termctrl"'),
        tools.indexOf("</form>", tools.indexOf('data-extension="termctrl"')),
      );
    };
    expect(terminals(resolveHarness(hidden.harness))).toContain(
      // Its settings are all Advanced (ADR-0049 §6), which follow its tools: the row says where they went.
      "Every tool is hidden, so the extension is off: its Advanced settings show once a tool is offered.",
    );
    expect(terminals(resolveHarness(EMPTY_HARNESS))).not.toContain("Every tool is hidden");
    // SPI-1397: no count; the exited bound is named with its value.
    expect(terminals(resolveHarness(EMPTY_HARNESS))).toContain(
      "Any number run at once; a Workspace keeps its last 128 exited ones readable",
    );
  });

  it("draws t3's tools on the always-on t3-code card: t3's hints as defaults, waits never codemode, denied tools named", () => {
    const mcp = section(html, "mcp");
    expect(mcp).toContain('<h3 id="mcp-t3-code">t3-code</h3>');
    expect(mcp).toContain('<option value="" selected>t3 asks: direct</option>');
    expect(mcp).toContain('<option value="" selected>Default (direct)</option>');
    const wait = /data-tool-exposure="t3_thread_wait"[^>]*>(.*?)<\/select>/.exec(mcp)?.[1] ?? "";
    expect(wait).not.toContain("codemode");
    expect(mcp).toContain('<option value="deferred" selected title="loaded by tool_search">deferred</option>');
    expect(mcp).toContain("<code>t3_attachment_upload</code>");
    const { t3Tools: _listed, ...unlisted } = fixturePage();
    const empty = renderPage(unlisted);
    expect(section(empty, "mcp")).toContain("Not listed yet: t3 lists its tools for each thread");
  });

  it("draws the audit log as its own table, each row's cells as Show older builds them (SPI-1380)", () => {
    const table = tags.find((tag) => tag.name === "table" && tag.attrs.class?.split(" ").includes("audit"));
    expect(table?.attrs.class).toBe("stacked audit");
    // The first body row's cells.
    const rows = tags.slice(tags.indexOf(table!));
    const body = rows.findIndex((tag) => tag.name === "tbody");
    const end = rows.findIndex((tag, index) => index > body && tag.name === "tr" && tag.closing);
    const served = rows
      .slice(body, end)
      .filter((tag) => tag.name === "td" && !tag.closing)
      .map((tag) => [tag.attrs["data-label"], tag.attrs.class ?? null]);
    // The page script's cell(label, className, …) calls for an older page, in order.
    const scripted = [...SCRIPT.matchAll(/cell\("([^"]+)", (?:"([^"]+)"|undefined)/g)].map((match) => [
      match[1],
      match[2] ?? null,
    ]);
    expect(served).toEqual([
      ["When", "when"],
      ["Who", "who"],
      ["Settings", null],
      ["Action", null],
      ["Target", "target"],
      ["Change", "change-cell"],
    ]);
    expect(scripted).toEqual(served);
  });

  it("draws the empty states: no server, no audit entry, no Environment skill (the placeholder gone, SPI-1148)", () => {
    const empty = renderPage(fixturePage({ mcp: [], audit: [], skills: NO_SKILLS }));
    expect(empty).toContain("No MCP servers");
    expect(empty).toContain("No changes yet");
    expect(empty).toContain("No Environment skills");
    expect(empty).not.toContain("aren't here yet");
    expect(empty).toContain("data-skill-install");
    expect(empty).toContain("data-mcp-add");
    expect(balance(tagsOf(empty))).toBe("balanced");
  });

  it("stays within its CSP: one script, one stylesheet, no style attribute, no inline handler, nothing fetched", () => {
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<style/g)).toHaveLength(1);
    for (const tag of tags) {
      expect(
        Object.keys(tag.attrs).filter((name) => name === "style" || /^on/i.test(name)),
        tag.name,
      ).toEqual([]);
      if (tag.name === "use") expect(tag.attrs.href).toMatch(/^#i-/);
      expect(["img", "iframe", "object", "embed"]).not.toContain(tag.name);
    }
    // The one link is the favicon, a `data:` URL: the only source the CSP's `img-src` allows.
    expect(
      tags.filter((tag) => tag.name === "link").map((tag) => [tag.attrs.rel, tag.attrs.href?.slice(0, 19)]),
    ).toEqual([["icon", "data:image/svg+xml,"]]);
  });

  it("escapes hostile strings in every server-supplied field", () => {
    const hostile = `"><img src=x onerror=alert(1)>'&<script>`;
    const row: McpRow = {
      name: hostile,
      setting: {
        kind: "direct",
        enabled: true,
        exposure: hostile,
        url: hostile,
        auth: { kind: "header", header: hostile },
      },
      secret: { set: true, setAt: FIXTURE_NOW, fingerprint: hostile },
      status: "failed",
      listedAt: FIXTURE_NOW,
      error: hostile,
      tools: [{ name: hostile, upstream: hostile, class: "write", hinted: hostile, exposure: hostile }],
      overrides: { [hostile]: "write" },
      toolExposure: { [hostile]: hostile },
      refused: [{ tool: hostile, reason: hostile }],
    };
    const page = renderPage({
      resolved: resolveHarness(EMPTY_HARNESS),
      csrf: hostile,
      // A stored `enabled` is not type-checked by the registry: a string must not reach an attribute raw.
      mcp: [
        row,
        {
          ...row,
          setting: { ...row.setting, enabled: hostile as unknown as boolean, auth: { kind: hostile } },
          status: hostile,
        },
      ],
      audit: [
        {
          at: FIXTURE_NOW,
          entity: "harness",
          caller: hostile,
          action: hostile,
          target: hostile,
          after: { note: hostile },
        },
      ],
      status: { [hostile]: hostile },
    });
    expect(page).not.toContain("<img");
    expect(page.match(/<script/g)).toHaveLength(1);
    expect(page).toContain(escapeHtml(hostile));
    // The exact mapping: quotes, angle brackets, the apostrophe and the ampersand each become an entity.
    expect(escapeHtml(hostile)).toBe("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&#39;&amp;&lt;script&gt;");
    const parsed = tagsOf(page);
    expect(balance(parsed)).toBe("balanced");
    expect(parsed.some((tag) => Object.keys(tag.attrs).some((name) => /^on/i.test(name)))).toBe(false);
  });

  it("draws each Environment skill with its source, commit, switch and actions, and the totals with disabled ones apart (SPI-1148)", () => {
    const page = renderPage(
      fixturePage({
        skills: {
          ...NO_SKILLS,
          skills: [SKILL, { ...SKILL, name: "off", enabled: false }],
          totals: { ...NO_SKILLS.totals, count: 2, enabled: 1, disabled: 1, bytes: 2048, disabledBytes: 1024 },
        },
      }),
    );
    const parsed = tagsOf(page);
    expect(
      parsed
        .filter((tag) => tag.attrs["data-skill-enable"] !== undefined)
        .map((tag) => [tag.attrs["data-skill-enable"], tag.attrs.checked !== undefined]),
    ).toEqual([
      ["grill-me", true],
      ["off", false],
    ]);
    expect(parsed.filter((tag) => tag.attrs["data-skill-remove"] !== undefined)).toHaveLength(2);
    expect(page).toContain(
      "From <code>mattpocock/skills/skills/grill-me</code> on the default branch, 2 files, 1.0 KiB",
    );
    expect(page).toContain(
      "2 skills (1 enabled, 1 disabled); 2.0 KiB of 8.00 MiB, 1.0 KiB of it disabled. Disabled skills count toward the limit.",
    );
    expect(page).not.toContain("Reads from GitHub are unauthenticated");
    expect(renderPage(fixturePage({ skills: { ...NO_SKILLS, unauthenticated: true } }))).toContain(
      "Reads from GitHub are unauthenticated",
    );
  });

  it("escapes hostile strings in every Environment skill field: description, path, ref, repo (SPI-1148)", () => {
    const hostile = `"><img src=x onerror=alert(1)>'&<script>`;
    const page = renderPage(
      fixturePage({
        skills: {
          ...NO_SKILLS,
          skills: [
            {
              ...SKILL,
              name: hostile,
              description: hostile,
              repo: hostile,
              path: hostile,
              ref: hostile,
              commit: hostile,
            },
          ],
        },
      }),
    );
    expect(page).not.toContain("<img");
    expect(page.match(/<script/g)).toHaveLength(1);
    const parsed = tagsOf(page);
    expect(balance(parsed)).toBe("balanced");
    expect(parsed.some((tag) => Object.keys(tag.attrs).some((name) => /^on/i.test(name)))).toBe(false);
  });

  it("writes every answer in the page script as text, never as HTML", () => {
    expect(SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

// The Settings server's row (ADR-0035, plan D2), M3 (SPI-1198): one three-way access control, fixed classes, no Test,
// no Remove.
describe("the Settings server's row", () => {
  const row = (setting: Partial<McpRow["setting"]>): McpRow => ({
    name: "settings",
    setting: { kind: "settings", enabled: true, exposure: "deferred", writes: true, ...setting },
    status: "ok",
    listedAt: FIXTURE_NOW,
    error: null,
    tools: [
      {
        name: "mcp__settings__get_settings",
        upstream: "get_settings",
        class: "read",
        hinted: "read",
        exposure: "deferred",
      },
      {
        name: "mcp__settings__change_mcp",
        upstream: "change_mcp",
        class: "write",
        hinted: "write",
        exposure: "deferred",
      },
    ],
    refused: [],
  });
  const section = (html: string) =>
    html.slice(
      html.indexOf('aria-labelledby="srv-settings"'),
      html.indexOf("</article>", html.indexOf('aria-labelledby="srv-settings"')),
    );

  it("offers off, read-only and read-write, the current one pressed", () => {
    for (const [setting, pressed] of [
      [{ enabled: false }, "Off"],
      [{ writes: false }, "Read-only"],
      [{}, "Read-write"],
    ] as const) {
      const html = section(renderPage(fixturePage({ mcp: [row(setting)] })));
      expect(html).toContain('<span class="tag">Settings server</span>');
      expect(html).toContain(escapeHtml(JSON.stringify({ op: "server", server: "settings", enabled: false })));
      expect(html).toContain(
        escapeHtml(JSON.stringify({ op: "server", server: "settings", enabled: true, writes: false })),
      );
      expect(html).toContain(
        escapeHtml(JSON.stringify({ op: "server", server: "settings", enabled: true, writes: true })),
      );
      expect(html).toMatch(new RegExp(`aria-pressed="true"[^>]*>${pressed}<`));
      expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
      expect(html).not.toContain('role="switch"');
      expect(html).not.toContain("data-mcp-test");
      expect(html).not.toContain(escapeHtml('"op":"remove"'));
      expect(html).not.toContain(escapeHtml('"op":"class"'));
    }
  });

  it("has a Limits form of its ten limits, at their values, saving them as one change to its entry (SPI-1322)", () => {
    const at = (setting: Partial<McpRow["setting"]>) => section(renderPage(fixturePage({ mcp: [row(setting)] })));
    const inputs = (html: string) =>
      tagsOf(html)
        .filter((tag) => tag.name === "input" && tag.attrs["data-setting"] !== undefined)
        .map((tag) => [tag.attrs["data-setting"], tag.attrs.value, tag.attrs.min, tag.attrs.max]);
    const html = at({});
    expect(html).toContain('<form class="server-limits" data-mcp-limits="settings"');
    // Each off by default (SPI-1386): an empty field, "off" its placeholder.
    expect(inputs(html)).toEqual([
      ["strikes", "", "0", "1000"],
      ["strikeWindowMinutes", "", "0", "10080"],
      ["strikeLockMinutes", "", "0", "10080"],
      ["declinedRepeatMinutes", "", "0", "10080"],
      ["appliedPerHour", "", "0", "100000"],
      ["askedPerHour", "", "0", "100000"],
      ["readsPerHour", "", "0", "100000"],
      ["networkReadsPerHour", "", "0", "100000"],
      ["openPerThread", "", "0", "1000"],
      ["openPerOwner", "", "0", "1000"],
    ]);
    expect(
      tagsOf(html)
        .filter((tag) => tag.name === "input" && tag.attrs["data-setting"] !== undefined)
        .map((tag) => tag.attrs.placeholder),
    ).toEqual(Array(10).fill("off"));
    // The consequence, once; each limit's range and default in its hint.
    expect(html.split(escapeHtml(SETTINGS_SERVER_LIMITS_NOTE)).length).toBe(2);
    expect(html).toContain("Empty or 0 is off. 1 to 100,000.");
    // Three groups, under legends, covering every limit once.
    expect(tagsOf(html).filter((tag) => tag.name === "legend" && !tag.closing).length).toBe(3);
    expect(LIMIT_GROUPS.flatMap(([, keys]) => keys).sort()).toEqual([...SETTINGS_SERVER_LIMIT_KEYS].sort());
    // A stored value shows; one that no longer fits shows its default.
    expect(inputs(at({ limits: { askedPerHour: 12, strikes: -1, strikeLockMinutes: 60 } })).slice(0, 6)).toEqual([
      ["strikes", "", "0", "1000"],
      ["strikeWindowMinutes", "", "0", "10080"],
      ["strikeLockMinutes", "60", "0", "10080"],
      ["declinedRepeatMinutes", "", "0", "10080"],
      ["appliedPerHour", "", "0", "100000"],
      ["askedPerHour", "12", "0", "100000"],
    ]);
    // A Direct server has none.
    expect(markup(renderPage(fixturePage()))).not.toContain("data-mcp-limits");
  });

  it("its script posts only the limits typed over, as one server change, and nothing when none moved (SPI-1322)", async () => {
    const start = SCRIPT.indexOf('for (const form of document.querySelectorAll("form[data-mcp-limits]"))');
    const handler = SCRIPT.slice(
      start,
      SCRIPT.indexOf('for (const form of document.querySelectorAll("form[data-extension]"))'),
    );
    expect(start).toBeGreaterThan(-1);
    /** The handler over a stub form of three limits; `typed` is what the Owner typed over the stored values. */
    const run = async (typed: Record<string, string>) => {
      const stored: Record<string, string> = { strikes: "3", askedPerHour: "6", strikeLockMinutes: "60" };
      const inputs = Object.entries(stored).map(([setting, value]) => ({
        dataset: { setting, kind: "integer" },
        defaultValue: value,
        value: typed[setting] ?? value,
      }));
      let submit: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
      const form = {
        dataset: { mcpLimits: "settings" },
        closest: () => null,
        querySelector: () => ({}),
        querySelectorAll: () => inputs,
        reportValidity: () => true,
        addEventListener: (_: string, listener: typeof submit) => (submit = listener),
      };
      const posts: Array<unknown> = [];
      const notes: Array<string> = [];
      const context = {
        document: { querySelectorAll: () => [form] },
        location: { hash: "" },
        history: { replaceState: () => undefined },
        watchUnsaved: () => undefined,
        settingsOf: () => Object.fromEntries(inputs.map((input) => [input.dataset.setting, Number(input.value)])),
        notify: (_: string, text: string) => void notes.push(text),
        post: async (_: string, body: unknown) => (posts.push(body), false),
        done: () => undefined,
      };
      new Script(handler).runInNewContext(context);
      await submit!({ preventDefault: () => undefined });
      return { posts, notes };
    };
    expect((await run({ askedPerHour: "12" })).posts).toEqual([
      { op: "server", server: "settings", limits: { askedPerHour: 12 } },
    ]);
    expect((await run({ askedPerHour: "12", strikeLockMinutes: "0" })).posts).toEqual([
      { op: "server", server: "settings", limits: { askedPerHour: 12, strikeLockMinutes: 0 } },
    ]);
    const none = await run({ askedPerHour: "6" });
    expect(none.posts).toEqual([]);
    expect(none.notes).toEqual(["Nothing to save: every limit is as it was."]);
  });
});

// The Environment section's dotfiles row (ADR-0047 §9): the two toggles, on by default, each saying when it applies.
describe("the Environment section's dotfiles", () => {
  const sectionOf = (html: string) =>
    html.slice(
      html.indexOf('<section id="environment"'),
      html.indexOf("</section>", html.indexOf('<section id="environment"')),
    );
  // A row of the Environment form (ADR-0049 §6): its part on the page, then its part under the section's Advanced, which
  // carries the row's description. `rowAt` is where the row starts: under Advanced when it has a part there.
  const rowPart = (section: string, titleId: string) => {
    const start = section.indexOf(`<h3 id="${titleId}">`);
    return start === -1 ? "" : section.slice(start, section.indexOf('<div class="row">', start));
  };
  const rowOf = (section: string, id: string) =>
    rowPart(section, `environment-${id}-title`) + rowPart(section, `environment-advanced-${id}-title`);
  const rowAt = (section: string, id: string) => {
    const advanced = section.indexOf(`<h3 id="environment-advanced-${id}-title">`);
    return advanced > -1 ? advanced : section.indexOf(`<h3 id="environment-${id}-title">`);
  };
  const inputsOf = (html: string) =>
    tagsOf(html)
      .filter((tag) => tag.name === "input" && tag.attrs["data-setting"] !== undefined)
      .map((tag) => tag.attrs["data-setting"]);

  it("draws both toggles in a row of their own, checked by default, outside the Containers row, each saying when it applies", () => {
    const section = sectionOf(renderPage(fixturePage()));
    const tags = tagsOf(section);
    // The Dotfiles row: from its heading to the next row (other rows hold checkboxes of their own, the Builder's).
    const row = rowOf(section, "dotfiles");
    const boxes = tagsOf(row).filter(
      (tag) => tag.name === "input" && tag.attrs.type === "checkbox" && tag.attrs["data-setting"] !== undefined,
    );
    // The agents' dotfiles on the page, the bashrc escape hatch under Advanced.
    expect(boxes.map((tag) => [tag.attrs["data-setting"], tag.attrs.checked !== undefined])).toEqual([
      ["agentsReadDotfiles", true],
      ["terminalsReadBashrc", true],
    ]);
    expect(rowOf(section, "containers")).not.toContain('data-setting="terminalsReadBashrc"');
    expect(section).toContain("Applies at each Workspace&#39;s next Container start");
    expect(section).toContain("Applies at each CLI agent&#39;s next start");
    const group = tags.find(
      (tag) => tag.attrs.role === "group" && tag.attrs["aria-labelledby"] === "environment-advanced-dotfiles-title",
    );
    expect(group?.attrs).toMatchObject({
      "aria-labelledby": "environment-advanced-dotfiles-title",
      "aria-describedby": "environment-advanced-dotfiles-desc",
    });
  });

  it("draws the agents' settings in an Agents row of their own, the Turn limit first, outside the Containers row (SPI-1315)", () => {
    const section = sectionOf(renderPage(fixturePage()));
    const start = section.indexOf('<h3 id="environment-agents-title">Agents</h3>');
    expect(start).toBeGreaterThan(-1);
    const settings = inputsOf(rowOf(section, "agents"));
    expect(settings).toEqual(["turnLimitMinutes", "ownerAnswerMinutes"]);
    const containers = rowOf(section, "containers");
    for (const key of settings) expect(containers).not.toContain(`data-setting="${key}"`);
    const group = tagsOf(section).find(
      (tag) => tag.attrs.role === "group" && tag.attrs["aria-labelledby"] === "environment-advanced-agents-title",
    );
    expect(group?.attrs["aria-describedby"]).toBe("environment-advanced-agents-desc");
  });

  it("draws the remaining rows in order, each with only its settings, and no row for what became a constant (SPI-1387)", () => {
    const section = sectionOf(renderPage(fixturePage()));
    const order = [
      "agents",
      "mcp-calls",
      "mcp-servers",
      "text-generation",
      "lifecycle",
      "commands",
      "previews",
      "skills",
      "history",
      "dotfiles",
    ].map((id) => rowAt(section, id));
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    const settingsOf = (id: string) => inputsOf(rowOf(section, id));
    expect(settingsOf("mcp-calls")).toEqual(["mcpCallSeconds"]);
    expect(settingsOf("mcp-servers")).toEqual(["mcpConnectSeconds", "mcpListSeconds"]);
    expect(settingsOf("text-generation")).toEqual(["textGenerationSeconds"]);
    expect(settingsOf("lifecycle")).toEqual(["idleAfterSeconds", "prWatchWakeMinutes"]);
    expect(settingsOf("commands")).toEqual(["commandMinutes", "containerConnectSeconds"]);
    expect(settingsOf("previews")).toEqual(["previewPorts"]);
    expect(settingsOf("skills")).toEqual(["repoSkillsListed"]);
    expect(settingsOf("history")).toEqual(["usageRetentionDays", "piSessionRetentionDays"]);
    for (const gone of ["retries", "terminals", "access", "trace", "outside-requests"])
      expect(rowAt(section, gone)).toBe(-1);
    // No field of a setting that became a constant, anywhere on the page.
    const page = renderPage(fixturePage());
    for (const key of ["terminalsPerWorkspace", "cliRetries", "mcpResultKiB", "sweepPurges", "builderSize", "traceKiB"])
      expect(page).not.toContain(`data-setting="${key}"`);
  });

  it("draws the MCP calls' and servers' time limits once each, with their bounds (SPI-1359, SPI-1363)", () => {
    const page = renderPage(fixturePage());
    const section = sectionOf(page);
    const inputs = (id: string) =>
      tagsOf(rowOf(section, id))
        .filter((tag) => tag.name === "input" && tag.attrs["data-setting"] !== undefined)
        .map((tag) => tag.attrs);
    // SPI-1386: the call time limit is off by default, an empty field.
    expect(inputs("mcp-calls")).toMatchObject([
      { type: "number", min: "0", max: "604800", value: "", placeholder: "off" },
    ]);
    expect(inputs("mcp-servers")).toMatchObject([
      { type: "number", min: "1", max: "604800", value: "30" },
      { type: "number", min: "1", max: "604800", value: "120" },
    ]);
    for (const key of ["mcpCallSeconds", "mcpConnectSeconds", "mcpListSeconds"])
      expect(page.split(`data-setting="${key}"`)).toHaveLength(2);
    const group = tagsOf(section).find(
      (tag) => tag.attrs.role === "group" && tag.attrs["aria-labelledby"] === "environment-advanced-mcp-calls-title",
    );
    expect(group?.attrs["aria-describedby"]).toBe("environment-advanced-mcp-calls-desc");
  });

  it("draws how long history is kept in a History row after the Agents row, outside the Containers row and the Workspaces section (SPI-1323)", () => {
    const page = renderPage(fixturePage());
    const section = sectionOf(page);
    const agents = rowAt(section, "agents");
    const start = rowAt(section, "history");
    expect(start).toBeGreaterThan(agents);
    expect(agents).toBeGreaterThan(-1);
    const row = rowOf(section, "history");
    const inputs = tagsOf(row).filter((tag) => tag.name === "input" && tag.attrs["data-setting"] !== undefined);
    expect(inputs.map((tag) => tag.attrs)).toMatchObject([
      // Each its own off word (SPI-1386): "off" would read as not kept.
      { type: "number", min: "0", max: "3650", value: "", placeholder: "for good" },
      { type: "number", min: "0", max: "3650", value: "", placeholder: "each agent&#39;s own" },
    ]);
    // Once on the page: never in the Containers row, nor in the Workspaces section beside the Grace.
    for (const key of ["usageRetentionDays", "piSessionRetentionDays"])
      expect(page.split(`data-setting="${key}"`)).toHaveLength(2);
    const group = tagsOf(section).find(
      (tag) => tag.attrs.role === "group" && tag.attrs["aria-labelledby"] === "environment-advanced-history-title",
    );
    expect(group?.attrs["aria-describedby"]).toBe("environment-advanced-history-desc");
  });

  it("draws the preview ports as text, the stored list comma-separated (SPI-1364)", () => {
    const section = sectionOf(renderPage(fixturePage()));
    const ports = tagsOf(section).find((tag) => tag.attrs["data-setting"] === "previewPorts");
    expect(ports?.attrs).toMatchObject({
      type: "text",
      "data-kind": "ports",
      value: "3000, 3001, 4173, 4321, 5173, 5174, 8000, 8787",
    });
  });

  it("draws the Answer wait after the Turn limit in the Agents row, default 10, and the Open changes text names it (SPI-1316)", () => {
    const section = sectionOf(renderPage(fixturePage()));
    const agents = section.slice(section.indexOf('<h3 id="environment-agents-title">Agents</h3>'));
    expect(agents).toContain("Answer wait (minutes)");
    const input = tagsOf(agents).find((tag) => tag.attrs["data-setting"] === "ownerAnswerMinutes");
    expect(input?.attrs).toMatchObject({ type: "number", min: "1", value: "10" });
    const empty = (minutes: number) =>
      renderPage({
        ...fixturePage(),
        environment: { ...resolveEnvironment(EMPTY_ENVIRONMENT), ownerAnswerMinutes: minutes },
        openChanges: [],
      });
    expect(empty(10)).toContain("waits here, and on its card, for 10 minutes.");
    expect(empty(30)).toContain("waits here, and on its card, for 30 minutes.");
  });

  it("draws the clone and checkpoint time limits last in the Containers row, which says what they bound (SPI-1324)", () => {
    const section = sectionOf(renderPage(fixturePage()));
    const containers = rowOf(section, "containers");
    expect(containers).toContain("and how long a clone or a checkpoint may run.");
    const settings = tagsOf(containers)
      .map((tag) => tag.attrs["data-setting"])
      .filter((key) => key !== undefined);
    expect(settings.slice(-2)).toEqual(["cloneMinutes", "checkpointMinutes"]);
    const input = (key: string) => tagsOf(containers).find((tag) => tag.attrs["data-setting"] === key)?.attrs;
    // Off by default (SPI-1386): empty, "off" its placeholder, and not required.
    expect(input("cloneMinutes")).toMatchObject({
      type: "number",
      min: "0",
      max: "10080",
      value: "",
      placeholder: "off",
    });
    expect(input("checkpointMinutes")).toMatchObject({
      type: "number",
      min: "0",
      max: "10080",
      value: "",
      placeholder: "off",
    });
    expect(input("cloneMinutes")?.required).toBeUndefined();
  });

  it("draws the Terminals' holds in the Containers row under Advanced, after the idle time and the budget (SPI-1317)", () => {
    const section = sectionOf(renderPage(fixturePage()));
    const containers = rowOf(section, "containers");
    expect(containers).toContain("how long open Terminals keep it running");
    const settings = tagsOf(containers)
      .map((tag) => tag.attrs["data-setting"])
      .filter((key) => key !== undefined);
    // The idle time and the budget on the page; under Advanced the holds first (ADR-0049 §6).
    const advanced = settings.slice(settings.indexOf("containerBudget") + 1);
    expect(
      settings.slice(settings.indexOf("containerIdleMinutes"), settings.indexOf("containerIdleMinutes") + 2),
    ).toEqual(["containerIdleMinutes", "containerBudget"]);
    expect(advanced.slice(0, 2)).toEqual(["terminalBusyHoldMinutes", "terminalPromptHoldMinutes"]);
    const input = (key: string) => tagsOf(containers).find((tag) => tag.attrs["data-setting"] === key)?.attrs;
    expect(input("terminalBusyHoldMinutes")).toMatchObject({ type: "number", min: "1", value: "30" });
    expect(input("terminalPromptHoldMinutes")).toMatchObject({ type: "number", min: "1", value: "10" });
  });

  it("draws a toggle the Owner turned off unchecked", () => {
    const section = sectionOf(
      renderPage({
        ...fixturePage(),
        environment: { ...resolveEnvironment(EMPTY_ENVIRONMENT), agentsReadDotfiles: false },
      }),
    );
    const box = tagsOf(section).find((tag) => tag.attrs["data-setting"] === "agentsReadDotfiles");
    expect(box?.attrs.checked).toBeUndefined();
  });
});

// The Workspaces section (ADR-0044 §1, §4 and its Consequences): the Grace as one control, every Workspace with
// a project's worktrees under it, the lazy Files column, and the Owner's three acts.
describe("the Workspaces section", () => {
  const sectionOf = (html: string) =>
    html.slice(
      html.indexOf('<section id="workspaces"'),
      html.indexOf("</section>", html.indexOf('<section id="workspaces"')),
    );
  const html = renderPage(fixturePage());
  const section = sectionOf(html);
  const tags = tagsOf(section);

  it("shows the Grace as one radio pair, saved through the Environment settings, and keeps it out of the Environment section (ADR-0044 §1)", () => {
    const radios = tags.filter((tag) => tag.name === "input" && tag.attrs.type === "radio");
    expect(radios.map((tag) => [tag.attrs.value, tag.attrs.checked !== undefined])).toEqual([
      ["days", true],
      ["never", false],
    ]);
    expect(tags.find((tag) => tag.attrs["data-grace-days"] !== undefined)?.attrs).toMatchObject({
      type: "number",
      min: "1",
      max: "3650",
      step: "1",
      value: "7",
    });
    expect(
      textOf(
        section,
        tags,
        tags.findIndex((tag) => tag.name === "label" && tag.attrs.for === "grace-days"),
      ),
    ).toBe("Purge after");
    expect(
      textOf(
        section,
        tags,
        tags.findIndex((tag) => tag.name === "label" && tag.attrs.for === "grace-never"),
      ),
    ).toBe("Never purge");
    expect(tags.some((tag) => tag.name === "form" && tag.attrs["data-grace"] !== undefined)).toBe(true);
    const environment = html.slice(
      html.indexOf('<section id="environment"'),
      html.indexOf("</section>", html.indexOf('<section id="environment"')),
    );
    expect(environment).not.toContain('data-setting="sweepPurges"');
    expect(environment).not.toContain('data-setting="graceDays"');
    expect(section).not.toContain("T3FLARE_SWEEP_GRACE_MS");
    const never = sectionOf(
      renderPage(fixturePage({ workspaces: { ...FIXTURE_WORKSPACES, purging: false, graceDays: 0 } })),
    );
    expect(
      tagsOf(never)
        .filter((tag) => tag.attrs.type === "radio")
        .map((tag) => tag.attrs.checked !== undefined),
    ).toEqual([false, true]);
    // A Grace of 0 is never (SPI-1387): the days offer the default should the Owner choose to purge again.
    expect(never).toContain(
      'id="grace-days-n" data-grace-days aria-label="Grace in days" required min="1" max="3650" step="1" value="7"',
    );
    expect(never).toContain(
      "Never purge: the Sweep marks what nothing references and purges nothing. Purge after offers 7 days, the default.",
    );
  });

  it("says when a Stage's T3FLARE_SWEEP_GRACE_MS overrides the days (ADR-0043 §3)", () => {
    const overridden = sectionOf(
      renderPage(fixturePage({ workspaces: { ...FIXTURE_WORKSPACES, overridden: true, graceMs: 180_000 } })),
    );
    expect(overridden).toContain("This Stage overrides the Grace");
    expect(overridden).toContain("<code>T3FLARE_SWEEP_GRACE_MS</code> sets it to 3 minutes");
  });

  it("lists every Workspace, a project's worktrees under it, with status, references, purge date and a Files cell loaded later (ADR-0044 §1)", () => {
    const rows = tags.filter((tag) => tag.name === "tr" && tag.attrs["data-workspace"] !== undefined);
    expect(rows.map((tag) => [tag.attrs["data-workspace"], tag.attrs.class ?? ""])).toEqual([
      ["acme", ""],
      [".wt/acme/feat-a", "wt"],
      [".wt/acme/feat-b", "wt"],
      ["live", ""],
      [".wt/old/kept", ""],
    ]);
    expect(
      tags
        .filter((tag) => tag.attrs["data-workspace-usage"] !== undefined)
        .map((tag) => tag.attrs["data-workspace-usage"]),
    ).toEqual(["acme", ".wt/acme/feat-a", ".wt/acme/feat-b", "live", ".wt/old/kept"]);
    expect(section).toContain('<th scope="col" class="files">Files</th>');
    // A path or a branch wraps only after a slash, never mid-name.
    expect(section).toContain("<code>.wt/<wbr>acme/<wbr>feat-b</code>");
    expect(section).toContain("<strong>t3/<wbr>feat-b</strong>");
    expect(section).toContain('<span class="pill pill-ok">in use</span>');
    expect(section).toContain('<span class="pill pill-warn">unreferenced</span>');
    expect(section).toContain('<span class="pill pill-warn">tombstone</span>');
    expect(section).toContain('<span class="pill">tombstone (kept)</span>');
    expect(section).toContain("project “Live app”; thread “Fix the bug”; 2 open terminals");
    expect(section).toContain("uncommitted work (--force)");
    expect(section).toContain(
      `<time datetime="${new Date(FIXTURE_NOW + 5 * 24 * 60 * 60_000).toISOString()}" data-local>`,
    );
    expect(section).toContain("never: kept");
    // In use, Referenced by names why; the Sweep's reason (the same references by id) is not repeated beneath.
    expect(section).toContain('<td data-label="Purged"><div>never while referenced</div></td>');
    expect(section).not.toContain("project p-live");
    expect(section).toContain("Purging since");
  });

  it('offers Purge now beside "purges its files for good", Restore for a Tombstone, and a hidden Stop for a ready Workspace; no Purge now for one in use', () => {
    const purges = tags.filter((tag) => tag.attrs["data-workspace-purge"] !== undefined);
    expect(purges.map((tag) => JSON.parse(tag.attrs["data-workspace-purge"]!.replaceAll("&quot;", '"')))).toEqual([
      {
        id: "acme",
        name: "acme",
        title: "Acme",
        goes: [
          { id: ".wt/acme/feat-a", status: "unreferenced" },
          { id: ".wt/acme/feat-b", status: "tombstone" },
          { id: "acme", status: "unreferenced" },
        ],
        sessions: 3,
      },
      {
        id: ".wt/acme/feat-a",
        name: "feat-a",
        title: "feat-a",
        goes: [{ id: ".wt/acme/feat-a", status: "unreferenced" }],
        sessions: 1,
      },
      {
        id: ".wt/acme/feat-b",
        name: "feat-b",
        title: "t3/feat-b",
        goes: [{ id: ".wt/acme/feat-b", status: "tombstone" }],
        sessions: 0,
      },
      {
        id: ".wt/old/kept",
        name: "kept",
        title: "kept",
        goes: [{ id: ".wt/old/kept", status: "tombstone (kept)" }],
        sessions: 0,
      },
    ]);
    // A kept Tombstone in the set is called out: work a removal could not check (the script shows it).
    const kept = tags.find((tag) => tag.attrs["data-purge-kept"] !== undefined);
    expect(kept?.attrs.hidden).toBe("");
    expect(textOf(section, tags, tags.indexOf(kept!))).toContain("work a removal could not check");
    for (const index of purges.map((tag) => tags.indexOf(tag))) {
      expect(textOf(section, tags, index)).toBe("Purge now");
      expect(markupAfter(section, tags[index]!)).toMatch(
        /^<\/button><span class="hint">purges its files for good<\/span>/,
      );
    }
    expect(
      tags
        .filter((tag) => tag.attrs["data-workspace-restore"] !== undefined)
        .map((tag) => tag.attrs["data-workspace-restore"]),
    ).toEqual([".wt/acme/feat-b", ".wt/old/kept"]);
    const stops = tags.filter((tag) => tag.attrs["data-workspace-stop"] !== undefined);
    expect(stops.map((tag) => tag.attrs["data-workspace-stop"])).toEqual(["acme", ".wt/acme/feat-a", "live"]);
    // A ready Workspace's Container may not run: Stop stays hidden until the Files column's read says it does.
    expect(stops.every((tag) => tag.attrs.hidden === "")).toBe(true);
    // The typed-name dialog: its field labelled, its Purge disabled until the name matches (the script).
    expect(tags.find((tag) => tag.name === "dialog")?.attrs["data-purge-dialog"]).toBe("");
    expect(tags.find((tag) => tag.attrs["data-purge-go"] !== undefined)?.attrs.disabled).toBe("");
    expect(tags.some((tag) => tag.name === "label" && tag.attrs.for === "purge-confirm")).toBe(true);
    expect(tags.some((tag) => tag.attrs["data-sweep-preview"] !== undefined)).toBe(true);
    // GLOSSARY: a Purge purges; delete and remove are t3's own acts.
    expect(section).toContain("This purges its files for good");
    expect(section).toContain("Purge now purges a Workspace nothing references at once");
    expect(section).not.toMatch(/deletes its files|removes a Workspace/);
    expect(tags.some((tag) => tag.attrs["data-sweep-run"] !== undefined)).toBe(true);
  });

  it("draws its empty state, and a failed read as its error, never a table that could mislead", () => {
    expect(sectionOf(renderPage(fixturePage({ workspaces: { ...FIXTURE_WORKSPACES, rows: [] } })))).toContain(
      "No Workspaces",
    );
    const failed = sectionOf(renderPage(fixturePage({ workspaces: { error: "no such table: projection_projects" } })));
    expect(failed).toContain("The Workspaces could not be read");
    expect(failed).toContain("no such table: projection_projects");
    expect(failed).not.toContain("data-workspace-purge");
    const { workspaces: _workspaces, ...withoutWorkspaces } = fixturePage();
    expect(renderPage(withoutWorkspaces)).not.toContain('id="workspaces"');
  });

  it("escapes hostile strings in every Workspace field", () => {
    const hostile = `"><img src=x onerror=alert(1)>'&<script>`;
    const [acme] = FIXTURE_WORKSPACES.rows;
    const page = renderPage(
      fixturePage({
        workspaces: {
          ...FIXTURE_WORKSPACES,
          rows: [
            {
              ...acme!,
              id: hostile,
              title: hostile,
              repo: hostile,
              branch: hostile,
              confirmName: hostile,
              references: [hostile],
              lastError: hostile,
              planned: { action: "skip", why: hostile },
              worktrees: [],
            },
          ],
        },
      }),
    );
    expect(page).not.toContain("<img");
    expect(page.match(/<script/g)).toHaveLength(1);
    const parsed = tagsOf(page);
    expect(balance(parsed)).toBe("balanced");
    expect(parsed.some((tag) => Object.keys(tag.attrs).some((name) => /^on/i.test(name)))).toBe(false);
  });

  it("its script posts the typed name, says what Restore does (ADR-0044's Consequences), previews the dry Sweep, and writes answers as text", () => {
    expect(SCRIPT.endsWith(WORKSPACES_SCRIPT)).toBe(true);
    // The page's one script parses whole: a name declared twice across its parts would stop all of it.
    expect(() => new Script(SCRIPT)).not.toThrow();
    expect(WORKSPACES_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(WORKSPACES_SCRIPT).toContain(
      'post("/_t3flare/settings/api/workspaces/purge", { id: current.id, confirm: typed.value }, go)',
    );
    expect(WORKSPACES_SCRIPT).toContain("its Grace starts over now, unless a thread in t3 takes the worktree again");
    expect(WORKSPACES_SCRIPT).toContain('getJson("/_t3flare/settings/api/workspaces/sweep")');
    expect(WORKSPACES_SCRIPT).toContain('getJson("/_t3flare/settings/api/workspaces/usage?id=" + encodeURIComponent(');
    expect(WORKSPACES_SCRIPT).toContain('post("/_t3flare/settings/api/environment", { settings }, save)');
    // Stop shows once the read says the Container runs, or could not say.
    expect(WORKSPACES_SCRIPT).toContain("if (stop) stop.hidden = !usage.containerRunning;");
    // What a running Container started from (SPI-1333): the Base snapshot or the Workspace image.
    expect(WORKSPACES_SCRIPT).toContain("cell.textContent = sizeOf(usage.bytes) + runningText(usage);");
    const runningText = new Script(
      `${WORKSPACES_SCRIPT.match(/const runningText = [^\n]*/)![0]}; runningText`,
    ).runInNewContext() as (usage: object) => string;
    expect(runningText({ containerRunning: true, startedFrom: "base" })).toBe(
      ", Container running from the Base snapshot",
    );
    expect(runningText({ containerRunning: true, startedFrom: "image" })).toBe(
      ", Container running from the Workspace image",
    );
    expect(runningText({ containerRunning: true })).toBe(", Container running");
    expect(runningText({ containerRunning: false })).toBe("");
    expect(WORKSPACES_SCRIPT).toMatch(/cell\.textContent = "unknown";\s*if \(stop\) stop\.hidden = false;/);
  });
});

/** The markup right after `tag` closes its element's text (for what sits beside a button). */
const markupAfter = (html: string, tag: Tag): string => {
  const rest = markup(html).slice(tag.index);
  return rest.slice(rest.indexOf("</button>"));
};

// Progressive disclosure (ADR-0049 §6, SPI-1385): each section shows its visible settings, its contextual ones while their
// condition holds, and its Advanced ones collapsed under "Advanced · n settings".
describe("the page's disclosure", () => {
  /** `html` without its collapsed Advanced blocks: what the Owner sees before opening one. */
  const outsideAdvanced = (html: string) =>
    html
      .replaceAll(/<details class="advanced"[\s\S]*?<\/details>/g, "")
      .replaceAll(/<details class="tools" data-server-limits[\s\S]*?<\/details>/g, "");
  /** The settings a page shows at once: fields outside Advanced, not disabled (a contextual one not in use is). */
  const shownSettings = (html: string) =>
    tagsOf(outsideAdvanced(html))
      .filter((tag) => tag.attrs["data-setting"] !== undefined && tag.attrs.disabled === undefined)
      .map((tag) => tag.attrs["data-setting"]);
  const fresh = (overrides: Partial<Parameters<typeof fixturePage>[0]> = {}) =>
    renderPage(fixturePage({ resolved: resolveHarness(EMPTY_HARNESS), ...overrides }));

  // The Workspaces section draws the Grace and its purge as one control of its own (ADR-0044 §1), not a field.
  it("shows a fresh Environment's 13 visible settings until a feature is turned on or Advanced is opened", () => {
    const html = fresh();
    const sections = ["environment", "workspaces", "extensions", "tools"].map((id) => section(html, id)).join("");
    expect(shownSettings(sections).toSorted((x, y) => x!.localeCompare(y!))).toEqual(
      [
        "containerSize",
        "containerIdleMinutes",
        "containerBudget",
        "turnLimitMinutes",
        "idleAfterSeconds",
        "agentsReadDotfiles",
        "variables",
        "globalMiseConfig",
        "containerSetup",
        "imageSetup",
        "outputKiB",
        "rolloverOnCompaction",
      ].toSorted((x, y) => x.localeCompare(y)),
    );
  });

  it("collapses each section's Advanced settings under one Advanced that counts them", () => {
    const html = fresh();
    const environment = section(html, "environment");
    const summary = (scope: string) => /<summary>[\s\S]*?Advanced <span>· (\d+) settings?<\/span>/.exec(scope)?.[1];
    const advancedIn = (scope: string) =>
      tagsOf(/<details class="advanced"[\s\S]*?<\/details>/.exec(scope)?.[0] ?? "").filter(
        (tag) => tag.attrs["data-setting"] !== undefined,
      ).length;
    expect(Number(summary(environment))).toBe(advancedIn(environment));
    expect(advancedIn(environment)).toBeGreaterThan(0);
    expect(environment).toContain('data-setting="cloneMinutes"');
    expect(outsideAdvanced(environment)).not.toContain('data-setting="cloneMinutes"');
    // An extension's row: its own Advanced (the Guardian's review time limit) while it is on, named for it; off, its
    // settings follow its switch, Advanced ones too.
    const guardianOf = (page: string) =>
      page.slice(
        page.indexOf('data-extension="guardian"'),
        page.indexOf("</form>", page.indexOf('data-extension="guardian"')),
      );
    expect(guardianOf(html)).not.toContain("data-setting=");
    const on = applyChange(EMPTY_HARNESS, { extension: "guardian", enabled: true });
    if (!on.ok) throw new Error(on.error);
    const guardian = guardianOf(renderPage(fixturePage({ resolved: resolveHarness(on.harness) })));
    expect(summary(guardian)).toBe(String(advancedIn(guardian)));
    expect(guardian).toContain('data-setting="reviewTimeoutSeconds"');
    expect(guardian).toContain('<span class="sr"> of Guardian</span>');
    // A row whose settings are all Advanced keeps its Save under Advanced: nothing to save while it is collapsed.
    const codemode = html.slice(
      html.indexOf('data-extension="codemode"'),
      html.indexOf("</form>", html.indexOf('data-extension="codemode"')),
    );
    expect(codemode.indexOf("data-save")).toBeGreaterThan(codemode.indexOf('<div class="advanced-body">'));
  });

  it("shows the Guardian's model and policy only while the Guardian is on", () => {
    const guardianOf = (html: string) => {
      const start = html.indexOf('data-extension="guardian"');
      return outsideAdvanced(html.slice(start, html.indexOf("</form>", start)));
    };
    expect(shownSettings(guardianOf(fresh()))).toEqual([]);
    const on = applyChange(EMPTY_HARNESS, { extension: "guardian", enabled: true });
    if (!on.ok) throw new Error(on.error);
    expect(shownSettings(guardianOf(renderPage(fixturePage({ resolved: resolveHarness(on.harness) }))))).toEqual([
      "model",
      "thinkingLevel",
      "tools",
      "commands",
      "policy",
    ]);
  });

  it("shows web_search's model only while web_search is offered", () => {
    expect(shownSettings(section(fresh(), "tools"))).not.toContain("searchModel");
    const offered = applyToolsChange(EMPTY_HARNESS, { tools: { web_search: "deferred" } });
    if (!offered.ok) throw new Error(offered.error);
    const html = renderPage(fixturePage({ resolved: resolveHarness(offered.harness) }));
    expect(shownSettings(section(html, "tools"))).toContain("searchModel");
  });

  it("draws a contextual Environment setting with its condition, hidden and disabled while it does not hold", () => {
    const fieldOf = (html: string, key: string) => {
      const input = html.indexOf(`data-setting="${key}"`);
      const start = html.lastIndexOf('class="field"', input);
      return tagsOf(html.slice(html.lastIndexOf("<", start), input + 1));
    };
    const empty = section(fresh(), "environment");
    const [wrap] = fieldOf(empty, "containerSetupMinutes");
    expect(wrap?.attrs).toMatchObject({ "data-shown-when": "containerSetup", "data-shown-filled": "" });
    expect(wrap?.attrs.hidden).toBeDefined();
    const [custom] = fieldOf(empty, "customVcpu");
    expect(custom?.attrs).toMatchObject({
      "data-shown-when": "containerSize",
      "data-shown-equals": "custom",
    });
    const set = section(
      fresh({
        environment: {
          ...resolveEnvironment(EMPTY_ENVIRONMENT),
          containerSetup: "apt-get install -y jq\n",
          containerSize: "custom",
        },
      }),
      "environment",
    );
    expect(fieldOf(set, "containerSetupMinutes")[0]?.attrs.hidden).toBeUndefined();
    expect(fieldOf(set, "customVcpu")[0]?.attrs.hidden).toBeUndefined();
    expect(shownSettings(set)).toEqual(
      expect.arrayContaining([
        "containerSetupMinutes",
        "containerSetupFailure",
        "customVcpu",
        "customMemoryMib",
        "customDiskMb",
      ]),
    );
  });

  it("its script shows a contextual setting as the input it follows changes, and disables it while hidden", () => {
    const start = SCRIPT.indexOf("const showContextual = (form) => {");
    expect(start).toBeGreaterThan(-1);
    const source = SCRIPT.slice(
      start,
      SCRIPT.indexOf('for (const form of document.querySelectorAll("form[data-environment]"))'),
    );
    const values: Record<string, string> = { containerSetup: "", containerSize: "cpu-1" };
    const field = (dataset: Record<string, string>, filled: boolean) => {
      const input = { disabled: true };
      return { input, wrap: { dataset, hidden: true, hasAttribute: () => filled, querySelectorAll: () => [input] } };
    };
    const setup = field({ shownWhen: "containerSetup" }, true);
    const custom = field({ shownWhen: "containerSize", shownEquals: "custom" }, false);
    const form = {
      querySelector: (selector: string) => ({ value: values[/data-setting="(\w+)"/.exec(selector)![1]!] }),
      querySelectorAll: () => [setup.wrap, custom.wrap],
    };
    const context: { form: typeof form; showContextual?: (form: unknown) => void } = { form };
    new Script(`${source}; this.showContextual = showContextual;`).runInNewContext(context);
    context.showContextual!(form);
    expect([setup.wrap.hidden, setup.input.disabled, custom.wrap.hidden]).toEqual([true, true, true]);
    values.containerSetup = "apt-get install -y jq";
    values.containerSize = "custom";
    context.showContextual!(form);
    expect([setup.wrap.hidden, setup.input.disabled, custom.wrap.hidden, custom.input.disabled]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  // ADR-0049 §4: a limit's message names its place by these headings, so a renamed heading must fail here.
  it("names each place a limit points to by a heading the page renders", () => {
    const settingsCard = {
      ...FIXTURE_MCP[0]!,
      name: "settings",
      setting: { kind: "settings", enabled: true, exposure: "deferred" },
    };
    const on = applyChange(EMPTY_HARNESS, { extension: "guardian", enabled: true });
    if (!on.ok) throw new Error(on.error);
    const html = renderPage(fixturePage({ resolved: resolveHarness(on.harness), mcp: [settingsCard] }));
    const headingOf = (id: string) =>
      /<h2 id="[^"]+-title">(?:<svg[\s\S]*?<\/svg>)?([^<]+)<\/h2>/.exec(section(html, id))?.[1];
    const ids: Record<string, string> = {
      environment: "environment",
      workspaces: "workspaces",
      extensions: "extensions",
      tools: "tools",
      mcp: "mcp",
    };
    for (const [key, id] of Object.entries(ids))
      expect(headingOf(id), key).toBe(SETTINGS_PAGE_PLACES[key as keyof typeof SETTINGS_PAGE_PLACES]);
    expect(section(html, "mcp")).toContain(`<span class="tag">${SETTINGS_PAGE_PLACES.settingsServer}</span>`);
    // Each kind of place, from the setting it names: its section, then its row, card or extension, as rendered.
    const parts = (ref: Parameters<typeof settingPlace>[0]) => settingPlace(ref).split(" › ");
    const [environment, , cloneTitle] = parts({ environment: "cloneMinutes" });
    expect(section(html, "environment")).toContain(`<h2 id="environment-title">`);
    expect(environment).toBe(SETTINGS_PAGE_PLACES.environment);
    expect(section(html, "environment")).toContain(`>${escapeHtml(cloneTitle!)}</label>`);
    const [, row] = parts({ environment: "containerSetupMinutes" });
    expect(section(html, "environment")).toContain(`<h3>${row}</h3>`);
    const [extensions, guardian, advanced] = parts({ extension: "guardian", key: "reviewTimeoutSeconds" });
    expect(extensions).toBe(SETTINGS_PAGE_PLACES.extensions);
    expect(section(html, "extensions")).toContain(`>${guardian}</h3>`);
    expect(section(html, "extensions")).toContain(`${advanced} <span>·`);
    const [tools, web] = parts({ extension: "web", key: "searchResults" });
    expect(tools).toBe(SETTINGS_PAGE_PLACES.tools);
    expect(section(html, "tools")).toContain(`>${web}</h3>`);
  });

  it("hides a tools extension's Advanced settings while every one of its tools is hidden", () => {
    const rowOf = (html: string) => {
      const start = html.indexOf('data-extension="web"');
      return html.slice(start, html.indexOf("</form>", start));
    };
    expect(rowOf(fresh())).toContain('data-setting="searchResults"');
    const hidden = applyToolsChange(EMPTY_HARNESS, { tools: { web_fetch: "hidden", web_search: "hidden" } });
    if (!hidden.ok) throw new Error(hidden.error);
    const row = rowOf(renderPage(fixturePage({ resolved: resolveHarness(hidden.harness) })));
    expect(row).not.toContain("data-setting=");
    expect(row).not.toContain("data-advanced");
    // A row that still shows a setting says both, once, in a note across the row.
    const off = applyToolsChange(EMPTY_HARNESS, {
      tools: { context_notes: "hidden", context_history: "hidden", context_rollover: "hidden" },
    });
    if (!off.ok) throw new Error(off.error);
    const page = renderPage(fixturePage({ resolved: resolveHarness(off.harness) }));
    const context = page.slice(
      page.indexOf('data-extension="context"'),
      page.indexOf("</form>", page.indexOf('data-extension="context"')),
    );
    expect(context).toContain(
      '<p class="desc off-note">Every tool is hidden, so the extension is off: these settings do nothing, and its Advanced settings stay hidden, until a tool is offered.</p>',
    );
    expect(context).toContain('data-setting="rolloverOnCompaction"');
  });

  it("labels the Settings server's limits as its Advanced", () => {
    const html = renderPage(
      fixturePage({
        mcp: [
          { ...FIXTURE_MCP[0]!, name: "settings", setting: { kind: "settings", enabled: true, exposure: "deferred" } },
        ],
      }),
    );
    expect(html).toContain("Advanced <span>· 10 settings: how often a caller may ask, change and read</span>");
  });
});
