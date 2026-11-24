// The Settings page's one script (ADR-0026), allowed by its SHA-256 hash in the CSP, so it is a constant. It only turns
// the page's controls into calls to the panel's JSON API (with the CSRF token from the page's meta tag) and shows their
// progress and outcome. It writes server answers with `textContent`, never as HTML. Without it the page still reads.
import { ENDPOINTS_SCRIPT } from "./pageEndpoints.ts";
import { WORKSPACES_SCRIPT } from "./pageWorkspaces.ts";

/** Each entity's name in the audit log; one this page does not know shows as stored. page.ts renders it too. */
export const ENTITY_LABELS: Readonly<Record<string, string>> = {
  harness: "Harness",
  environment: "Environment",
  endpoints: "Model endpoints",
  "owner-clients": "Owner clients",
  workspaces: "Workspaces",
};

/** Where the page asks for a new token (SPI-1366); panel.ts answers it. */
export const TOKEN_PATH = "/_t3flare/settings/api/token";
/** Where the page reads an older page of the audit log (SPI-1366); panel.ts answers it. */
export const AUDIT_API_PATH = "/_t3flare/settings/api/audit";

/** A stored secret Variable's placeholder while its value is kept (an empty box keeps it); page.ts renders it too. */
export const KEPT_PLACEHOLDER = "Set, not shown. Type to replace it";
/** A stored secret Variable's placeholder once renamed or turned plain: its value must be typed again. */
export const RETYPE_PLACEHOLDER = "Type the value again";

/**
 * How often the page reads a running Test base build (SPI-1334). Fixed: how fresh the page's view of a test is, not
 * anything an Owner tunes; the test's own time limits are the Owner's settings.
 */
export const TEST_POLL_MS = 5_000;
/** How long the page waits to read again after a read failed. Fixed: a retry's back-off, not a policy. */
export const TEST_POLL_RETRY_MS = 15_000;
/**
 * Failed reads in a row after which the page stops following a test and says why. Fixed: the bound on a retry loop (an
 * expired Access session fails every read); the Owner follows again with a click.
 */
export const TEST_POLL_FAILURES = 3;
/** An ISO time in a Builder's line (`describeBaseBuild`): page.ts shows it as a time, the script formats it as one. */
export const ISO_TIME_SOURCE = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z`;

/**
 * The Container budget's consequence, stated once under the budget field's description (ADR-0048): page.ts renders it, the script
 * rewrites it as the budget input changes. t3flare reads no account limit, so it names them rather than checking them.
 */
const BUDGET_NOTE = [
  "Each running Container is billed for its size; at this budget, up to ",
  " can run at once. Your Cloudflare account's own Container limits (concurrent memory, vCPU and disk) also apply; t3flare does not check them.",
] as const;
export const budgetNote = (budget: number): string => `${BUDGET_NOTE[0]}${budget}${BUDGET_NOTE[1]}`;

export const SCRIPT =
  `"use strict";
