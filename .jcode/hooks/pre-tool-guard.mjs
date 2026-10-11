// SPDX-License-Identifier: AGPL-3.0
// jcode pre_tool gate: block production-touching Wrangler commands.
// Local-first per AGENTS.md: deploys stay dry-run, D1 stays --local.
// Exit 0 = allow, exit 2 = block (stderr becomes the tool error).
//
// Issue #375: the old whole-command regexes (`/--dry-run/` anywhere in the
// shell line) were bypassable with `echo --dry-run && wrangler deploy ...`.
// This version splits the command into segments on shell operators and
// validates EACH wrangler invocation's own argv fail-closed. Anything it
// cannot parse (quoted operators, command substitution in a wrangler
// segment, npx/pnpm/yarn/bun -e wrappers) blocks rather than allows.
import { readFileSync } from "node:fs";

const tool = process.env.JCODE_HOOK_TOOL_NAME ?? "";

function readInput() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return process.env.JCODE_HOOK_TOOL_INPUT ?? "";
  }
}

const input = readInput();

function block(reason) {
  process.stderr.write(`blocked by wrangnarok pre_tool guard: ${reason}\n`);
  process.exit(2);
}

function bashCommand(raw) {
  try {
    return String(JSON.parse(raw).command ?? "");
  } catch {
    return String(raw);
  }
}

function toolFilePath(raw) {
  try {
    const body = JSON.parse(raw);
    return String(body.file_path ?? body.filePath ?? "");
  } catch {
    return "";
  }
}

// Split a shell command line into segments on unquoted | & ; operators and
// newlines (a newline always ends a shell command, even unquoted).
// Returns null when quoting cannot be resolved (fail closed by the caller).
export function splitSegments(cmd) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      else if (ch === "\\" && i + 1 < cmd.length) {
        current += cmd[i + 1];
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      current += ch + cmd[i + 1];
      i += 1;
      continue;
    }
    if (ch === "|" || ch === "&" || ch === ";" || ch === "\n") {
      segments.push(current);
      current = "";
      // Collapse && and || into one boundary.
      if ((ch === "|" || ch === "&") && cmd[i + 1] === ch) i += 1;
      continue;
    }
    current += ch;
  }
  if (quote !== null) return null;
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

