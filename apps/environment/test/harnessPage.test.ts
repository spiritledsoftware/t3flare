// The Settings page's structure (SPI-1086): a snapshot of its markup from the fixture state, and checks over the
// parsed tags (balanced, ids unique, every section in the navigation, every control named), every state it draws, the
// CSP's limits (no inline style or handler, one script), and escaping of hostile strings in every server-supplied field.
// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { Script } from "node:vm";

import {
  applyToolsChange,
  BUILTIN_TOOLS,
  EMPTY_ENVIRONMENT,
  EMPTY_HARNESS,
  resolveEnvironment,
  resolveHarness,
  SETTINGS_SERVER_LIMIT_KEYS,
  SETTINGS_SERVER_LIMITS_NOTE,
} from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { escapeHtml, LIMIT_GROUPS, type McpRow, renderPage, type SkillsView } from "../src/harness/page.ts";
import { SCRIPT } from "../src/harness/pageScript.ts";

const NO_SKILLS: SkillsView = {
  skills: [],
  totals: { count: 0, enabled: 0, disabled: 0, bytes: 0, disabledBytes: 0, maxBytes: 8_388_608, maxSkills: 100 },
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
      "guardian",
      "advisor",
      "skills",
      // SPI-1321: no longer locked, "Always on" with its settings; permissions stays locked.
      "project-context",
    ]);
    expect(tags.find((tag) => tag.attrs["data-setting"] === "inlineBudget")).toMatchObject({
      attrs: { type: "number", min: "500", max: "20000", value: "3000" },
    });
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
      "Every tool is hidden, so the extension is not installed and these settings do nothing until a tool is offered.",
    );
    expect(terminals(resolveHarness(EMPTY_HARNESS))).not.toContain("Every tool is hidden");
    // SPI-1317: the count is the Environment setting's, not a fixed 8.
    expect(terminals(resolveHarness(EMPTY_HARNESS))).not.toContain("At most 8");
    expect(terminals(resolveHarness(EMPTY_HARNESS))).toContain(
      "At most the Environment setting Agents&#39; Terminals per Workspace (8 by default) run at once in a Workspace",
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
      "2 skills (1 enabled, 1 disabled) of 100; 2.0 KiB of 8.00 MiB, 1.0 KiB of it disabled. Disabled skills count toward the limits.",
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
    expect(inputs(html)).toEqual([
      ["strikes", "3", "1", "1000"],
      ["strikeWindowMinutes", "60", "1", "10080"],
      ["strikeLockMinutes", "60", "0", "10080"],
      ["declinedRepeatMinutes", "10", "0", "10080"],
      ["appliedPerHour", "30", "1", "100000"],
      ["askedPerHour", "6", "1", "100000"],
      ["readsPerHour", "240", "1", "100000"],
      ["networkReadsPerHour", "20", "1", "100000"],
      ["openPerThread", "1", "1", "16"],
      ["openPerOwner", "2", "1", "16"],
    ]);
    // The consequence, once; each limit's range and default in its hint.
    expect(html.split(escapeHtml(SETTINGS_SERVER_LIMITS_NOTE)).length).toBe(2);
    expect(html).toContain("1 to 100,000; 240 by default.");
    // Three groups, under legends, covering every limit once.
    expect(tagsOf(html).filter((tag) => tag.name === "legend" && !tag.closing).length).toBe(3);
    expect(LIMIT_GROUPS.flatMap(([, keys]) => keys).sort()).toEqual([...SETTINGS_SERVER_LIMIT_KEYS].sort());
    // A stored value shows; one that no longer fits shows its default.
    expect(inputs(at({ limits: { askedPerHour: 12, strikes: 0 } })).slice(0, 6)).toEqual([
      ["strikes", "3", "1", "1000"],
      ["strikeWindowMinutes", "60", "1", "10080"],
      ["strikeLockMinutes", "60", "0", "10080"],
      ["declinedRepeatMinutes", "10", "0", "10080"],
      ["appliedPerHour", "30", "1", "100000"],
      ["askedPerHour", "12", "1", "100000"],
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

  it("draws both toggles in a row of their own, checked by default, outside the Containers row, each saying when it applies", () => {
    const section = sectionOf(renderPage(fixturePage()));
    const tags = tagsOf(section);
    // The Dotfiles row: from its heading to the next row (other rows hold checkboxes of their own, the Builder's).
    const start = section.indexOf('<h3 id="environment-dotfiles-title">');
    const row = section.slice(start, section.indexOf('<div class="row">', start));
    const boxes = tagsOf(row).filter(
      (tag) => tag.name === "input" && tag.attrs.type === "checkbox" && tag.attrs["data-setting"] !== undefined,
    );
    expect(boxes.map((tag) => [tag.attrs["data-setting"], tag.attrs.checked !== undefined])).toEqual([
      ["terminalsReadBashrc", true],
      ["agentsReadDotfiles", true],
    ]);
    const containers = section.slice(0, section.indexOf('<h3 id="environment-dotfiles-title">Dotfiles</h3>'));
    expect(section).toContain('<h3 id="environment-dotfiles-title">Dotfiles</h3>');
    expect(containers).not.toContain('data-setting="terminalsReadBashrc"');
    expect(section).toContain("Applies at each Workspace&#39;s next Container start");
    expect(section).toContain("Applies at each CLI agent&#39;s next start");
    const group = tags.find(
      (tag) => tag.attrs.role === "group" && tag.attrs["aria-labelledby"] === "environment-dotfiles-title",
    );
    expect(group?.attrs).toMatchObject({
      "aria-labelledby": "environment-dotfiles-title",
      "aria-describedby": "environment-dotfiles-desc",
    });
  });

  it("draws the agents' settings in an Agents row of their own, the Turn limit first, outside the Containers row (SPI-1315)", () => {
    const section = sectionOf(renderPage(fixturePage()));
    const start = section.indexOf('<h3 id="environment-agents-title">Agents</h3>');
    expect(start).toBeGreaterThan(-1);
    const row = section.slice(start, section.indexOf('<div class="row">', start));
    const settings = tagsOf(row)
      .filter((tag) => tag.name === "input" && tag.attrs["data-setting"] !== undefined)
      .map((tag) => tag.attrs["data-setting"]);
    expect(settings).toEqual([
      "turnLimitMinutes",
      "ownerAnswerMinutes",
      "cliProcessesPerWorkspace",
      "cliReclaimSeconds",
    ]);
    const containers = section.slice(0, start);
    for (const key of settings) expect(containers).not.toContain(`data-setting="${key}"`);
    const group = tagsOf(section).find(
      (tag) => tag.attrs.role === "group" && tag.attrs["aria-labelledby"] === "environment-agents-title",
    );
    expect(group?.attrs["aria-describedby"]).toBe("environment-agents-desc");
  });

  it("draws the MCP calls' time limit and result size in an MCP calls row between the Agents and History rows (SPI-1359)", () => {
    const page = renderPage(fixturePage());
    const section = sectionOf(page);
    const agents = section.indexOf('<h3 id="environment-agents-title">Agents</h3>');
    const start = section.indexOf('<h3 id="environment-mcp-calls-title">MCP calls</h3>');
    const history = section.indexOf('<h3 id="environment-history-title">History</h3>');
    expect(agents).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(agents);
    expect(history).toBeGreaterThan(start);
    const row = section.slice(start, section.indexOf('<div class="row">', start));
    const inputs = tagsOf(row).filter((tag) => tag.name === "input" && tag.attrs["data-setting"] !== undefined);
    expect(inputs.map((tag) => tag.attrs["data-setting"])).toEqual(["mcpCallSeconds", "mcpResultKiB"]);
    expect(inputs.map((tag) => tag.attrs)).toMatchObject([
      { type: "number", min: "1", max: "604800", value: "270" },
      { type: "number", min: "1", max: "8192", value: "1024" },
    ]);
    for (const key of ["mcpCallSeconds", "mcpResultKiB"]) expect(page.split(`data-setting="${key}"`)).toHaveLength(2);
    const group = tagsOf(section).find(
      (tag) => tag.attrs.role === "group" && tag.attrs["aria-labelledby"] === "environment-mcp-calls-title",
    );
    expect(group?.attrs["aria-describedby"]).toBe("environment-mcp-calls-desc");
  });

  it("draws how long history is kept in a History row after the Agents row, outside the Containers row and the Workspaces section (SPI-1323)", () => {
    const page = renderPage(fixturePage());
    const section = sectionOf(page);
    const agents = section.indexOf('<h3 id="environment-agents-title">Agents</h3>');
    const start = section.indexOf('<h3 id="environment-history-title">History</h3>');
    expect(start).toBeGreaterThan(agents);
    expect(agents).toBeGreaterThan(-1);
    const row = section.slice(start, section.indexOf('<div class="row">', start));
    const inputs = tagsOf(row).filter((tag) => tag.name === "input" && tag.attrs["data-setting"] !== undefined);
    expect(inputs.map((tag) => tag.attrs["data-setting"])).toEqual(["usageRetentionDays", "piSessionRetentionDays"]);
    expect(inputs.map((tag) => tag.attrs)).toMatchObject([
      { type: "number", min: "1", max: "3650", value: "92" },
      { type: "number", min: "1", max: "3650", value: "60" },
    ]);
    // Once on the page: never in the Containers row, nor in the Workspaces section beside the Grace.
    for (const key of ["usageRetentionDays", "piSessionRetentionDays"])
      expect(page.split(`data-setting="${key}"`)).toHaveLength(2);
    const group = tagsOf(section).find(
      (tag) => tag.attrs.role === "group" && tag.attrs["aria-labelledby"] === "environment-history-title",
    );
    expect(group?.attrs["aria-describedby"]).toBe("environment-history-desc");
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

  it("draws the settings read wait in the Containers row, which says what it bounds (SPI-1314)", () => {
    const section = sectionOf(renderPage(fixturePage()));
    const containers = section.slice(
      section.indexOf("<h3>Containers</h3>"),
      section.indexOf('<h3 id="environment-agents-title">Agents</h3>'),
    );
    expect(containers).toContain("how long a start or a turn waits for the newest settings");
    const input = tagsOf(containers).find((tag) => tag.attrs["data-setting"] === "settingsReadSeconds");
    expect(input?.attrs).toMatchObject({ type: "number", min: "1", value: "5" });
  });

  it("draws the clone and checkpoint time limits last in the Containers row, which says what they bound (SPI-1324)", () => {
    const section = sectionOf(renderPage(fixturePage()));
    const containers = section.slice(
      section.indexOf("<h3>Containers</h3>"),
      section.indexOf('<h3 id="environment-agents-title">Agents</h3>'),
    );
    expect(containers).toContain("and how long a clone or a checkpoint may run.");
    const settings = tagsOf(containers)
      .map((tag) => tag.attrs["data-setting"])
      .filter((key) => key !== undefined);
    expect(settings.slice(-3)).toEqual(["settingsReadSeconds", "cloneMinutes", "checkpointMinutes"]);
    const input = (key: string) => tagsOf(containers).find((tag) => tag.attrs["data-setting"] === key)?.attrs;
    expect(input("cloneMinutes")).toMatchObject({ type: "number", min: "1", max: "10080", value: "15" });
    expect(input("checkpointMinutes")).toMatchObject({ type: "number", min: "1", max: "10080", value: "10" });
  });

  it("draws the Terminals' holds and counts in the Containers row, holds after the idle time, counts after the budget (SPI-1317)", () => {
    const section = sectionOf(renderPage(fixturePage()));
    const containers = section.slice(
      section.indexOf("<h3>Containers</h3>"),
      section.indexOf('<h3 id="environment-agents-title">Agents</h3>'),
    );
    expect(containers).toContain("how long open Terminals keep it running");
    expect(containers).toContain("how many Terminals a Workspace may have");
    const settings = tagsOf(containers)
      .map((tag) => tag.attrs["data-setting"])
      .filter((key) => key !== undefined);
    const after = (key: string) => settings.slice(settings.indexOf(key), settings.indexOf(key) + 3);
    expect(after("containerIdleMinutes")).toEqual([
      "containerIdleMinutes",
      "terminalBusyHoldMinutes",
      "terminalPromptHoldMinutes",
    ]);
    expect(after("containerBudget")).toEqual([
      "containerBudget",
      "terminalsPerWorkspace",
      "agentTerminalsPerWorkspace",
    ]);
    const input = (key: string) => tagsOf(containers).find((tag) => tag.attrs["data-setting"] === key)?.attrs;
    expect(input("terminalBusyHoldMinutes")).toMatchObject({ type: "number", min: "1", value: "30" });
    expect(input("terminalPromptHoldMinutes")).toMatchObject({ type: "number", min: "1", value: "10" });
    expect(input("terminalsPerWorkspace")).toMatchObject({ type: "number", min: "1", max: "1000", value: "8" });
    expect(input("agentTerminalsPerWorkspace")).toMatchObject({ type: "number", min: "1", max: "32", value: "8" });
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
      renderPage(fixturePage({ workspaces: { ...FIXTURE_WORKSPACES, purging: false, graceDays: 30 } })),
    );
    expect(
      tagsOf(never)
        .filter((tag) => tag.attrs.type === "radio")
        .map((tag) => tag.attrs.checked !== undefined),
    ).toEqual([false, true]);
    expect(never).toContain('value="30"');
    expect(never).toContain("Never purge: the Sweep marks what nothing references and purges nothing.");
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
