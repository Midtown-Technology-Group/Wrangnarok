// SPDX-License-Identifier: AGPL-3.0
// File-based bridge to the opencode inter-session mailbox (.opencode/plugins).
// Lets harnesses without the opencode plugin host (no mailbox_* tools, no
// session identity) send, read, and own an alias in the same JSONL stores.
// Poll-only: nothing here can push into a live session; opencode recipients
// still get their normal push path via their own hooks.
//
// Repo scoping (issue #380): every command operates ONLY inside the resolved
// store (explicit --store, $MAILBOX_STORE, or the git-derived default for
// this repository). The CLI never enumerates, resolves, reads, or writes
// other repositories' stores, so one checkout cannot disclose or steer
// another project's sessions.
// Identity caveat: --as / $MAILBOX_SESSION is caller-asserted (there is no
// opencode session to authenticate against), so it is meaningful only inside
// this repo store. Alias claims still reject hijacks: an alias owned by a
// different session cannot be taken over (issue #382).

import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  INBOX_MAX,
  MailboxFault,
  buildMessage,
  claimAlias,
  findReply,
  formatHead,
  formatLine,
  isRecentlyActive,
  markStatus,
  parseLine,
  unread,
  validAlias,
} from "../.opencode/plugins/mailbox-store.ts";

function fail(code, message) {
  console.error(`MAILBOX_ERROR ${code}: ${message}`);
  process.exit(code === "USAGE" || code === "VALIDATION" ? 2 : 1);
}

function mailboxRoots() {
  return join(homedir(), ".local", "share", "opencode", "mailbox");
}

// Repo-scoped store key: resolve the git common dir (shared by every
// worktree of this repo) to an absolute path and strip the trailing .git, so
// all worktrees of one repo share one store while distinct repos get
// distinct stores. The previous code applied dirname() to the raw,
// usually relative ".git" value, collapsing every normal checkout to the
// constant "." and a single shared store hash.
function stableKey() {
  try {
    const common = execSync("git rev-parse --git-common-dir", { encoding: "utf-8" }).trim();
    const abs = isAbsolute(common) ? common : join(process.cwd(), common);
    const match = abs.match(/^(.*)[/\\]\.git(?:[/\\].*)?$/);
    if (match && match[1]) return match[1];
    return abs;
  } catch {
    return process.cwd();
  }
}

function defaultStore() {
  if (process.env.MAILBOX_STORE) return process.env.MAILBOX_STORE;
  const key = stableKey();
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return join(mailboxRoots(), hash);
}

function identity(args) {
  const id = args.as ?? process.env.MAILBOX_SESSION;
  if (!id) fail("USAGE", "no identity: pass --as <session> or set $MAILBOX_SESSION.");
  return id;
}

function safeFile(sessionId) {
  const base = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return `${base.length > 0 ? base : "session"}.jsonl`;
}

function readAliases(root) {
  try {
    const value = JSON.parse(readFileSync(join(root, "aliases.json"), "utf-8"));
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // Missing or corrupt: empty.
  }
  return {};
}

function loadInbox(root, sessionId) {
  try {
    const raw = readFileSync(join(root, safeFile(sessionId)), "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(parseLine)
      .filter((m) => m !== null);
  } catch {
    return [];
  }
}

function saveInbox(root, sessionId, messages) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, safeFile(sessionId)),
    messages.map(formatLine).join("\n") + (messages.length > 0 ? "\n" : ""),
  );
}

function aliasFor(root, sessionId) {
  for (const [alias, id] of Object.entries(readAliases(root))) {
    if (id === sessionId) return alias;
  }
  return undefined;
}

/** Inboxes known in THIS repo store only. Never other repositories' stores. */
function listInboxes(store) {
  try {
    return readdirSync(store)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => n.slice(0, -6));
  } catch {
    return [];
  }
}

/** Resolve a recipient (alias or session id) inside THIS repo store only. */
function resolveRecipient(to, store) {
  const trimmed = to.trim();
  if (trimmed === "*") return { store, session: "*" };
  const aliases = readAliases(store);
  if (aliases[trimmed] !== undefined) return { store, session: aliases[trimmed] };
  if (existsSync(join(store, safeFile(trimmed)))) return { store, session: trimmed };
  fail("VALIDATION", `unknown recipient ${JSON.stringify(to)} (no alias or inbox in this repo store).`);
}

