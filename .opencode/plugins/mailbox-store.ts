// SPDX-License-Identifier: AGPL-3.0
// Pure mailbox logic for the opencode inter-session mailbox plugin.
// No node imports: must stay importable from workerd Vitest tests.

export type MailboxKind = "note" | "steer" | "request" | "reply";
export type MailboxPriority = "standard" | "high";
export type MailboxStatus = "queued" | "delivered" | "read" | "acked";

export interface MailboxMessage {
  readonly id: string;
  readonly from: string;
  readonly fromAlias?: string;
  readonly to: string;
  readonly ts: string;
  readonly kind: MailboxKind;
  readonly priority: MailboxPriority;
  readonly subject?: string;
  readonly body: string;
  readonly replyTo?: string;
  readonly status: MailboxStatus;
}

export const BODY_MAX = 4096;
export const SUBJECT_MAX = 128;
export const ADDRESS_MAX = 128;
export const INBOX_MAX = 100;
export const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Inbox files touched within this window count as live peers for delivery. */
export const RECENT_WINDOW_MS = 15 * 60 * 1000;

/** Pure recency check so file-based (non-opencode) peers stay testable in workerd. */
export function isRecentlyActive(mtimeMs: number, nowMs: number, windowMs: number = RECENT_WINDOW_MS): boolean {
  return Number.isFinite(mtimeMs) && mtimeMs <= nowMs && nowMs - mtimeMs <= windowMs;
}

const KINDS: readonly string[] = ["note", "steer", "request", "reply"];
const PRIORITIES: readonly string[] = ["standard", "high"];
const STATUSES: readonly string[] = ["queued", "delivered", "read", "acked"];

export class MailboxFault extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MailboxFault";
    this.code = code;
  }
}

export interface SendInput {
  readonly to: string;
  readonly kind?: string;
  readonly priority?: string;
  readonly subject?: string;
  readonly body: string;
  readonly replyTo?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate a send and build the stored message. `id`/`ts` are caller-supplied for purity. */
export function buildMessage(from: string, input: SendInput, id: string, ts: string): MailboxMessage {
  const to = input.to.trim();
  if (to.length === 0 || to.length > ADDRESS_MAX) {
    throw new MailboxFault("BAD_ADDRESS", `Recipient must be 1 to ${ADDRESS_MAX} characters.`);
  }
  const kind: MailboxKind = input.kind === undefined ? "note" : parseKind(input.kind);
  const priority: MailboxPriority =
    input.priority === undefined ? (kind === "steer" ? "high" : "standard") : parsePriority(input.priority);
  // Steer is the push path (auto-inject on the recipient's next tool call);
  // a standard-priority steer would silently downgrade to poll, so reject it.
  if (kind === "steer" && priority !== "high") {
    throw new MailboxFault("STEER_PRIORITY", `kind "steer" requires priority "high".`);
  }
  if (kind === "reply" && (input.replyTo === undefined || input.replyTo.trim().length === 0)) {
    throw new MailboxFault("REPLY_NO_TARGET", `kind "reply" requires replyTo with the request id.`);
  }
  if (input.body.length === 0) throw new MailboxFault("BODY_EMPTY", "Message body must not be empty.");
  if (input.body.length > BODY_MAX) {
    throw new MailboxFault("BODY_TOO_LARGE", `Message body exceeds ${BODY_MAX} characters.`);
  }
  const subject = input.subject?.trim() ? input.subject.trim() : undefined;
  if (subject !== undefined && subject.length > SUBJECT_MAX) {
    throw new MailboxFault("SUBJECT_TOO_LONG", `Subject exceeds ${SUBJECT_MAX} characters.`);
  }
  return {
    id,
    from,
    to,
    ts,
    kind,
    priority,
    ...(subject === undefined ? {} : { subject }),
    body: input.body,
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
    status: "queued",
  };
}

function parseKind(value: string): MailboxKind {
  if (!(KINDS as readonly string[]).includes(value)) {
    throw new MailboxFault("BAD_KIND", `kind must be one of ${KINDS.join(", ")}.`);
  }
  return value as MailboxKind;
}

function parsePriority(value: string): MailboxPriority {
  if (!(PRIORITIES as readonly string[]).includes(value)) {
    throw new MailboxFault("BAD_PRIORITY", `priority must be one of ${PRIORITIES.join(", ")}.`);
  }
  return value as MailboxPriority;
}

/** Parse one JSONL line; malformed or schema-invalid lines return null (never throw). */
export function parseLine(line: string): MailboxMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { id, from, to, ts, kind, priority, body, status } = value;
  if (
    typeof id !== "string" ||
    typeof from !== "string" ||
    typeof to !== "string" ||
    typeof ts !== "string" ||
    typeof kind !== "string" ||
    typeof priority !== "string" ||
    typeof body !== "string" ||
    typeof status !== "string" ||
    !(KINDS as readonly string[]).includes(kind) ||
    !(PRIORITIES as readonly string[]).includes(priority) ||
    !(STATUSES as readonly string[]).includes(status)
  ) {
    return null;
  }
  let msg: MailboxMessage = {
    id,
    from,
    to,
    ts,
    kind: kind as MailboxKind,
    priority: priority as MailboxPriority,
    body,
    status: status as MailboxStatus,
  };
  if (typeof value.fromAlias === "string") msg = { ...msg, fromAlias: value.fromAlias };
  if (typeof value.subject === "string") msg = { ...msg, subject: value.subject };
  if (typeof value.replyTo === "string") msg = { ...msg, replyTo: value.replyTo };
  return msg;
}