let csrf = document.querySelector('meta[name="t3flare-csrf"]').getAttribute("content");
// The token lasts the Settings page token setting (SPI-1366): a change refused for it asks for a new one, and is sent
// again with it, once.
const freshToken = async () => {
  try {
    const response = await fetch(${JSON.stringify(TOKEN_PATH)}, { credentials: "same-origin" });
    const token = response.ok ? (await response.json()).token : "";
    if (typeof token !== "string" || token === "") return false;
    csrf = token;
    return true;
  } catch {
    return false;
  }
};
const notice = document.getElementById("result");
const noticeText = notice.querySelector(".msg");
const notify = (tone, text) => {
  notice.dataset.tone = tone;
  noticeText.textContent = text;
  notice.hidden = false;
  notice.setAttribute("role", tone === "err" ? "alert" : "status");
};
notice.querySelector("[data-dismiss]").addEventListener("click", () => { notice.hidden = true; });
const busy = (element, on) => {
  if (element === null || element === undefined) return;
  element.setAttribute("aria-busy", on ? "true" : "false");
  element.disabled = on;
};
// A POST's { response } when it is ok, else { error }: the refusal or the failure to reach the panel, as text.
const request = async (path, body) => {
  try {
    const send = () =>
      fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-t3flare-csrf": csrf },
        body: JSON.stringify(body),
        credentials: "same-origin",
      });
    let response = await send();
    if (response.status === 403 && (await response.clone().text()).includes("bad CSRF token") && (await freshToken()))
      response = await send();
    if (response.ok) return { response };
    return { error: "Refused (" + response.status + "): " + (await response.text()).trim() };
  } catch (error) {
    return { error: "Could not reach the panel: " + (error && error.message ? error.message : String(error)) };
  }
};
const post = async (path, body, control) => {
  busy(control, true);
  const answer = await request(path, body);
  if (answer.response !== undefined) return answer.response;
  notify("err", answer.error);
  busy(control, false);
  return undefined;
};
// A reload keeps each Advanced (ADR-0049 §6) open that was open, so a value saved there shows where it was typed.
const OPEN_ADVANCED = "t3flare-open-advanced";
const done = () => {
  try {
    sessionStorage.setItem(OPEN_ADVANCED, JSON.stringify([...document.querySelectorAll("details[data-advanced][open]")].map((details) => details.id)));
  } catch {}
  location.reload();
};
try {
  for (const id of JSON.parse(sessionStorage.getItem(OPEN_ADVANCED) ?? "[]")) {
    const details = document.getElementById(id);
    if (details instanceof HTMLDetailsElement) details.open = true;
  }
  sessionStorage.removeItem(OPEN_ADVANCED);
} catch {}
// A field under a collapsed Advanced (ADR-0049 §6) that a save finds invalid opens it, so the browser can show where.
document.addEventListener("invalid", (event) => {
  const advanced = event.target instanceof Element ? event.target.closest("details[data-advanced]") : null;
  if (advanced !== null) advanced.open = true;
}, true);
// The Base snapshot's Rebuild (SPI-1332): a reload shows the build it started; a refusal is said beside the button,
// which keeps the focus.
for (const button of document.querySelectorAll("button[data-base-rebuild]")) {
  button.addEventListener("click", async () => {
    const result = button.closest("[data-base-build]").querySelector("[data-base-result]");
    result.textContent = "Asking the Builder…";
    busy(button, true);
    const answer = await request("/_t3flare/settings/api/base/rebuild", {});
    if (answer.response !== undefined) return done();
    result.textContent = answer.error;
    busy(button, false);
    button.focus();
  });
}
// The Image setup's Test (SPI-1334): tests the text in the box, unsaved, so no reload (it would lose the text). The
// block follows the test's view from the panel, written with textContent, polling while it runs.
for (const block of document.querySelectorAll("[data-base-test-block]")) {
  const button = block.querySelector("button[data-base-test]");
  const box = document.getElementById("environment-imageSetup");
  const result = block.querySelector("[data-base-test-result]");
  const pill = block.querySelector("[data-test-pill]");
  const status = block.querySelector("[data-test-status]");
  const output = block.querySelector("[data-test-output]");
  const stale = block.querySelector("[data-test-stale]");
  const again = block.querySelector("button[data-test-follow]");
  // A result is the tested text's: once the box holds another text, it says so (the digest the test Builder kept).
  const checkStale = async () => {
    const tested = block.dataset.testSetup;
    const ended = block.dataset.testState === "ready" || block.dataset.testState === "failed";
    if (box === null || tested === undefined || !ended || !(window.crypto && crypto.subtle)) { stale.hidden = true; return; }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(box.value));
    const hexed = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    stale.hidden = hexed === tested;
  };
  const when = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const timed = (line) => line.replace(new RegExp(${JSON.stringify(ISO_TIME_SOURCE)}, "g"), (iso) => when.format(new Date(iso)));
  let polling;
  let failures = 0;
  const show = (view) => {
    // A test that ends while the page follows it is said in the live region, so its outcome is heard too.
    if (block.dataset.testState === "building" && view.state !== "building") {
      result.textContent = view.state === "ready" ? "The test passed." : view.state === "failed" ? "The test failed; its output is below." : "";
    }
    block.dataset.testState = view.state;
    if (view.setup === null) delete block.dataset.testSetup;
    else block.dataset.testSetup = view.setup;
    pill.className = "pill" + (view.pill.tone === "" ? "" : " pill-" + view.pill.tone);
    pill.textContent = view.pill.label;
    status.textContent = timed(view.line);
    output.hidden = view.output === null;
    output.open = view.state === "failed";
    output.querySelector("[data-test-output-summary]").textContent = view.outputSummary;
    const text = output.querySelector("[data-test-output-text]");
    text.textContent = view.output === null ? "" : view.output;
    text.hidden = view.output === null || view.output === "";
    checkStale();
    clearTimeout(polling);
    if (view.state === "building") polling = setTimeout(follow, ${TEST_POLL_MS});
  };
  // A read that fails is tried again, a few times in a row at most: then the page stops, says why, and offers to follow again.
  const follow = async () => {
    let why;
    try {
      const response = await fetch("/_t3flare/settings/api/base/test", { credentials: "same-origin" });
      if (response.ok) {
        failures = 0;
        return show((await response.json()).view);
      }
      why = "the panel answered " + response.status + (response.status === 401 || response.status === 403 ? "; the sign-in may have expired" : "");
    } catch {
      why = "the panel could not be reached";
    }
    failures += 1;
    if (failures < ${TEST_POLL_FAILURES}) {
      polling = setTimeout(follow, ${TEST_POLL_RETRY_MS});
      return;
    }
    result.textContent = "Stopped following the test (" + why + "). It goes on in its Builder; Follow again reads it.";
    again.hidden = false;
  };
  again.addEventListener("click", () => {
    again.hidden = true;
    failures = 0;
    result.textContent = "Following the test again…";
    follow();
  });
  if (block.dataset.testState === "building") polling = setTimeout(follow, ${TEST_POLL_MS});
  if (box !== null) box.addEventListener("input", checkStale);
  checkStale();
  if (button === null || box === null) continue;
  button.addEventListener("click", async () => {
    result.textContent = "Asking the test Builder…";
    busy(button, true);
    const answer = await request("/_t3flare/settings/api/base/test", { imageSetup: box.value });
    busy(button, false);
    if (answer.response === undefined) {
      result.textContent = answer.error;
      button.focus();
      return;
    }
    const view = (await answer.response.json()).view;
    again.hidden = true;
    failures = 0;
    show(view);
    // What the test Builder answered: a test under way, or why none ran (an empty proposal has nothing to build).
    const line = timed(view.line);
    result.textContent = view.state === "building" ? "Testing the Image setup above; this shows its result when it ends." : line.charAt(0).toUpperCase() + line.slice(1) + ".";
    // The button was disabled while it asked: focus goes back to it, not to the page's top.
    button.focus();
  });
}
for (const button of document.querySelectorAll("button[data-mcp]")) {
  button.addEventListener("click", async () => {
    const change = JSON.parse(button.dataset.mcp);
    if (change.op === "remove" && !confirm("Remove " + change.server + " and its sign-in? Agents lose its tools at their next turn.")) return;
    if (await post("/_t3flare/settings/api/mcp", change, button)) done();
  });
}
for (const select of document.querySelectorAll("select[data-mcp-exposure]")) {
  select.addEventListener("change", async () => {
    const server = select.dataset.mcpExposure;
    const change = select.dataset.tool === undefined
      ? { op: "server", server, exposure: select.value }
      : { op: "server", server, toolExposure: { [select.dataset.tool]: select.value === "" ? null : select.value } };
    if (await post("/_t3flare/settings/api/mcp", change, select)) done();
    else select.value = select.querySelector("option[selected]").value;
  });
}
// A tool's Exposure (built-in, or t3's: a tool's, or "" for the card's default), saved at once; "" clears a tool's own.
for (const select of document.querySelectorAll("select[data-tool-exposure]")) {
  select.addEventListener("change", async () => {
    const tool = select.dataset.toolExposure;
    const value = select.value === "" ? null : select.value;
    const change = select.dataset.t3 === undefined ? { tools: { [tool]: value } } : tool === "" ? { t3: { exposure: value } } : { t3: { tools: { [tool]: value } } };
    if (await post("/_t3flare/settings/api/tools", change, select)) done();
    else select.value = select.querySelector("option[selected]").value;
  });
}
for (const button of document.querySelectorAll("button[data-tools-preset]")) {
  button.addEventListener("click", async () => {
    const preset = button.dataset.toolsPreset;
    if (!confirm("Apply the " + preset + " preset? Every tool that is not hidden takes its Exposure, t3's and MCP servers' too; hidden tools, and an MCP server's code-mode-only ones, stay as they are.")) return;
    if (await post("/_t3flare/settings/api/tools", { preset }, button)) done();
  });
}
// The Owner clients' modes (ADR-0035's 2026-11-15 refinement): set here alone, at the client's next request.
for (const select of document.querySelectorAll("select[data-client-mode]")) {
  select.addEventListener("change", async () => {
    const body = { key: select.dataset.clientKey, clientName: select.dataset.clientName, mode: select.value };
    if (await post("/_t3flare/settings/api/mcp/clients", body, select)) done();
    else select.value = select.querySelector("option[selected]").value;
  });
}
for (const button of document.querySelectorAll("button[data-client-remove]")) {
  button.addEventListener("click", async () => {
    if (!confirm("Forget the client " + button.dataset.clientName + "? It is listed again, in browser, at its next request.")) return;
    if (await post("/_t3flare/settings/api/mcp/clients", { key: button.dataset.clientKey, clientName: button.dataset.clientName, remove: true }, button)) done();
  });
}
for (const button of document.querySelectorAll("button[data-mcp-test]")) {
  button.addEventListener("click", async () => {
    const server = button.dataset.mcpTest;
    const out = document.querySelector('[data-test-result="' + CSS.escape(server) + '"]');
    out.dataset.tone = "";
    out.textContent = "Testing…";
    const response = await post("/_t3flare/settings/api/mcp/test", { server }, button);
    busy(button, false);
    if (response === undefined) { out.textContent = ""; return; }
    const answer = await response.json();
    if (answer.status === "ok") {
      out.dataset.tone = "ok";
      out.textContent = "Listed " + answer.tools + (answer.tools === 1 ? " tool" : " tools") + (answer.refused > 0 ? " (" + answer.refused + " refused)" : "") + " in " + answer.ms + " ms. Reload to see them.";
    } else {
      out.dataset.tone = "err";
      out.textContent = "Failed: " + (answer.error || answer.status);
    }
  });
}
for (const button of document.querySelectorAll("button[data-mcp-oauth]")) {
  button.addEventListener("click", async () => {
    const response = await post("/_t3flare/settings/api/mcp/oauth", { server: button.dataset.mcpOauth }, button);
    busy(button, false);
    if (response === undefined) return;
    const answer = await response.json();
    const target = new URL(answer.authorizationUrl);
    if (target.protocol !== "https:") { notify("err", "The sign-in URL is not https; not opened."); return; }
    window.open(target.toString(), "_blank", "noopener,noreferrer");
    notify("ok", "Finish signing in to " + button.dataset.mcpOauth + " in the new tab, then reload this page.");
  });
}
const adding = document.querySelector("form[data-mcp-add]");
if (adding !== null) {
  const kinds = adding.querySelectorAll("[name=auth]");
  const headerFields = adding.querySelector("[data-header-fields]");
  const kind = () => adding.querySelector("[name=auth]:checked").value;
  const showHeader = () => {
    const on = kind() === "header";
    headerFields.hidden = !on;
    for (const input of headerFields.querySelectorAll("input")) input.disabled = !on;
  };
  for (const input of kinds) input.addEventListener("change", showHeader);
  showHeader();
  adding.addEventListener("submit", async (event) => {
    event.preventDefault();
    const field = (name) => adding.querySelector("[name=" + name + "]").value.trim();
    const body = { server: field("server"), url: field("url"), auth: { kind: kind() } };
    if (body.auth.kind === "header") {
      body.auth.header = field("header");
      body.value = adding.querySelector("[name=value]").value;
    }
    const response = await post("/_t3flare/settings/api/mcp/servers", body, adding.querySelector("[type=submit]"));
    adding.querySelector("[name=value]").value = "";
    if (response !== undefined) done();
  });
}
// A Variables list's rows as [{ name, value, secret }]; a row with neither a name nor a value is skipped. A stored
// secret's row (data-variable-stored, its stored name) keeps its stored value while it has that name and Secret on
// (keepsStored): with an empty box it posts valueRedacted (ADR-0046). A stored secret renamed or turned plain needs its value typed again, and a
// name listed twice is refused here, before the save.
const keepsStored = (row) =>
  row.dataset.variableStored !== undefined &&
  row.querySelector("[data-variable-secret]").checked &&
  row.querySelector("[data-variable-name]").value.trim() === row.dataset.variableStored;
