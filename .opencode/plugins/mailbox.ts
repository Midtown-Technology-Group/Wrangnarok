// SPDX-License-Identifier: AGPL-3.0
// Inter-session mailbox for opencode: borrowed heavily from OpenAI's
// Codex appserver thread model (thread/turn/item, steer, server-initiated
// request/response, bounded ingress) adapted to opencode plugin hooks.
//
// Model: an opencode session IS the thread. Delivery is file-backed JSONL
// (durable across restarts, inspectable while debugging) under
// ~/.local/share/opencode/mailbox/<project>/. Standard mail is poll-based
// (mailbox_read at turn start); high-priority mail is pushed by throwing
// into the recipient's next tool call via tool.execute.before.
//
// File-based peers (scripts/mailbox-cli.mjs) share the same stores without an
// opencode session: inbox files touched within RECENT_WINDOW_MS count as live
// for delivery, so unknown names still fault but fresh file peers are
// reachable. Push never applies to them; they poll.

import type { Plugin, ToolContext } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BODY_MAX,
  INBOX_MAX,
  MailboxFault,
  MailboxMessage,
  RECENT_WINDOW_MS,
  buildMessage,
  claimAlias,
  findReply,
  formatHead,
  formatLine,
  formatPushBlock,
  isRecentlyActive,
  markStatus,
  parseLine,
  peekPushable,
  senderLine,
  unread,
  unreadSummary,
  validAlias,
} from "./mailbox-store";

const ASK_DEFAULT_TIMEOUT_MS = 300_000;
const ASK_MAX_TIMEOUT_MS = 600_000;
const ASK_POLL_MS = 2_000;

function projectRoot(worktree: string, directory: string): string {
  const key = worktree !== "" ? worktree : directory;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return join(homedir(), ".local", "share", "opencode", "mailbox", hash);
}

function safeFile(sessionId: string): string {
  const base = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return `${base.length > 0 ? base : "session"}.jsonl`;
}