function cmdSend(args, rest) {
  const to = rest["to"];
  const body = rest["body"];
  if (!to || body === undefined) fail("USAGE", "send needs --to <alias|session|*> and --body <text>.");
  const from = identity(args);
  const target = resolveRecipient(to, args.store);
  const message = buildMessage(
    from,
    {
      to: target.session,
      kind: rest["kind"],
      priority: rest["priority"],
      subject: rest["subject"],
      body,
      replyTo: rest["reply-to"],
    },
    randomUUID(),
    new Date().toISOString(),
  );
  const targets =
    target.session === "*"
      ? listInboxes(args.store).map((session) => ({ root: args.store, session }))
      : [{ root: target.store ?? args.store, session: target.session }];
  if (targets.length === 0) fail("VALIDATION", "broadcast has no known inboxes yet.");
  for (const t of targets) {
    if (unread(loadInbox(t.root, t.session)).length >= INBOX_MAX) {
      fail("VALIDATION", `recipient inbox is full (${INBOX_MAX} unread).`);
    }
  }
  const fromAlias = aliasFor(args.store, from);
  for (const t of targets) {
    mkdirSync(t.root, { recursive: true });
    appendFileSync(
      join(t.root, safeFile(t.session)),
      formatLine({ ...message, to: t.session, ...(fromAlias === undefined ? {} : { fromAlias }) }) + "\n",
    );
  }
  console.log(`sent ${message.id} to ${to} (${targets.length} inbox(es))`);
}

function printMessage(m) {
  return `${formatHead(m)}\n${m.body}`;
}

function cmdRead(args) {
  const from = identity(args);
  const messages = loadInbox(args.store, from);
  const pending = unread(messages).slice(0, 20);
  if (pending.length === 0) {
    console.log("Mailbox: empty.");
    return;
  }
  saveInbox(
    args.store,
    from,
    markStatus(
      messages,
      pending.map((m) => m.id),
      "read",
    ),
  );
  console.log(pending.map(printMessage).join("\n---\n"));
}

function cmdAlias(args, positional) {
  const alias = (positional[0] ?? "").trim().toLowerCase();
  if (!validAlias(alias)) fail("VALIDATION", "use [a-z0-9_-], max 32 chars, start alnum.");
  const from = identity(args);
  mkdirSync(args.store, { recursive: true });
  const claimed = claimAlias(readAliases(args.store), alias, from);
  if (!claimed.ok) {
    fail("VALIDATION", `alias ${JSON.stringify(alias)} is owned by another session and cannot be claimed.`);
  }
  writeFileSync(join(args.store, "aliases.json"), JSON.stringify(claimed.aliases, null, 2));
  console.log(`alias ${JSON.stringify(alias)} -> ${from}`);
}

function cmdSessions(args) {
  const root = args.store;
  const entries = listInboxes(root);
  const now = Date.now();
  const aliases = readAliases(root);
  const names = new Map(Object.entries(aliases).map(([a, id]) => [id, a]));
  console.log(`store ${root}:`);
  for (const id of entries) {
    let fresh = false;
    try {
      fresh = isRecentlyActive(statSync(join(root, `${id}.jsonl`)).mtimeMs, now);
    } catch {
      // Unreadable: stale.
    }
    const pending = unread(loadInbox(root, id)).length;
    console.log(`  ${id}${names.get(id) ? ` (alias: ${names.get(id)})` : ""} unread=${pending}${fresh ? " active" : ""}`);
  }
}

function childOutput(error) {
  if (error === null || typeof error !== "object") return "";
  const out = error.stdout ?? "";
  const err = error.stderr ?? "";
  return String(out) + String(err);
}