const variablesOf = (list) => {
  const variables = [];
  const seen = new Set();
  for (const row of list.querySelectorAll("[data-variable]")) {
    const name = row.querySelector("[data-variable-name]").value.trim();
    const value = row.querySelector("[data-variable-value]").value;
    const secret = row.querySelector("[data-variable-secret]").checked;
    const kept = keepsStored(row) && value === "";
    if (name === "" && value === "" && !kept) continue;
    if (seen.has(name)) throw new Error("The Variable " + JSON.stringify(name) + " is listed twice; keep one.");
    seen.add(name);
    if (!kept && value === "" && (row.dataset.variableStored !== undefined || row.hasAttribute("data-variable-unreadable"))) throw new Error("Type the value of " + JSON.stringify(name) + " again, or remove it.");
    variables.push(kept ? { name, value: "", secret: true, valueRedacted: true } : { name, value, secret });
  }
  return variables;
};
const settingsOf = (form) => {
  const settings = {};
  for (const input of form.querySelectorAll("[data-setting]")) {
    // A disabled field is not in use (a custom size's resources while no size is custom): its stored value stays.
    if (input.disabled) continue;
    const kind = input.dataset.kind;
    settings[input.dataset.setting] = kind === "boolean" ? input.checked : kind === "integer" || kind === "number" ? Number(input.value) : kind === "variables" ? variablesOf(input) : input.value;
  }
  return settings;
};
for (const list of document.querySelectorAll('[data-kind="variables"]')) {
  const rows = list.querySelector("[data-variable-rows]");
  const setByT3flare = new Set((list.dataset.setByT3flare ?? "").split(" "));
  const reserved = (list.dataset.reservedPrefixes ?? "").split(" ").filter((prefix) => prefix !== "");
  const noted = (name) => setByT3flare.has(name) || reserved.some((prefix) => name.startsWith(prefix));
  const changed = () => list.dispatchEvent(new Event("input", { bubbles: true }));
  // A stored secret's box: kept while the row has its stored name and Secret on (the mark comes back with them), else
  // required, since its value is not on the page.
  const sync = (row) => {
    const box = row.querySelector("[data-variable-value]");
    const stored = row.dataset.variableStored !== undefined;
    const keeps = keepsStored(row);
    if (stored) box.placeholder = keeps ? ${JSON.stringify(KEPT_PLACEHOLDER)} : ${JSON.stringify(RETYPE_PLACEHOLDER)};
    box.required = row.hasAttribute("data-variable-unreadable") || (stored && !keeps);
  };
  const wire = (row) => {
    const name = row.querySelector("[data-variable-name]");
    const note = row.querySelector("[data-variable-note]");
    const secret = row.querySelector("[data-variable-secret]");
    row.querySelector("[data-variable-remove]").addEventListener("click", () => { row.remove(); changed(); });
    name.addEventListener("input", () => { note.hidden = !noted(name.value.trim()); sync(row); });
    secret.addEventListener("change", () => {
      row.classList.toggle("is-secret", secret.checked);
      sync(row);
    });
  };
  for (const row of rows.querySelectorAll("[data-variable]")) wire(row);
  list.querySelector("[data-variable-add]").addEventListener("click", () => {
    const row = list.querySelector("[data-variable-template]").content.firstElementChild.cloneNode(true);
    rows.append(row);
    wire(row);
    row.querySelector("[data-variable-name]").focus();
    changed();
  });
}
// A ports field (SPI-1364) is checked where it is typed, as the API checks it, so a bad list is shown at the field.
const portsProblem = (input) => {
  const words = input.value.split(/[\\s,]+/).filter((word) => word !== "");
  if (words.length === 0) return "List at least one port.";
  const reserved = (input.dataset.reserved ?? "").split(" ");
  for (const word of words) {
    if (!/^\\d+$/.test(word) || Number(word) < 1 || Number(word) > 65535) return word + " is not a port from 1 to 65535.";
    if (reserved.includes(String(Number(word)))) return word + " is t3flare's own port; choose another.";
  }
  const count = new Set(words.map(Number)).size;
  const most = Number(input.dataset.maxCount);
  return count > most ? "At most " + most + " ports, not " + count + "." : "";
};
for (const input of document.querySelectorAll('[data-kind="ports"]')) {
  const check = () => input.setCustomValidity(portsProblem(input));
  input.addEventListener("input", check);
  check();
}
const watchUnsaved = (form) => {
  const save = form.querySelector("[data-save]");
  const note = form.querySelector("[data-save-note]");
  for (const input of form.querySelectorAll("[data-setting]")) {
    input.addEventListener("input", () => {
      if (save !== null) save.disabled = false;
      if (note !== null) note.textContent = "Unsaved changes";
    });
  }
};
// A contextual setting (ADR-0049 §6) shows while its condition holds, as the inputs it names change: one of them
// holding a value (a custom size's resources while the Container size or the Builder size is custom), or one having
// text (a setup's time limit while it has a script). Hidden, it is disabled, so a save never sends it.
const showContextual = (form) => {
  const valueOf = (key) => form.querySelector('[data-setting="' + key + '"]')?.value ?? "";
  for (const wrap of form.querySelectorAll("[data-shown-when]")) {
    const keys = wrap.dataset.shownWhen.split(" ");
    const holds = wrap.hasAttribute("data-shown-filled")
      ? keys.some((key) => valueOf(key).trim() !== "")
      : keys.some((key) => valueOf(key) === wrap.dataset.shownEquals);
    wrap.hidden = !holds;
    for (const input of wrap.querySelectorAll("[data-setting]")) input.disabled = !holds;
  }
};
for (const form of document.querySelectorAll("form[data-environment]")) {
  const save = form.querySelector("[data-save]");
  watchUnsaved(form);
  // The cost table follows the size and budget inputs before a save: the budget column, the current row, the summary.
  const size = form.querySelector('[data-setting="containerSize"]');
  const budget = form.querySelector('[data-setting="containerBudget"]');
  form.addEventListener("input", () => showContextual(form));
  form.addEventListener("change", () => showContextual(form));
  const resource = (key) => Number(form.querySelector('[data-setting="' + key + '"]')?.value);
  // The custom row is priced from the resources as typed, before a save.
  const priceCustom = () => {
    const row = document.querySelector('tr[data-size="custom"]');
    if (row === null) return;
    const vcpu = resource("customVcpu"), mib = resource("customMemoryMib"), mb = resource("customDiskMb");
    if (![vcpu, mib, mb].every((value) => Number.isFinite(value) && value > 0)) return;
    const per = vcpu * Number(row.dataset.vcpuHour) + (mib / 1024) * Number(row.dataset.gibHour) + (mb / 1000) * Number(row.dataset.gbHour);
    row.dataset.perHour = String(per);
    row.querySelector("[data-resource=vcpu]").textContent = String(vcpu);
    row.querySelector("[data-resource=memory]").textContent = Number((mib / 1024).toFixed(2)) + " GiB";
    row.querySelector("[data-resource=disk]").textContent = mb / 1000 + " GB";
    row.querySelector("[data-container-hour]").textContent = "$" + per.toFixed(3);
  };
  const cost = () => {
    priceCustom();
    const count = Number(budget === null ? NaN : budget.value);
    if (!Number.isInteger(count) || count < 1) return;
    const containers = count + (count === 1 ? " Container" : " Containers");
    const head = document.querySelector("[data-budget-head]");
    if (head !== null) head.textContent = containers + ", an hour";
    let current = null;
    for (const row of document.querySelectorAll("tr[data-per-hour]")) {
      const per = Number(row.dataset.perHour);
      row.querySelector("[data-budget-hour]").textContent = "$" + (per * count).toFixed(2);
      row.querySelector("[data-budget-cell]").dataset.label = containers + ", an hour";
      if (size !== null && row.dataset.size === size.value) { row.setAttribute("aria-current", "true"); current = row; }
      else row.removeAttribute("aria-current");
    }
    const budgetLine = document.querySelector("[data-budget-note]");
    if (budgetLine !== null) budgetLine.textContent = ${JSON.stringify(BUDGET_NOTE[0])} + count + ${JSON.stringify(BUDGET_NOTE[1])};
    const now = document.querySelector("[data-cost-now]");
    if (now !== null && current !== null) now.textContent = "With these settings, at most $" + (Number(current.dataset.perHour) * count).toFixed(2) + " an hour: " + containers + " of " + current.dataset.size + ", every vCPU busy.";
  };
  for (const input of [size, budget, ...form.querySelectorAll("[data-custom-resource] [data-setting]")]) if (input !== null) { input.addEventListener("input", cost); input.addEventListener("change", cost); }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    let settings;
    try {
      settings = settingsOf(form);
    } catch (error) {
      notify("err", error.message);
      return;
    }
    if (await post("/_t3flare/settings/api/environment", { settings }, save)) done();
  });
}
// The Settings server's limits (SPI-1322): every limit posted as one change to its entry; one at its value moves nothing.
// Only the limits typed over are posted, so one save never pins the rest: a limit left alone keeps following t3flare's
// default. A save reloads onto the Limits section, open, so the saved values show where they were typed.
for (const form of document.querySelectorAll("form[data-mcp-limits]")) {
  const save = form.querySelector("[data-save]");
  const section = form.closest("details");
  if (section !== null && section.id !== "" && location.hash === "#" + section.id) { section.open = true; section.scrollIntoView({ block: "start" }); }
  watchUnsaved(form);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    let limits;
    try {
      const typed = settingsOf(form);
      limits = {};
      for (const input of form.querySelectorAll("[data-setting]")) {
        if (Number(input.value) !== Number(input.defaultValue)) limits[input.dataset.setting] = typed[input.dataset.setting];
      }
    } catch (error) {
      notify("err", error.message);
      return;
    }
    if (Object.keys(limits).length === 0) { notify("ok", "Nothing to save: every limit is as it was."); return; }
    if (await post("/_t3flare/settings/api/mcp", { op: "server", server: form.dataset.mcpLimits, limits }, save)) {
      if (section !== null && section.id !== "") history.replaceState(null, "", "#" + section.id);
      done();
    }
  });
}
for (const form of document.querySelectorAll("form[data-extension]")) {
  const save = form.querySelector("[data-save]");
  const send = async (control) => {
    const change = { extension: form.dataset.extension };
    const settings = settingsOf(form);
    if (Object.keys(settings).length > 0) change.settings = settings;
    const enabled = form.querySelector("[data-enabled]");
    if (enabled !== null) change.enabled = enabled.checked;
    if (await post("/_t3flare/settings/api/extensions", change, control)) done();
    else if (control !== save && enabled !== null) enabled.checked = !enabled.checked;
  };
  const switched = form.querySelector("[data-enabled]");
  if (switched !== null) switched.addEventListener("change", () => send(switched));
  watchUnsaved(form);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (form.reportValidity()) send(save);
  });
}
// Environment skills (SPI-1148): every answer is built with textContent and createElement, never as HTML.
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
};
const kib = (bytes) => (bytes / 1024).toFixed(1) + " KiB";
const show = (out, ...nodes) => { out.replaceChildren(...nodes); };
const failed = (out, text) => show(out, el("p", text, "err"));
const getJson = async (path) => {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) throw new Error("Refused (" + response.status + "): " + (await response.text()).trim());
  return response.json();
};
const preview = document.querySelector("[data-skill-preview]");
const installing = document.querySelector("form[data-skill-install]");
if (installing !== null && preview !== null) {
  installing.addEventListener("submit", async (event) => {
    event.preventDefault();
    const source = installing.querySelector("[name=source]").value.trim();
    show(preview, el("p", "Reading " + source + " from GitHub…"));
    const response = await post("/_t3flare/settings/api/skills/preview", { source }, installing.querySelector("[type=submit]"));
    busy(installing.querySelector("[type=submit]"), false);
    if (response === undefined) { show(preview); return; }
    const answer = await response.json();
    const nodes = [el("p", answer.repo + " at " + answer.commit.slice(0, 7) + (answer.ref === null ? " (the default branch)" : " (" + answer.ref + ")") + ". " + answer.note)];
    if (answer.how === "unauthenticated") nodes.push(el("p", "Read without a token, from GitHub's shared limit of 60 an hour.", "note"));
    const picks = [];
    for (const skill of answer.skills) {
      const row = el("label", undefined, "skill-pick");
      const box = el("input");
      box.type = "checkbox";
      box.value = skill.path;
      const blocked = skill.problems.length > 0 || skill.unchanged === true;
      box.disabled = blocked;
      box.checked = !blocked;
      const text = el("span");
      text.append(el("strong", skill.name), el("span", " " + skill.description));
      const notes = [skill.files + (skill.files === 1 ? " file, " : " files, ") + kib(skill.bytes)];
      if (skill.unchanged === true) notes.push("unchanged: installed with these files from this source");
      if (skill.replaces !== undefined) notes.push("replaces " + skill.name + " from " + skill.replaces.repo + (skill.replaces.path === "" ? "" : "/" + skill.replaces.path) + " at " + skill.replaces.commit);
      for (const problem of skill.problems) notes.push("cannot be installed: " + problem);
      text.append(el("span", notes.join("; "), skill.problems.length > 0 ? "note err" : "note"));
      row.append(box, text);
      picks.push(box);
      nodes.push(row);
    }
    for (const skip of answer.unreadable) nodes.push(el("p", (skip.path || "SKILL.md") + ": " + skip.message, "note"));
    if (answer.internal > 0) nodes.push(el("p", answer.internal + " internal skills left out; name one with owner/repo@skill.", "note"));
    if (answer.omitted > 0) nodes.push(el("p", answer.omitted + " more SKILL.md files not read; name a folder with a tree URL.", "note"));
    const install = el("button", "Install selected", "btn btn-primary btn-sm");
    install.type = "button";
    install.addEventListener("click", async () => {
      const folders = picks.filter((box) => box.checked).map((box) => box.value);
      if (folders.length === 0) { notify("err", "Pick at least one skill."); return; }
      const done = await post("/_t3flare/settings/api/skills/install", { source, commit: answer.commit, folders }, install);
      busy(install, false);
      if (done === undefined) return;
      const result = await done.json();
      const lines = result.results.map((entry) => entry.name + ": " + (entry.error === undefined ? entry.action : entry.error));
      notify(result.results.every((entry) => entry.error === undefined) ? "ok" : "err", lines.join(" · "));
      if (result.results.some((entry) => entry.error === undefined)) setTimeout(() => location.reload(), 1500);
    });
    nodes.push(install);
    show(preview, ...nodes);
  });
}
const outOf = (name) => document.querySelector('[data-skill-out="' + CSS.escape(name) + '"]');
// The updates the last checks found, by skill name. An update leaves the others' found updates in place, and the page
// reloads (for its totals) only once none is left. One check or update runs at a time: while one does, every check and
// update control is disabled, so a re-check never swaps a found update out from under its running update.
const foundUpdates = new Map();
const updateAll = document.querySelector("button[data-skill-update-all]");
let skillsLocked = false;
let updatedInPlace = false;
let reloading = false;
// Once a reload is due the lock stays held, so no check starts only to be cut off by it.
const lockSkills = (on) => {
  skillsLocked = on || reloading;
  for (const button of document.querySelectorAll("button[data-skill-check]")) button.disabled = skillsLocked;
  for (const entry of foundUpdates.values()) entry.button.disabled = skillsLocked;
  if (updateAll !== null) updateAll.disabled = skillsLocked;
};
const showFoundUpdates = () => {
  if (updateAll === null) return;
  updateAll.hidden = foundUpdates.size === 0;
  updateAll.textContent = "Update all (" + foundUpdates.size + ")";
};
const reloadWhenNoneLeft = () => {
  showFoundUpdates();
  if (!updatedInPlace || foundUpdates.size > 0) return;
  reloading = true;
  setTimeout(() => location.reload(), 1500);
};
// Runs one check or update under the lock; false when another holds it.
const withSkillsLock = async (work) => {
  if (skillsLocked) return false;
  lockSkills(true);
  try { await work(); } finally { lockSkills(false); }
  return true;
};
// A found update's row: its summary, and an error and its button while it is still to be applied.
const showFound = (entry, ...before) => show(entry.out, ...before, entry.summary, entry.button);
for (const button of document.querySelectorAll("button[data-skill-view]")) {
  button.addEventListener("click", async () => {
    const name = button.dataset.skillView;
    const out = outOf(name);
    try {
      const view = await getJson("/_t3flare/settings/api/skills/view?name=" + encodeURIComponent(name));
      const list = el("ul");
      for (const file of view.files) {
        const item = el("li");
        if (file.url.startsWith("https://github.com/")) {
          const link = el("a", file.path);
          link.href = file.url;
          link.rel = "noopener noreferrer";
          link.target = "_blank";
          item.append(link, el("span", " " + kib(file.size)));
        } else item.textContent = file.path + " " + kib(file.size);
        list.append(item);
      }
      // A found update stays under the view, still applicable.
      const kept = foundUpdates.get(name);
      if (kept === undefined) show(out, el("pre", view.skillMd), list);
      else showFound(kept, el("pre", view.skillMd), list);
    } catch (error) {
      const kept = foundUpdates.get(name);
      if (kept === undefined) failed(out, error.message);
      else showFound(kept, el("p", error.message, "err"));
    }
  });
}
// One found update, applied: { text } when it was, { error } when it was not.
const updateOne = async (name) => {
  const entry = foundUpdates.get(name);
  // aria-busy alone: the lock already holds the button disabled.
  entry.button.setAttribute("aria-busy", "true");
  const answer = await request("/_t3flare/settings/api/skills/update", { name, commit: entry.commit });
  entry.button.setAttribute("aria-busy", "false");
  const updated = answer.error === undefined ? await answer.response.json().catch(() => undefined) : undefined;
  if (updated === undefined) {
    const error = answer.error ?? "The panel's answer could not be read; reload to see whether it was updated.";
    showFound(entry, el("p", error, "err"));
    return { error: name + ": " + error };
  }
  foundUpdates.delete(name);
  showFoundUpdates();
  updatedInPlace = true;
  const from = updated.from.slice(0, 7);
  const to = updated.to.slice(0, 7);
  const ident = document.querySelector('[data-skill-row="' + CSS.escape(name) + '"] .ident');
  if (ident !== null) ident.textContent = to;
  show(entry.out, el("p", "Updated from " + from + " to " + to + "."));
  return { text: name + " updated from " + from + " to " + to + "." };
};
const report = (outcomes) => {
  if (outcomes.length > 0) notify(outcomes.every((outcome) => outcome.error === undefined) ? "ok" : "err", outcomes.map((outcome) => outcome.error ?? outcome.text).join(" · "));
  reloadWhenNoneLeft();
};
if (updateAll !== null) {
  updateAll.addEventListener("click", () => withSkillsLock(async () => {
    const outcomes = [];
    for (const name of [...foundUpdates.keys()]) outcomes.push(await updateOne(name));
    report(outcomes);
  }));
}
for (const button of document.querySelectorAll("button[data-skill-check]")) {
  button.addEventListener("click", () => withSkillsLock(async () => {
    const name = button.dataset.skillCheck;
    const response = await post("/_t3flare/settings/api/skills/check", name === "" ? {} : { names: [name] }, button);
    busy(button, false);
    if (response === undefined) return;
    const answer = await response.json();
    for (const result of answer.results) {
      const out = outOf(result.name);
      const kept = foundUpdates.get(result.name);
      // A failed re-check keeps the update an earlier check found.
      if (result.status !== "current" && result.status !== "update") {
        if (kept !== undefined) showFound(kept, el("p", result.message, "err"));
        else if (out !== null) failed(out, result.message);
        continue;
      }
      foundUpdates.delete(result.name);
      if (out === null) continue;
      if (result.status === "current") { show(out, el("p", "Up to date at " + result.from + ".")); continue; }
      const parts = [["added", result.added], ["changed", result.changed], ["removed", result.removed]].filter(([, paths]) => paths.length > 0).map(([what, paths]) => what + ": " + paths.join(", "));
      const update = el("button", "Update to " + result.to, "btn btn-primary btn-sm");
      update.type = "button";
      const summary = el("p", "An update: " + result.from + " → " + result.to + ". " + (parts.length === 0 ? "" : parts.join("; ") + "."));
      const entry = { commit: result.commit, out, button: update, summary };
      foundUpdates.set(result.name, entry);
      update.addEventListener("click", () => withSkillsLock(async () => report([await updateOne(result.name)])));
      showFound(entry);
    }
    reloadWhenNoneLeft();
    if (answer.how === "unauthenticated") notify("ok", "Checked without a token, from GitHub's shared limit of 60 an hour." + (answer.note === undefined ? "" : " " + answer.note));
    else if (answer.note !== undefined) notify("ok", answer.note);
  }));
}
for (const button of document.querySelectorAll("button[data-skill-remove]")) {
  button.addEventListener("click", async () => {
    const name = button.dataset.skillRemove;
    if (!confirm("Remove the Environment skill " + name + "? Agents lose it at their next turn.")) return;
    if (await post("/_t3flare/settings/api/skills/remove", { name }, button)) done();
  });
}
for (const input of document.querySelectorAll("input[data-skill-enable]")) {
  input.addEventListener("change", async () => {
    if (await post("/_t3flare/settings/api/skills/enable", { name: input.dataset.skillEnable, enabled: input.checked }, input)) done();
    else input.checked = !input.checked;
  });
}
const format = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
for (const time of document.querySelectorAll("time[data-local]")) {
  const at = new Date(time.getAttribute("datetime"));
  if (!Number.isNaN(at.getTime())) { time.title = time.textContent; time.textContent = format.format(at); }
}
// The audit log's older pages (SPI-1366): each Show older reads the next page and adds its rows, as page.ts renders them.
const older = document.querySelector("button[data-audit-older]");
const auditRows = document.querySelector("tbody[data-audit-rows]");
const auditNote = document.querySelector("[data-audit-note]");
const auditLabels = ${JSON.stringify(ENTITY_LABELS)};
const cell = (label, className, child) => {
  const td = el("td", undefined, className);
  td.dataset.label = label;
  const div = el("div");
  div.append(child);
  td.append(div);
  return td;
};
if (older !== null && auditRows !== null) {
  // Kept focusable while it reads (aria-disabled, not disabled), so keyboard focus stays on it; once the whole log is
  // shown, the button goes and focus moves to the note that says so.
  let reading = false;
  older.addEventListener("click", async () => {
    if (reading) return;
    reading = true;
    older.setAttribute("aria-disabled", "true");
    older.setAttribute("aria-busy", "true");
    auditNote.textContent = "Reading older changes…";
    try {
      const page = await getJson(${JSON.stringify(AUDIT_API_PATH)} + "?before=" + encodeURIComponent(older.dataset.before));
      for (const entry of page.entries) {
        const at = new Date(entry.at);
        const time = el("time", format.format(at));
        time.dateTime = at.toISOString();
        time.title = at.toISOString().slice(0, 16).replace("T", " ") + " UTC";
        const row = el("tr");
        row.append(
          cell("When", "when", time),
          cell("Who", "who", document.createTextNode(entry.caller)),
          cell("Settings", undefined, document.createTextNode(auditLabels[entry.entity] ?? String(entry.entity))),
          cell("Action", undefined, el("code", entry.action)),
          cell("Target", "target", document.createTextNode(entry.target)),
          cell("Change", "change-cell", el("code", JSON.stringify(entry.after ?? null), "change")),
        );
        auditRows.append(row);
      }
      const shown = auditRows.children.length;
      if (page.before === undefined) {
        older.remove();
        auditNote.textContent = "All " + shown + " changes kept are shown.";
        const desc = document.querySelector("[data-audit-desc]");
        if (desc !== null) desc.textContent = "Every change kept, newest first.";
        const count = document.querySelector("[data-audit-count]");
        if (count !== null) count.textContent = String(shown);
        auditNote.focus();
      } else {
        older.dataset.before = String(page.before);
        auditNote.textContent = shown + " changes shown; older ones remain.";
      }
    } catch (error) {
      auditNote.textContent = error && error.message ? error.message : String(error);
    } finally {
      reading = false;
      older.removeAttribute("aria-disabled");
      older.removeAttribute("aria-busy");
    }
  });
}
const links = new Map([...document.querySelectorAll(".nav a")].map((link) => [link.getAttribute("href").slice(1), link]));
const mark = (id) => { for (const [key, link] of links) { if (key === id) link.setAttribute("aria-current", "location"); else link.removeAttribute("aria-current"); } };
if ("IntersectionObserver" in window) {
  const seen = new Set();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) { if (entry.isIntersecting) seen.add(entry.target.id); else seen.delete(entry.target.id); }
    const first = [...links.keys()].find((id) => seen.has(id));
    if (first !== undefined) mark(first);
  }, { rootMargin: "-20% 0px -60% 0px" });
  for (const id of links.keys()) { const section = document.getElementById(id); if (section !== null) observer.observe(section); }
}` +
  ENDPOINTS_SCRIPT +
  WORKSPACES_SCRIPT;