function faultText(error: unknown): string {
  if (error instanceof MailboxFault) return `MAILBOX_ERROR ${error.code}: ${error.message}`;
  return `MAILBOX_ERROR INTERNAL: ${error instanceof Error ? error.message : String(error)}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Unwrap heyapi-style `{ data }` or a bare payload. */
function unwrap<T>(response: unknown): T {
  if (response !== null && typeof response === "object" && "data" in response) {
    return (response as { data: T }).data;
  }
  return response as T;
}

class FileStore {
  constructor(private readonly root: string) {}

  private inboxPath(sessionId: string): string {
    return join(this.root, safeFile(sessionId));
  }

  private aliasesPath(): string {
    return join(this.root, "aliases.json");
  }

  aliases(): Record<string, string> {
    try {
      const raw = readFileSync(this.aliasesPath(), "utf-8");
      const value: unknown = JSON.parse(raw);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, string>;
      }
    } catch {
      // Missing or corrupt alias file: treat as empty, never crash the caller.
    }
    return {};
  }

  setAlias(alias: string, sessionId: string): void {
    mkdirSync(this.root, { recursive: true });
    const claimed = claimAlias(this.aliases(), alias, sessionId);
    if (!claimed.ok) {
      throw new MailboxFault(
        "ALIAS_TAKEN",
        `Alias ${JSON.stringify(alias)} is owned by another session and cannot be claimed.`,
      );
    }
    writeFileSync(this.aliasesPath(), JSON.stringify(claimed.aliases, null, 2));
  }

  resolveRecipient(to: string): string {
    const trimmed = to.trim();
    if (trimmed === "*") return "*";
    return this.aliases()[trimmed] ?? trimmed;
  }

  aliasFor(sessionId: string): string | undefined {
    for (const [alias, id] of Object.entries(this.aliases())) {
      if (id === sessionId) return alias;
    }
    return undefined;
  }

  load(sessionId: string): MailboxMessage[] {
    try {
      const raw = readFileSync(this.inboxPath(sessionId), "utf-8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map(parseLine)
        .filter((m): m is MailboxMessage => m !== null);
    } catch {
      return [];
    }
  }

  save(sessionId: string, messages: readonly MailboxMessage[]): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.inboxPath(sessionId), messages.map(formatLine).join("\n") + (messages.length > 0 ? "\n" : ""));
  }

  append(sessionId: string, message: MailboxMessage): void {
    mkdirSync(this.root, { recursive: true });
    appendFileSync(this.inboxPath(sessionId), formatLine(message) + "\n");
  }

  knownSessions(): string[] {
    try {
      return readdirSync(this.root)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => name.slice(0, -".jsonl".length));
    } catch {
      return [];
    }
  }

  /**
   * File-based peers (e.g. scripts/mailbox-cli.mjs harnesses without an
   * opencode session) have no entry in the live session list. Inbox files
   * touched within the recency window count as live for delivery so unknown
   * names still fault but fresh file peers stay reachable. Stems are stable:
   * safeFile is idempotent, so a stem always addresses its own inbox.
   */
  activeSessions(nowMs: number = Date.now(), windowMs: number = RECENT_WINDOW_MS): string[] {
    try {
      return readdirSync(this.root)
        .filter((name) => name.endsWith(".jsonl"))
        .filter((name) => {
          try {
            return isRecentlyActive(statSync(join(this.root, name)).mtimeMs, nowMs, windowMs);
          } catch {
            return false;
          }
        })
        .map((name) => name.slice(0, -".jsonl".length));
    } catch {
      return [];
    }
  }
}

const MailboxPlugin = (async ({ client, worktree, directory }) => {
  const root = projectRoot(worktree, directory);
  const store = new FileStore(root);

  async function liveSessionIds(): Promise<Set<string>> {
    const live = new Set<string>();
    try {
      const sessions = unwrap<readonly { id: string }[]>(await client.session.list());
      if (Array.isArray(sessions)) {
        for (const s of sessions) live.add(s.id);
      }
    } catch {
      // Client unavailable: fall through to file activity alone.
    }
    for (const id of store.activeSessions()) live.add(id);
    return live;
  }

  const mailboxSend = tool({
    description:
      "Send mail to another opencode session (a peer agent thread). `to` is a session ID, a registered alias, or \"*\" for broadcast. kind steer requires priority high and auto-injects into the recipient's next tool call; standard mail waits for their mailbox_read. Body cap 4096 chars.",
    args: {
      to: tool.schema.string(),
      body: tool.schema.string(),
      kind: tool.schema.string().optional(),
      priority: tool.schema.string().optional(),
      subject: tool.schema.string().optional(),
      replyTo: tool.schema.string().optional(),
    },
    execute: async (args, context: ToolContext) => {
      try {
        const to = store.resolveRecipient(args.to);
        if (to !== "*") {
          const live = await liveSessionIds();
          if (live.size > 0 && !live.has(to)) {
            throw new MailboxFault("UNKNOWN_PEER", `No live session ${JSON.stringify(args.to)}. See mailbox_sessions.`);
          }
        }
        const message = buildMessage(context.sessionID, args, randomUUID(), new Date().toISOString());
        const tagged: MailboxMessage =
          store.aliasFor(context.sessionID) === undefined
            ? message
            : { ...message, fromAlias: store.aliasFor(context.sessionID) };
        const targets = to === "*" ? store.knownSessions() : [to];
        if (targets.length === 0) throw new MailboxFault("NO_RECIPIENTS", "Broadcast has no known inboxes yet.");
        for (const target of targets) {
          if (unread(store.load(target)).length >= INBOX_MAX) {
            throw new MailboxFault(
              "MAILBOX_FULL",
              `Recipient inbox is full (${INBOX_MAX} unread). Retry with backoff.`,
            );
          }
        }
        for (const target of targets) store.append(target, { ...tagged, to: target });
        return `sent ${tagged.id} to ${args.to} (${targets.length} inbox(es))`;
      } catch (error) {
        throw new Error(faultText(error));
      }
    },
  });

  const mailboxRead = tool({
    description:
      "Read YOUR inbox (oldest unread first, max 20). Call at turn start and before finishing a turn so peer agents can reach you. Returned messages are marked read.",
    args: {},
    execute: async (_args, context: ToolContext) => {
      const messages = store.load(context.sessionID);
      const pending = unread(messages).slice(0, 20);
      if (pending.length === 0) return "Mailbox: empty.";
      store.save(
        context.sessionID,
        markStatus(messages, pending.map((m) => m.id), "read"),
      );
      return pending
        .map((m) => {
          const head = formatHead(m);
          return `${head}\n${m.body}`;
        })
        .join("\n---\n");
    },
  });

  const mailboxAck = tool({
    description:
      "Acknowledge a message by id. Flips the read flag on the stored message itself — sends nothing back, so acks can never recurse. The sender sees it via mailbox_sent.",
    args: { id: tool.schema.string() },
    execute: async (args, context: ToolContext) => {
      const messages = store.load(context.sessionID);
      if (!messages.some((m) => m.id === args.id)) throw new Error("MAILBOX_ERROR UNKNOWN_MESSAGE: no such message.");
      store.save(context.sessionID, markStatus(messages, [args.id], "acked"));
      return `acked ${args.id}`;
    },
  });

  const mailboxAsk = tool({
    description:
      "Blocking ask: send a request and wait for the peer's reply (correlated by message id). Returns the reply body. Throws MAILBOX_TIMEOUT on expiry. Borrowed from Codex server-initiated requests, inverted.",
    args: {
      to: tool.schema.string(),
      body: tool.schema.string(),
      subject: tool.schema.string().optional(),
      timeoutMs: tool.schema.number().optional(),
    },
    execute: async (args, context: ToolContext) => {
      try {
        const to = store.resolveRecipient(args.to);
        const live = await liveSessionIds();
        if (live.size > 0 && !live.has(to)) {
          throw new MailboxFault("UNKNOWN_PEER", `No live session ${JSON.stringify(args.to)}. See mailbox_sessions.`);
        }
        const request = buildMessage(
          context.sessionID,
          { to, kind: "request", body: args.body, subject: args.subject },
          randomUUID(),
          new Date().toISOString(),
        );
        if (unread(store.load(to)).length >= INBOX_MAX) {
          throw new MailboxFault("MAILBOX_FULL", `Recipient inbox is full (${INBOX_MAX} unread). Retry with backoff.`);
        }
        store.append(to, request);
        const timeout = Math.min(args.timeoutMs ?? ASK_DEFAULT_TIMEOUT_MS, ASK_MAX_TIMEOUT_MS);
        const deadline = Date.now() + timeout;
        for (;;) {
          const reply = findReply(unread(store.load(context.sessionID)), request.id);
          if (reply !== null) {
            store.save(context.sessionID, markStatus(store.load(context.sessionID), [reply.id], "read"));
            return `reply from ${senderLine(reply)}:\n${reply.body}`;
          }
          if (Date.now() >= deadline) throw new MailboxFault("MAILBOX_TIMEOUT", `No reply to ${request.id} within ${timeout}ms.`);
          await sleep(Math.min(ASK_POLL_MS, Math.max(0, deadline - Date.now())), context.abort);
        }
      } catch (error) {
        if (error instanceof Error && error.message === "aborted") throw new Error("MAILBOX_ERROR ABORTED: ask cancelled.");
        throw new Error(faultText(error));
      }
    },
  });

  const mailboxSent = tool({
    description: "Show messages YOU sent with per-message delivery status (queued/delivered/read/acked). Poll this after mailbox_send to confirm the peer saw your mail.",
    args: {},
    execute: async (_args, context: ToolContext) => {
      const files = store.knownSessions();
      const mine: MailboxMessage[] = [];
      for (const file of files) {
        for (const m of store.load(file)) {
          if (m.from === context.sessionID) mine.push(m);
        }
      }
      if (mine.length === 0) return "No sent messages.";
      return mine
        .slice(-20)
        .map((m) => `${m.id} -> ${m.to} [${m.kind}/${m.priority}] status=${m.status} ${m.ts}`)
        .join("\n");
    },
  });

  const mailboxAlias = tool({
    description: "Register a short alias for your session so peers can address you without the opaque session ID. Lowercase letters, digits, dash, underscore; max 32 chars.",
    args: { alias: tool.schema.string() },
    execute: async (args, context: ToolContext) => {
      const alias = args.alias.trim().toLowerCase();
      if (!validAlias(alias)) throw new Error("MAILBOX_ERROR BAD_ALIAS: use [a-z0-9_-], max 32 chars, start alnum.");
      store.setAlias(alias, context.sessionID);
      return `alias ${JSON.stringify(alias)} -> ${context.sessionID}`;
    },
  });

  const mailboxSessions = tool({
    description: "List live peer sessions (thread discovery, cf. Codex thread/list). Use with mailbox_history to hydrate a peer's context before replying.",
    args: {},
    execute: async () => {
      try {
        const sessions = unwrap<readonly { id: string; title?: string }[]>(await client.session.list());
        if (!Array.isArray(sessions) || sessions.length === 0) return "No live sessions.";
        const aliases = store.aliases();
        const names = new Map<string, string>();
        for (const [alias, id] of Object.entries(aliases)) names.set(id, alias);
        return sessions
          .map((s) => `${s.id}${names.get(s.id) ? ` (alias: ${names.get(s.id)})` : ""}${s.title ? ` title=${JSON.stringify(s.title)}` : ""}`)
          .join("\n");
      } catch (error) {
        throw new Error(faultText(error));
      }
    },
  });

  const mailboxHistory = tool({
    description: "Read a peer session's recent messages (read-only hydration, cf. Codex thread/read). Limit defaults to 10, max 50. Output truncated for context economy.",
    args: { session: tool.schema.string(), limit: tool.schema.number().optional() },
    execute: async (args) => {
      try {
        const peer = store.resolveRecipient(args.session);
        const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
        const items = unwrap<readonly { info: { role: string }; parts: readonly { type: string }[] }[]>(
          await client.session.messages({ path: { id: peer }, query: { limit } }),
        );
        if (!Array.isArray(items) || items.length === 0) return "No messages.";
        return items
          .map((item) => {
            const texts = item.parts
              .map((p) => (p.type === "text" && "text" in p ? String((p as { text: unknown }).text) : `[${p.type}]`))
              .join("\n");
            return `[${item.info.role}]\n${texts.slice(0, 2000)}`;
          })
          .join("\n---\n")
          .slice(0, 4000);
      } catch (error) {
        throw new Error(faultText(error));
      }
    },
  });

  return {
    tool: {
      mailbox_send: mailboxSend,
      mailbox_read: mailboxRead,
      mailbox_ack: mailboxAck,
      mailbox_ask: mailboxAsk,
      mailbox_sent: mailboxSent,
      mailbox_alias: mailboxAlias,
      mailbox_sessions: mailboxSessions,
      mailbox_history: mailboxHistory,
    },
    // Push path: every tool call is a mail check. High-priority mail injects
    // once (marked delivered) by aborting the call with the mail inline.
    // Mailbox tools are exempt so the agent can always read/ack its way out.
    "tool.execute.before": async (input) => {
      if (input.tool.startsWith("mailbox_")) return;
      try {
        const messages = store.load(input.sessionID);
        const pushable = peekPushable(messages);
        if (pushable.length === 0) return;
        store.save(input.sessionID, markStatus(messages, pushable.map((m) => m.id), "delivered"));
        throw new Error(formatPushBlock(pushable));
      } catch (error) {
        // Rethrow only our push block; a broken store must never break unrelated tools.
        if (error instanceof Error && error.message.startsWith("MAILBOX_HIGH_PRIORITY")) throw error;
      }
    },
    // Poll convention, durable across compaction: remind the resumed agent.
    "experimental.session.compacting": async (input, output) => {
      try {
        output.context.push(
          `Inter-agent mailbox: call mailbox_read at turn start and before finishing. ${unreadSummary(store.load(input.sessionID))} BODY_MAX is ${BODY_MAX} chars.`,
        );
      } catch {
        // Compaction must never fail because the mailbox store is unavailable.
      }
    },
  };
}) satisfies Plugin;

export default MailboxPlugin;
