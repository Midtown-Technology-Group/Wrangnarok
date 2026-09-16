// SPDX-License-Identifier: AGPL-3.0
// Mint the least-privilege CI child token for PR preview deploys (ADR 004).
//
// A parent token with `API Tokens Write` (plus the groups below, since a
// child can never exceed its parent) mints a scoped child via
// POST /user/tokens. Human-run, once per rotation: the parent lives only on
// the operator's machine and is never printed, logged, or committed. The
// child value prints ONCE — store it as the CLOUDFLARE_PREVIEW_TOKEN GitHub
// secret, then delete the parent token (or keep it offline for rotation).
//
// Issue #376 (trust boundary): the preview workflow runs PR-controlled code
// (merge revision + PR dependency tree) with this token in the environment,
// so a malicious same-repo PR could exfiltrate it. REQUIREMENTS:
//   1. Mint the parent in a DEDICATED preview-only Cloudflare account that
//      holds no production Workers, no production D1 data, and no other
//      account tokens. Theft from that account cannot reach production.
//   2. Keep the default 30-day expiry (override with --expires-days only
//      for a documented reason): rotation bounds the theft window.
//   3. A manual approval gate before preview deploy remains a steward
//      follow-up; until then, review same-repo PRs before CI runs them.
//
// Permission group IDs resolve by name at runtime (no opaque IDs baked in).
// `selftest` exercises payload construction with fixtures and touches no
// network. `--dry-run` resolves live groups but skips the POST.
const API_BASE = "https://api.cloudflare.com/client/v4";

// Account groups the preview deploy needs: script upload (deploy, secret
// put) plus D1 migrations. No routes (workers.dev only), no KV/R2.
const REQUIRED_GROUPS = ["Workers Scripts Write", "D1 Write"];
const FALLBACK_GROUPS = { "Workers Scripts Write": "Workers Scripts Edit", "D1 Write": "D1 Edit" };

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

export function buildTokenPayload({ name, accountId, groups, expiresOn }) {
  return {
    name,
    policies: [
      {
        effect: "allow",
        resources: { "com.cloudflare.api.account": accountId },
        permission_groups: groups.map((group) => ({ id: group.id })),
      },
    ],
    expires_on: expiresOn,
  };
}

export function resolveGroups(available, required = REQUIRED_GROUPS) {
  const byName = new Map(available.map((group) => [group.name, group]));
  return required.map((name) => {
    const direct = byName.get(name);
    if (direct) return direct;
    const fallback = byName.get(FALLBACK_GROUPS[name] ?? "");
    if (fallback) return fallback;
    throw new Error(`Permission group not found: "${name}" (nor legacy "${FALLBACK_GROUPS[name] ?? "?"}").`);
  });
}

async function api(token, path, init = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await response.json();
  if (!response.ok || body.success !== true) {
    const first = (body.errors ?? [])[0];
    throw new Error(`Cloudflare API ${path} failed: HTTP ${response.status} ${first?.message ?? "unknown error"}`);
  }
  return body.result;
}

async function selftest() {
  let passed = 0;
  const check = (name, cond) => {
    if (!cond) throw new Error(`selftest failed: ${name}`);
    passed += 1;
  };
  const groups = [
    { id: "aaa", name: "Workers Scripts Write" },
    { id: "bbb", name: "D1 Write" },
  ];
  check(
    "direct resolve",
    resolveGroups(groups)
      .map((g) => g.id)
      .join(",") === "aaa,bbb",
  );
  check("legacy fallback", resolveGroups([{ id: "ccc", name: "D1 Edit" }], ["D1 Write"])[0]?.id === "ccc");
  let missing = null;
  try {
    resolveGroups([], ["Workers Scripts Write"]);
  } catch (e) {
    missing = e;
  }
  check("missing group throws", /not found/.test(String(missing)));
  const payload = buildTokenPayload({
    name: "wrangnarok-preview",
    accountId: "acct",
    groups,
    expiresOn: "2027-01-01T00:00:00Z",
  });
  check("policy effect", payload.policies[0]?.effect === "allow");
  check("account scope", payload.policies[0]?.resources["com.cloudflare.api.account"] === "acct");
  check("group ids", JSON.stringify(payload.policies[0]?.permission_groups) === '[{"id":"aaa"},{"id":"bbb"}]');
  check("expiry", payload.expires_on === "2027-01-01T00:00:00Z");
  check("no token in payload", !JSON.stringify(payload).includes("parent"));
  console.log(`preview token selftest: ${passed} passed.`);
}

const invokedAsCli = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (invokedAsCli) {
  const mode = process.argv[2];
  if (mode === "selftest") {
    await selftest();
  } else {
    const accountId = arg("account-id", process.env.CLOUDFLARE_ACCOUNT_ID ?? "");
    const name = arg("name", "wrangnarok-preview-deploy");
    const expiresDays = Number(arg("expires-days", "30"));
    const dryRun = process.argv.includes("--dry-run");
    const parent = process.env.CLOUDFLARE_API_TOKEN ?? "";
    if (!accountId || !parent || !Number.isFinite(expiresDays) || expiresDays <= 0) {
      console.error(
        "Usage: CLOUDFLARE_API_TOKEN=<parent> node scripts/mint-preview-token.mjs --account-id ACCT [--name N] [--expires-days N] [--dry-run]",
      );
      process.exitCode = 2;
    } else {
      try {
        const available = await api(parent, "/user/tokens/permission_groups");
        const groups = resolveGroups(available);
        const expiresOn = new Date(Date.now() + expiresDays * 86400000).toISOString().replace(/\.\d+Z$/, "Z");
        const payload = buildTokenPayload({ name, accountId, groups, expiresOn });
        if (dryRun) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          const created = await api(parent, "/user/tokens", { method: "POST", body: JSON.stringify(payload) });
          console.log(`Created token "${created.name}" (id ${created.id}), expires ${created.expires_on}.`);
          console.log("Store the value below as the CLOUDFLARE_PREVIEW_TOKEN GitHub secret. It prints ONCE:");
          console.log(created.value);
          console.log("Then delete the parent token unless you keep it offline for rotation.");
        }
      } catch (error) {
        console.error(`Token mint failed: ${error instanceof Error ? error.message : error}`);
        process.exitCode = 1;
      }
    }
  }
}