// Tokenize one segment on whitespace honoring single/double quotes.
// Returns null on unbalanced quotes or dynamic constructs the guard cannot
// see through (backticks, $() subshells, ${} expansions, glob stars).
export function tokenize(segment) {
  if (/`/.test(segment) || /\$/.test(segment) || /(^|\s)\*/.test(segment)) return null;
  const tokens = [];
  let current = "";
  let quote = null;
  let inToken = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
        current += segment[i + 1];
        i += 1;
      } else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      current += segment[i + 1];
      inToken = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote !== null) return null;
  if (inToken) tokens.push(current);
  return tokens;
}

function assignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(token));
}

function wranglerBinary(token) {
  const bin = String(token ?? "").toLowerCase();
  return bin === "wrangler" || bin === "wranglerjs" || bin.endsWith("/wrangler") || bin.endsWith("/wranglerjs");
}

function quotedShellWrapper(tokens, segment) {
  const command = String(tokens[0] ?? "")
    .toLowerCase()
    .split(/[\\/]/)
    .at(-1);
  const shell = ["bash", "dash", "ksh", "sh", "zsh"].includes(command ?? "");
  const commandString = shell && tokens.slice(1).some((token) => /^-[a-z]*c[a-z]*$/i.test(String(token)));
  return (command === "eval" || commandString) && /\bwrangler(js)?\b/i.test(segment);
}

// Locate the wrangler argv inside one segment's tokens: leading shell
// assignments, an optional `command` or `env` prefix, and an optional
// package-manager runner precede the Wrangler binary. Unsupported wrappers
// are rejected by checkBash when they still contain a literal Wrangler
// binary, rather than silently falling outside this parser.
export function wranglerArgv(tokens) {
  let i = 0;
  while (i < tokens.length && assignment(tokens[i])) i += 1;

  if (String(tokens[i] ?? "").toLowerCase() === "command") {
    i += 1;
    while (tokens[i] === "-p" || tokens[i] === "--") i += 1;
  }

  const env = String(tokens[i] ?? "").toLowerCase();
  if (env === "env" || env.endsWith("/env")) {
    i += 1;
    while (tokens[i] === "-i" || tokens[i] === "--ignore-environment" || tokens[i] === "--") i += 1;
    while (i < tokens.length && assignment(tokens[i])) i += 1;
  }

  const runner = String(tokens[i] ?? "").toLowerCase();
  if (["npx", "pnpx", "pnpm", "yarn", "bun"].includes(runner)) {
    i += 1;
    // Skip runner flags and their values (-y, --yes, -p PKG, --package PKG).
    while (i < tokens.length && tokens[i].startsWith("-")) {
      if ((tokens[i] === "-p" || tokens[i] === "--package") && i + 1 < tokens.length) i += 2;
      else i += 1;
    }
  }
  if (!wranglerBinary(tokens[i])) return null;
  return tokens.slice(i + 1);
}

function hasFlag(argv, name) {
  return argv.some((t) => t === name || t.startsWith(`${name}=`));
}

function checkWranglerArgv(argv) {
  const [sub, ...rest] = argv;
  const lower = String(sub ?? "").toLowerCase();
  if (lower === "deploy") {
    if (!hasFlag(rest, "--dry-run")) {
      block("wrangler deploy without --dry-run on that invocation (production deploys need explicit human approval).");
    }
    return;
  }
  if (lower === "d1") {
    if (!hasFlag(rest, "--local")) {
      block("wrangler d1 without --local on that invocation (remote D1 writes need explicit human approval).");
    }
    return;
  }
  if (lower === "secret") {
    block("wrangler secret from agent sessions (human runs secret writes).");
    return;
  }
  if (lower === "versions" && rest[0] !== undefined && String(rest[0]).toLowerCase() === "deploy") {
    block("wrangler versions deploy from agent sessions (production deploy needs explicit human approval).");
    return;
  }
  if (lower === "pages" && rest.some((t) => String(t).toLowerCase() === "deploy")) {
    block("wrangler pages deploy from agent sessions (production deploy needs explicit human approval).");
    return;
  }
  if (lower === "deployment" || lower === "deployments") {
    block(`wrangler ${lower} from agent sessions (production deploy needs explicit human approval).`);
    return;
  }
  if (lower === "delete" || lower === "rollback" || lower === "triggers") {
    block(`wrangler ${lower} from agent sessions (mutating remote command needs explicit human approval).`);
    return;
  }
  if (lower === "kv" || lower === "r2" || lower === "queues" || lower === "vectorize" || lower === "hyperdrive") {
    const mutating = rest.some((t) => /^(put|delete|create|update|send|publish|add|remove)/i.test(t));
    if (mutating || lower !== "kv") {
      block(`wrangler ${lower} ${rest[0] ?? ""} from agent sessions (remote writes need explicit human approval).`);
    }
    return;
  }
  // Unknown subcommands pass: the gate is a production-touch blocklist, and
  // unrecognized read-only surface (dev, tail, pages, whoami, --help) stays
  // usable. Dynamic argv the tokenizer cannot see was already blocked above.
}

function checkBash(cmd) {
  // npm/pnpm run scripts can hide arbitrary wrangler invocations behind a
  // package.json indirection the guard cannot see through: fail closed and
  // point at the explicit binary instead.
  if (/(^|\s)(npm|pnpm|yarn|bun)\s+run\b/.test(cmd)) {
    block("package-manager run scripts can hide wrangler invocations; call the wrangler binary directly.");
  }
  const segments = splitSegments(cmd);
  if (segments === null) block("unparseable shell quoting (fail closed; simplify the command).");
  for (const segment of segments) {
    const tokens = tokenize(segment);
    if (tokens === null) {
      // Dynamic constructs are only dangerous next to wrangler; plain
      // `echo $(...)` and friends stay allowed. Check the raw segment for a
      // wrangler mention before blocking.
      if (/(^|[\s;"'`])(npx\s+)?wrangler(js)?\b/i.test(` ${segment}`)) {
        block("dynamic shell constructs in a wrangler invocation (fail closed; use literal argv).");
      }
      continue;
    }
    const argv = wranglerArgv(tokens);
    if (argv !== null) {
      checkWranglerArgv(argv);
    } else if (tokens.some(wranglerBinary) || quotedShellWrapper(tokens, segment)) {
      block(
        "unsupported wrapper around a wrangler invocation (fail closed; use literal assignments, command, env, or a package runner).",
      );
    }
  }
}

