// @effect-diagnostics nodeBuiltinImport:off
// SPI-1404 (upstream-fragility U110): what `agents/parkQuestions.ts` leans on in t3, pinned to t3's own schema and DDL:
// the two commands decode as t3's `OrchestrationV2Command`, and `parkQuestionOf` reads the runtime-request projection
// as t3's migrations create it and t3's encoder writes it.
import * as fs from "node:fs";

import { NodeId, OrchestrationV2Command, OrchestrationV2RuntimeRequest, RuntimeRequestId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { parkAnswerCommand, parkDismissCommand, parkQuestionOf } from "../src/agents/parkQuestions.ts";
import type { ParkedCard } from "../src/provider/cli/parked.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

const MIGRATIONS = new URL("../../../t3code/apps/server/src/persistence/Migrations/", import.meta.url);
const TABLE = "orchestration_v2_projection_runtime_requests";

const CARD: ParkedCard = {
  id: "runtime-request:codex:t3flare-park:x",
  thread: "thread-1",
  kind: "change",
  title: "t",
  changeId: "chg_1",
  parkedAt: 1,
};

/** Every migration source, with the ones migrations import from their subdirectories (`OrchestrationV2/`). */
const migrationFiles = (): ReadonlyArray<string> =>
  fs.readdirSync(MIGRATIONS, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts"));
const migrationSources = (): ReadonlyArray<string> =>
  migrationFiles().map((file) => fs.readFileSync(new URL(file, MIGRATIONS), "utf8"));

describe("a park question as t3 holds it (SPI-1404, U110)", () => {
  it("answers and dismisses with commands t3's command schema accepts", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationV2Command);
    expect(decode(parkAnswerCommand(CARD, true))).toMatchObject({
      type: "runtime-request.respond",
      requestId: CARD.id,
      answers: { decision: "Approve" },
    });
    expect(decode(parkAnswerCommand(CARD, false))).toMatchObject({ answers: { decision: "Decline" } });
    expect(decode(parkDismissCommand(CARD))).toMatchObject({ type: "thread.user-input.dismiss", requestId: CARD.id });
  });

  it("reads the projection t3's migrations create, as t3 encodes its rows", () => {
    // The scan reaches the subdirectories, where 055's own steps live: it cannot go blind to them unseen.
    expect(migrationFiles().some((file) => file.startsWith("OrchestrationV2/"))).toBe(true);
    const sources = migrationSources();
    // A later migration that alters the table is a change this read has to be checked against.
    expect(sources.filter((source) => source.includes(`ALTER TABLE ${TABLE}`))).toEqual([]);
    const ddl = sources.flatMap(
      (source) => source.match(new RegExp(`CREATE TABLE ${TABLE} \\([^;]*?\\n\\s*\\)`)) ?? [],
    );
    expect(ddl).toHaveLength(1);
    const sql = nodeSqlStorage();
    sql.exec(ddl[0]!);
    const encode = Schema.encodeSync(OrchestrationV2RuntimeRequest);
    const put = (id: string, status: "pending" | "resolved" | "cancelled", answers?: Record<string, unknown>) => {
      const request: OrchestrationV2RuntimeRequest = {
        id: RuntimeRequestId.make(id),
        nodeId: NodeId.make("node-1"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status,
        responseCapability: { type: "message" },
        createdAt: Schema.decodeSync(Schema.DateTimeUtcFromString)("1970-01-01T00:00:00.000Z"),
        resolvedAt: null,
        ...(answers === undefined ? {} : { answers }),
      };
      const payload = encode(request);
      sql.exec(
        `INSERT INTO ${TABLE} (runtime_request_id, thread_id, node_id, provider_turn_id, kind, status, created_at,` +
          ` resolved_at, payload_json) VALUES (?, 't-1', 'node-1', NULL, 'user_input', ?, '1970-01-01', NULL, ?)`,
        id,
        status,
        JSON.stringify(payload),
      );
    };
    put("p-pending", "pending");
    put("p-answered", "resolved", { decision: "Approve" });
    put("p-dismissed", "resolved");
    put("p-cancelled", "cancelled");
    expect(parkQuestionOf(sql, "p-pending")).toBe("pending");
    expect(parkQuestionOf(sql, "p-answered")).toBe("answered");
    expect(parkQuestionOf(sql, "p-dismissed")).toBe("dismissed");
    expect(parkQuestionOf(sql, "p-cancelled")).toBe("dismissed");
    expect(parkQuestionOf(sql, "p-none")).toBe("gone");
  });
});