export function formatLine(msg: MailboxMessage): string {
  return JSON.stringify(msg);
}

/** Messages the recipient has not yet consumed. */
export function unread(messages: readonly MailboxMessage[]): MailboxMessage[] {
  return messages.filter((m) => m.status === "queued" || m.status === "delivered");
}

/** High-priority mail never yet pushed: inject once, then it stays unread until read/ack. */
export function peekPushable(messages: readonly MailboxMessage[]): MailboxMessage[] {
  return messages.filter((m) => m.status === "queued" && m.priority === "high");
}

const RANK: Record<MailboxStatus, number> = { queued: 0, delivered: 1, read: 2, acked: 3 };

/**
 * Status transitions are monotonic: queued -> delivered -> read -> acked.
 * `delivered` is only reachable from `queued` (inject-once); `read`/`acked`
 * may land from any earlier state so read/ack never regress a message.
 */
export function markStatus(
  messages: readonly MailboxMessage[],
  ids: readonly string[],
  to: MailboxStatus,
): MailboxMessage[] {
  const wanted = new Set(ids);
  return messages.map((m) => {
    if (!wanted.has(m.id)) return m;
    if (to === "delivered" && m.status !== "queued") return m;
    if (RANK[to] < RANK[m.status]) return m;
    if (m.status === to) return m;
    return { ...m, status: to };
  });
}

/** First reply answering a request id, in inbox order. */
export function findReply(
  messages: readonly MailboxMessage[],
  requestId: string,
): MailboxMessage | null {
  for (const m of messages) {
    if (m.kind === "reply" && m.replyTo === requestId) return m;
  }
  return null;
}

export function validAlias(alias: string): boolean {
  return ALIAS_RE.test(alias);
}

export interface AliasClaimOk {
  readonly ok: true;
  readonly aliases: Record<string, string>;
}
export interface AliasClaimTaken {
  readonly ok: false;
  readonly owner: string;
}
export type AliasClaim = AliasClaimOk | AliasClaimTaken;

/**
 * Atomic alias claim (issue #382): an alias owned by a different session is
 * never overwritten, so a peer cannot hijack a victim's alias and divert or
 * impersonate their mail. Re-claiming by the owning session is idempotent,
 * and claiming a second alias releases the first, so one session holds at
 * most one alias and stale mappings cannot linger as impersonation fuel.
 */
export function claimAlias(
  current: Record<string, string>,
  alias: string,
  sessionId: string,
): AliasClaim {
  const owner = current[alias];
  if (owner !== undefined && owner !== sessionId) return { ok: false, owner };
  const next: Record<string, string> = {};
  for (const [name, id] of Object.entries(current)) {
    if (id !== sessionId) next[name] = id;
  }
  next[alias] = sessionId;
  return { ok: true, aliases: next };
}

/**
 * Sender line (issue #382): presentation always includes the immutable sender
 * session ID alongside any claimed alias, so a peer that copies a victim's
 * alias cannot pass its mail off as the victim's. Alias text is display-only.
 */
export function senderLine(message: MailboxMessage): string {
  return message.fromAlias === undefined
    ? message.from
    : `${message.from} (alias ${JSON.stringify(message.fromAlias)})`;
}

/** Human-readable block thrown into the recipient's tool call for high-priority push. */
export function formatPushBlock(messages: readonly MailboxMessage[]): string {
  const lines = messages.map((m) => {
    const head = `[mailbox:${m.kind}] from ${senderLine(m)} (${m.id})`;
    const subject = m.subject !== undefined ? ` subj=${JSON.stringify(m.subject)}` : "";
    return `${head}${subject}\n${m.body}`;
  });
  return `MAILBOX_HIGH_PRIORITY: ${messages.length} high-priority message(s). Read with mailbox_read, acknowledge with mailbox_ack.\n${lines.join("\n---\n")}`;
}

/**
 * Single-message presentation head shared by mailbox_read, mailbox_ask, and
 * the CLI so every surface carries the same tamper-evident sender line.
 */
export function formatHead(message: MailboxMessage): string {
  return `[${message.kind}/${message.priority}] from ${senderLine(message)} id=${message.id}${message.replyTo ? ` replyTo=${message.replyTo}` : ""}${message.subject ? ` subj=${JSON.stringify(message.subject)}` : ""}`;
}

/** One-liner for compaction context and turn-start summaries. */
export function unreadSummary(messages: readonly MailboxMessage[]): string {
  const pending = unread(messages);
  if (pending.length === 0) return "Mailbox: empty.";
  const high = pending.filter((m) => m.priority === "high").length;
  return `Mailbox: ${pending.length} unread (${high} high-priority). Call mailbox_read.`;
}