if (tool === "bash") {
  checkBash(bashCommand(input));
}

if (tool === "write" || tool === "edit" || tool === "apply_patch") {
  const filePath = toolFilePath(input);
  // Local secret files are gitignored but must never gain committed credentials.
  if (/\.dev\.vars/.test(filePath)) {
    block(`writes to ${filePath} (local secret file; human manages it via npm run setup:local).`);
  }
}

// Guard selftest: `node .jcode/hooks/pre-tool-guard.mjs --selftest`.
// Spawns this file as a child with stub hook env (no stdin reads, no real
// tool calls) and asserts allow/block decisions per segment.
if (process.argv[2] === "--selftest") {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const self = fileURLToPath(new URL(import.meta.url));
  let passed = 0;
  const check = (name, cond) => {
    if (!cond) throw new Error(`guard selftest failed: ${name}`);
    passed += 1;
  };
  const run = (command) => {
    const child = spawnSync(process.execPath, [self], {
      encoding: "utf8",
      input: JSON.stringify({ command }),
      env: {
        ...process.env,
        JCODE_HOOK_TOOL_NAME: "bash",
        JCODE_HOOK_TOOL_INPUT: JSON.stringify({ command }),
      },
    });
    return { status: child.status, stderr: child.stderr ?? "" };
  };
  const allowed = (name, command) => {
    const r = run(command);
    check(`${name} allowed (exit ${r.status}: ${r.stderr.slice(0, 120)})`, r.status === 0);
  };
  const blocked = (name, command) => {
    const r = run(command);
    check(`${name} blocked (exit ${r.status})`, r.status === 2);
  };

  allowed("dry-run deploy", "wrangler deploy --dry-run --env dev");
  allowed("local d1", "wrangler d1 execute DB --local --command 'select 1'");
  allowed("second dry-run", "wrangler deploy --dry-run && wrangler d1 execute DB --local --command 'select 1'");
  allowed("quoted echo", "echo 'wrangler deploy' && wrangler deploy --dry-run");
  allowed("unrelated", "node scripts/seed-local.mjs --help");
  blocked("plain deploy", "wrangler deploy --env dev");
  blocked("flag smuggling", "echo --dry-run && wrangler deploy --env dev");
  blocked("local smuggling", "echo --local && wrangler d1 execute DB --remote");
  blocked("case smuggling", "WRANGLER DEPLOY --env dev");
  blocked("versions deploy", "wrangler versions deploy --env dev");
  blocked("secret put", "wrangler secret put LAB_TOKEN --env preview");
  blocked("secret list", "wrangler secret list --env preview");
  blocked("npm run indirection", "npm run deploy:preview");
  blocked("dynamic argv", "wrangler deploy $(echo --env dev)");
  blocked("rollback", "wrangler rollback --env dev");
  blocked("multiline deploy", "echo hi\nwrangler deploy --env dev");
  blocked("pages deploy", "wrangler pages deploy dist --branch main");
  allowed("pages list", "wrangler pages project list");
  allowed("multiline dry-run", "echo hi\nwrangler deploy --dry-run --env dev");
  allowed("command dry-run", "command wrangler deploy --dry-run --env dev");
  allowed("assignment local d1", "CF_ACCOUNT_ID=x wrangler d1 execute DB --local --command 'select 1'");
  allowed("env local d1", "env CF_ACCOUNT_ID=x wrangler d1 execute DB --local --command 'select 1'");
  blocked("command deploy", "command wrangler deploy --env dev");
  blocked("command path deploy", "command /usr/local/bin/wrangler deploy --env dev");
  blocked("assignment remote d1", "CF_ACCOUNT_ID=x wrangler d1 execute DB --remote --command 'DELETE FROM users'");
  blocked("env deploy", "/usr/bin/env CF_ACCOUNT_ID=x wrangler deploy --env dev");
  blocked("unsupported wrapper", "nice wrangler deploy --env dev");
  blocked("escaped binary", "wran\\gler deploy --env dev");
  blocked("quoted shell wrapper", "bash -lc 'wrangler deploy --env dev'");
  console.log(`guard selftest: ${passed} passed.`);
  process.exit(0);
}

process.exit(0);
