// A conversation's Notes (SPI-1056) and its last saved Handoff, as one pi-durable conversation document in the Session
// DO's storage. Documents are not part of the transcript, so a Handoff or a compaction leaves them as they are.
// Bounded, as the document is one stored value: 256,000 characters in all, names and contents together. The Handoff is
// the model's own tool argument, so its output tokens bound it.
import { type ConversationId, defineDoc } from "@earendil-works/pi-durable";

/** The most characters all of a conversation's Notes may hold together, their names and contents. */
export const MAX_TOTAL_NOTE_CHARACTERS = 256_000;

/** A Note name: a label, not a path. */
export const NOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

export type Note = {
  name: string;
  content: string;
  /** Milliseconds since the epoch. */
  updatedAt: number;
};

export type ContextState = {
  /** In the order they were first written. */
  notes: Note[];
  /** The Handoff `context_rollover` saved last, for an Emergency Rollover. */
  handoff: string | null;
};

export const ContextDoc = defineDoc<ContextState>({
  kind: "t3flare.context",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ notes: [], handoff: null }),
  checkpointWhen: () => false,
});

/** The state as read outside a commit: the initial one until the first Note. */
export const EMPTY_STATE: ContextState = ContextDoc.definition.initial();

/** The stable reference of Note `name` of conversation `conversationId`. */
export const noteRef = (conversationId: ConversationId, name: string): string =>
  `context:${conversationId}:note:${name}`;

/** Appended text starts on a new line, so it never runs into the Note's last line. */
export const joinAppend = (existing: string, appended: string): string =>
  existing === "" || appended === "" || existing.endsWith("\n") ? existing + appended : `${existing}\n${appended}`;

/**
 * The Note Index a new context gets: how many Notes there are and each one's reference, so the agent can read them with
 * `context_notes` instead of carrying them. The Notes' total bounds it.
 */
export const noteIndex = (conversationId: ConversationId, notes: ReadonlyArray<Note>): string =>
  [
    `Notes: ${notes.length}. Read them with context_notes.`,
    ...notes.map((note) => `${JSON.stringify(note.name)} ${noteRef(conversationId, note.name)}`),
  ].join("\n");

/** The characters Note `note` counts toward the total: its name and its content. */
export const noteCharacters = (note: Pick<Note, "name" | "content">): number => note.name.length + note.content.length;

/** Note `name`, if there is one. */
export const findNote = (notes: ReadonlyArray<Note>, name: string): Note | undefined =>
  notes.find((note) => note.name === name);