function cmdSelftest() {
  const root = join(tmpdir(), `mailbox-selftest-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const probe = {
    id: "t1",
    from: "a",
    to: "b",
    ts: new Date().toISOString(),
    kind: "note",
    priority: "standard",
    body: "hi",
    status: "queued",
  };
  if (parseLine(formatLine(probe))?.body !== "hi") fail("INTERNAL", "JSONL round-trip broken.");
  const req = buildMessage("a", { to: "b", kind: "request", body: "q?" }, "r1", new Date().toISOString());
  appendFileSync(join(root, safeFile("b")), formatLine(req) + "\n");
  const rep = buildMessage("b", { to: "a", kind: "reply", body: "a!", replyTo: "r1" }, "r2", new Date().toISOString());
  appendFileSync(join(root, safeFile("a")), formatLine(rep) + "\n");
  const found = findReply(unread(loadInbox(root, "a")), "r1");
  if (found?.body !== "a!") fail("INTERNAL", "request/reply correlation broken.");
  if (!isRecentlyActive(Date.now(), Date.now()) || isRecentlyActive(Date.now() - 3600_000, Date.now())) {
    fail("INTERNAL", "recency window broken.");
  }
  const env = { ...process.env, MAILBOX_STORE: root, MAILBOX_SESSION: "a" };
  const out = execSync(`node "${process.argv[1]}" read`, { encoding: "utf-8", env });
  if (!out.includes("a!")) fail("INTERNAL", "CLI read path broken.");
  // Issue #380: stores are isolated. An alias registered in another store is
  // invisible here: resolving, sending, reading, and listing stay inside the
  // repo-scoped store.
  const other = join(tmpdir(), `mailbox-selftest-other-${randomUUID()}`);
  mkdirSync(other, { recursive: true });
  execSync(`node "${process.argv[1]}" alias intruder`, {
    encoding: "utf-8",
    env: { ...process.env, MAILBOX_STORE: other, MAILBOX_SESSION: "spy" },
  });
  try {
    execSync(`node "${process.argv[1]}" send --to intruder --body probe`, { encoding: "utf-8", env });
    fail("INTERNAL", "cross-store send succeeded; stores are not isolated.");
  } catch (error) {
    if (!/unknown recipient/.test(childOutput(error))) fail("INTERNAL", "cross-store send failed for the wrong reason.");
  }
  const listing = execSync(`node "${process.argv[1]}" sessions`, { encoding: "utf-8", env });
  if (listing.includes(other) || listing.includes("spy")) fail("INTERNAL", "sessions leaks other stores.");
  // Issue #380: the default store key is repo-specific. Two fresh repos must
  // resolve different stores (the old dirname(".git") collapse shared one).
  const cleanEnv = { ...process.env };
  delete cleanEnv.MAILBOX_STORE;
  try {
    execSync("git --version", { stdio: "ignore" });
  } catch {
    fail("INTERNAL", "selftest needs git for the repo-isolation check.");
  }
  const repoA = mkdtempSync(join(tmpdir(), "mailbox-repo-a-"));
  const repoB = mkdtempSync(join(tmpdir(), "mailbox-repo-b-"));
  execSync("git init -q", { cwd: repoA });
  execSync("git init -q", { cwd: repoB });
  const storeA = execSync(`node "${process.argv[1]}" store`, { encoding: "utf-8", cwd: repoA, env: cleanEnv }).trim();
  const storeB = execSync(`node "${process.argv[1]}" store`, { encoding: "utf-8", cwd: repoB, env: cleanEnv }).trim();
  if (storeA === storeB) fail("INTERNAL", "default store is not repo-specific.");
  // Issue #382: alias claims reject hijacks within the same store.
  execSync(`node "${process.argv[1]}" alias owner`, {
    encoding: "utf-8",
    env: { ...process.env, MAILBOX_STORE: root, MAILBOX_SESSION: "owner" },
  });
  try {
    execSync(`node "${process.argv[1]}" alias owner`, {
      encoding: "utf-8",
      env: { ...process.env, MAILBOX_STORE: root, MAILBOX_SESSION: "spy" },
    });
    fail("INTERNAL", "alias hijack succeeded.");
  } catch (error) {
    if (!/owned by another session/.test(childOutput(error))) {
      fail("INTERNAL", "alias hijack failed for the wrong reason.");
    }
  }
  console.log("selftest OK");
}

function parseArgv(argv) {
  const args = { store: defaultStore() };
  const positional = [];
  const rest = {};
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === "--store") args.store = argv[++i];
    else if (token === "--as") args.as = argv[++i];
    else if (token === "--all") rest["all"] = true;
    else if (token.startsWith("--")) {
      const key = token.slice(2);
      rest[key] = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else positional.push(token);
    i++;
  }
  return { args, positional, rest };
}

const [command, ...argv] = process.argv.slice(2);
try {
  const { args, positional, rest } = parseArgv(argv);
  if (command === "send") cmdSend(args, rest);
  else if (command === "read") cmdRead(args);
  else if (command === "alias") cmdAlias(args, positional);
  else if (command === "sessions") cmdSessions(args);
  else if (command === "selftest") cmdSelftest();
  else if (command === "store") console.log(args.store);
  else {
    console.log(`usage: mailbox-cli [--store DIR] [--as SESSION] <send|read|alias|sessions|selftest|store> [options]
  send --to <alias|session|*> --body <text> [--kind note|steer|request|reply] [--priority standard|high] [--subject S] [--reply-to ID]
  read [--all]            unread oldest-first, marks read (repo-scoped; --all stays in this store)
  alias <name>            register alias for your session (rejects aliases owned by another session)
  sessions                known inboxes in this repo store
  selftest                temp-dir roundtrip for CI (incl. store-isolation checks)
  store                   print resolved default store
identity: --as or $MAILBOX_SESSION (caller-asserted, repo-store-local). store: --store or $MAILBOX_STORE, else stable git-derived key.
needs Node 22.18+ (imports erasable-syntax .ts directly).`);
    process.exit(command === undefined ? 0 : 2);
  }
} catch (error) {
  if (error instanceof MailboxFault) fail("VALIDATION", `${error.code}: ${error.message}`);
  fail("INTERNAL", error instanceof Error ? error.message : String(error));
}
