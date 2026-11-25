// Claude Code's Model endpoints (SPI-1168): the endpoints that speak Anthropic Messages. Claude Code runs on them
// through the model relay (without one it is refused, SPI-1176): its one base URL is the relay's model-routed URL, so
// it reaches every such endpoint in one process (a model switch between two endpoints stays in the thread's process),
// and its models are the endpoints' slugs, which the relay reads from each request to pick its endpoint. The choice is
// the Environment's, not the session's: Claude Code's managed settings are the Container's, shared by every Claude
// process in it. Its background model (`ANTHROPIC_DEFAULT_HAIKU_MODEL`) is the text-generation model when that is one
// of these endpoints' models. Pure.
import type { ServerProviderModel } from "@t3tools/contracts";
import { endpointSlug, type ModelEndpoint, type ModelEndpoints, selectionSlug } from "@t3flare/models/endpoints";
import { endpointsOfApi } from "@t3flare/models/relay";

import type { ClaudeRelay } from "../../agents/acpProfiles.ts";
import { relayPickerModels, relayTextModel } from "./relayModels.ts";

/**
 * The endpoints Claude Code reaches through the model relay: those that speak Anthropic Messages and list a model
 * (its `availableModels` come from them; an endpoint with none adds nothing, and none with a model leaves Claude Code
 * with no endpoint, refused at its spawn).
 */
export const claudeEndpoints = (endpoints: ModelEndpoints | undefined): ReadonlyArray<ModelEndpoint> =>
  endpointsOfApi(endpoints, "anthropic-messages", "claude").filter((endpoint) => endpoint.models.length > 0);

/**
 * A model id's version within `family`: the numbers right after the family's word (`claude-opus-4-1-20250805` is 4.1,
 * `claude-opus-5-5` 5.5), else right before it (`claude-3-7-sonnet-20250219` is 3.7). A date (more than three digits)
 * is no part of it. Undefined: the id does not name the family.
 */
export const familyVersion = (id: string, family: string): ReadonlyArray<number> | undefined => {
  const words = id.toLowerCase().split(/[-_./:]/);
  const at = words.indexOf(family);
  if (at < 0) return undefined;
  const numbers = (from: ReadonlyArray<string>) => {
    const version: Array<number> = [];
    for (const word of from) {
      if (!/^\d{1,3}$/.test(word)) break;
      version.push(Number(word));
    }
    return version;
  };
  const after = numbers(words.slice(at + 1));
  return after.length > 0 ? after : numbers(words.slice(0, at).toReversed()).toReversed();
};

/** Positive when version `a` is newer than `b` (a missing part counts as 0: 4 is 4.0). */
const newer = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const step = (a[index] ?? 0) - (b[index] ?? 0);
    if (step !== 0) return step;
  }
  return 0;
};

/**
 * The slug Claude Code's `opus` or `sonnet` alias resolves to: the family's newest model, as stock Claude Code's alias
 * is (ADR-0049's local parity). Among models of one version, the one pi-ai's catalog knows, then the owner's order.
 * Never the family's first listed: Commissary lists dated models first (`claude-opus-4-1-20250805`), which its
 * credentials refuse, and an imported `"model": "opus"` opens every session on the alias. No model of the family: the
 * first model listed (so the alias still names a slug the relay routes, never Claude Code's own id).
 */
const familyModelOf = (own: ReadonlyArray<ModelEndpoint>, family: "opus" | "sonnet"): string | undefined => {
  const slugs = own.flatMap((endpoint) =>
    endpoint.models.map((model) => ({ slug: endpointSlug(endpoint.id, model.id), id: model.id, known: model.known })),
  );
  let best: { readonly slug: string; readonly known: boolean; readonly version: ReadonlyArray<number> } | undefined;
  for (const entry of slugs) {
    const version = familyVersion(entry.id, family);
    if (version === undefined) continue;
    const step = best === undefined ? 1 : newer(version, best.version);
    if (step > 0 || (step === 0 && entry.known && best?.known !== true)) best = { ...entry, version };
  }
  return (best ?? slugs[0])?.slug;
};

/** Claude Code's relay configuration for the endpoints as stored now, or undefined when there is no such endpoint. */
export const claudeRelayOf = (
  endpoints: ModelEndpoints | undefined,
  textModel: string | undefined,
): ClaudeRelay | undefined => {
  const own = claudeEndpoints(endpoints);
  if (own.length === 0) return undefined;
  return {
    endpoints: own.map((endpoint) => endpoint.id),
    models: own.flatMap((endpoint) => endpoint.models.map((model) => endpointSlug(endpoint.id, model.id))),
    backgroundModel: relayTextModel(own, textModel),
    opusModel: familyModelOf(own, "opus"),
    sonnetModel: familyModelOf(own, "sonnet"),
  };
};

/**
 * Claude Code's model list: the Anthropic Messages endpoints' models by slug, grouped by endpoint (the endpoint's id
 * beside a label two endpoints share), with the effort picker on reasoning models, the first the default. Empty without
 * one: the provider then needs setup.
 */
export const claudeModelsOf = (endpoints: ModelEndpoints | undefined): ReadonlyArray<ServerProviderModel> =>
  relayPickerModels(claudeEndpoints(endpoints));

/**
 * The model as Claude Code names it: an Anthropic Messages endpoint's by its slug (the relay routes by it). An old
 * model (`isRetiredSlug`: a bare id, t3's stock Claude default, `anthropic/<id>`) is the default model, the list's
 * first (`selectionSlug`). Any other slug (an endpoint that is gone) stays as it is: Claude Code's session does not
 * offer it, and t3's adapter refuses it before any request.
 */
export const claudeModelId = (slug: string, endpoints: ModelEndpoints | undefined): string =>
  selectionSlug(slug, relayPickerModels(claudeEndpoints(endpoints))[0]?.slug);
