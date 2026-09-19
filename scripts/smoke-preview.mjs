// SPDX-License-Identifier: AGPL-3.0
// Preview smoke probe (ADR 004): exercise system.smoke against a deployed
// Worker (e.g. a PR preview) over plain HTTPS. Discovers the smoke Saga ID
// from /api/sagas, so no IDs are hard-coded. Counts/IDs/statuses only —
// never logs the bearer token, headers, or bodies.
const TERMINAL = ["Succeeded", "Failed", "TimedOut", "Cancelled"];

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON but got HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
}

export async function runSmoke({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  pollMs = 2000,
  timeoutMs = 180000,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  keyPrefix = "preview-smoke",
}) {
  // Issue #357: the bearer token rides every probe request, so the target
  // must be https (loopback http is allowed for local runs). Fail closed
  // before the token leaves the machine.
  let target;
  try {
    target = new URL(baseUrl);
  } catch {
    throw new Error(`Preview base must be an https URL, got ${JSON.stringify(baseUrl)}.`);
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error(`Preview base must be an http(s) URL, got ${JSON.stringify(baseUrl)}.`);
  }
  if (target.protocol === "http:") {
    const host = target.hostname.toLowerCase();
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    if (!loopback) throw new Error(`Preview base over plaintext http is loopback-only; use https.`);
  }
  if (target.username !== "" || target.password !== "") {
    throw new Error("Preview base must not embed credentials (pass --token).");
  }
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const catalogRes = await fetchImpl(`${base}/api/sagas`, { headers, redirect: "manual" });
  if (!catalogRes.ok) throw new Error(`Saga catalog fetch failed: HTTP ${catalogRes.status}`);
  const catalog = await readJson(catalogRes);
  const saga = (catalog.sagas ?? []).find((entry) => entry.name === "system.smoke");
  if (!saga) throw new Error("system.smoke is not in the deployed catalog.");

  const submitRes = await fetchImpl(`${base}/api/executions`, {
    method: "POST",
    redirect: "manual",
    headers: { ...headers, "Idempotency-Key": `${keyPrefix}-${crypto.randomUUID()}` },
    body: JSON.stringify({ sagaId: saga.id, input: {} }),
  });
  if (submitRes.status !== 202 && submitRes.status !== 200) {
    throw new Error(`Execution submit failed: HTTP ${submitRes.status}`);
  }
  const { executionId } = await readJson(submitRes);
  if (typeof executionId !== "string" || executionId.length === 0) {
    throw new Error("Execution submit returned no executionId.");
  }

  const deadline = now() + timeoutMs;
  for (;;) {
    const detailRes = await fetchImpl(`${base}/api/executions/${executionId}`, { headers, redirect: "manual" });
    if (!detailRes.ok) throw new Error(`Execution detail fetch failed: HTTP ${detailRes.status}`);
    const detail = await readJson(detailRes);
    if (TERMINAL.includes(detail.status)) {
      if (detail.status !== "Succeeded") {
        throw new Error(`Smoke ended ${detail.status}: ${JSON.stringify(detail.error ?? null)}`);
      }
      const failed = (detail.operations ?? []).filter((op) => op.status !== "Succeeded");
      if (failed.length > 0) throw new Error(`Smoke operations not all Succeeded: ${failed.length} failed.`);
      return { executionId, operations: (detail.operations ?? []).length };
    }
    if (now() >= deadline) throw new Error(`Timed out waiting for ${executionId} to settle.`);
    await sleep(pollMs);
  }
}

// Issue #227: artifact byte-path probe. Uploads one small disposable blob
// under a random per-run name (last-wins preview is shared across PRs, so
// the name must never collide), reads it back byte-for-byte, then deletes
// it. Runs as the same Bearer [REDACTED] caller that creates the row, so the
// creator-or-admin canonical gate covers upload, download, and delete with
// no admin grant. A 503 ARTIFACT_STORE_NOT_CONFIGURED surfaces as an
// explicit metadata-only error naming the missing binding — never a silent
// pass — so a preview without the ARTIFACTS bucket fails loudly here
// instead of pretending byte routes were exercised.
export async function runArtifactProbe({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  keyPrefix = "preview-artifact-probe",
  bytes = null,
}) {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}` };
  const name = `${keyPrefix}-${crypto.randomUUID()}.txt`;
  const payload = bytes ?? new TextEncoder().encode(`wrangnarok preview probe ${name}\n`);

  const uploadRes = await fetchImpl(`${base}/api/artifacts?name=${encodeURIComponent(name)}&mime=text/plain`, {
    method: "PUT",
    redirect: "manual",
    headers: { ...headers, "Content-Type": "application/octet-stream" },
    body: payload,
  });
  if (uploadRes.status === 503) {
    const detail = await uploadRes.text().catch(() => "");
    if (detail.includes("ARTIFACT_STORE_NOT_CONFIGURED")) {
      throw new Error("Artifact probe failed: preview is metadata-only (ARTIFACTS bucket not bound).");
    }
    throw new Error(`Artifact upload failed: HTTP 503`);
  }
  if (uploadRes.status !== 201 && uploadRes.status !== 200) {
    throw new Error(`Artifact upload failed: HTTP ${uploadRes.status}`);
  }
  const uploaded = await readJson(uploadRes);
  const artifactId = uploaded?.artifact?.id;
  if (typeof artifactId !== "string" || artifactId.length === 0) {
    throw new Error("Artifact upload returned no artifact id.");
  }

  // Cleanup always runs; a delete failure never masks a download failure.
  let downloadError = null;
  try {
    const downloadRes = await fetchImpl(`${base}/api/artifacts/${artifactId}/download`, {
      headers,
      redirect: "manual",
    });
    if (!downloadRes.ok) throw new Error(`Artifact download failed: HTTP ${downloadRes.status}`);
    const received = new Uint8Array(await downloadRes.arrayBuffer());
    const expected = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const same = received.length === expected.length && received.every((byte, i) => byte === expected[i]);
    if (!same) throw new Error("Artifact download bytes differ from upload bytes.");
  } catch (error) {
    downloadError = error;
  }
  const deleteRes = await fetchImpl(`${base}/api/artifacts/${artifactId}`, {
    method: "DELETE",
    headers,
    redirect: "manual",
  });
  if (!deleteRes.ok) throw new Error(`Artifact cleanup delete failed: HTTP ${deleteRes.status}`);
  if (downloadError) throw downloadError;
  return { artifactId, name };
}

function stubFetch(scenarios) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = scenarios.shift();
      if (!next) throw new Error(`Unexpected fetch: ${url}`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function selftest() {
  let passed = 0;
  const check = (name, cond) => {
    if (!cond) throw new Error(`selftest failed: ${name}`);
    passed += 1;
  };

  // Happy path: catalog, submit, running, succeeded.
  {
    const stub = stubFetch([
      jsonResponse({ sagas: [{ id: "saga-id", name: "system.smoke" }] }),
      jsonResponse({ executionId: "exec-1" }, 202),
      jsonResponse({ status: "Running", operations: [] }),
      jsonResponse({
        status: "Succeeded",
        operations: [{ name: "prepare-input-v1", status: "Succeeded" }],
      }),
    ]);
    const result = await runSmoke({
      baseUrl: "https://preview.test",
      token: "tok",
      fetchImpl: stub.fetch,
      pollMs: 0,
      sleep: async () => {},
    });
    check("happy execution id", result.executionId === "exec-1");
    check("happy operations", result.operations === 1);
    check(
      "idempotency key sent",
      String(stub.calls[1]?.init?.headers?.["Idempotency-Key"] ?? "").startsWith("preview-smoke-"),
    );
  }

  // Missing saga in catalog.
  {
    const stub = stubFetch([jsonResponse({ sagas: [] })]);
    let error = null;
    try {
      await runSmoke({ baseUrl: "https://preview.test", token: "tok", fetchImpl: stub.fetch });
    } catch (e) {
      error = e;
    }
    check("missing saga throws", /system\.smoke/.test(String(error)));
  }

  // Rejected submit.
  {
    const stub = stubFetch([
      jsonResponse({ sagas: [{ id: "saga-id", name: "system.smoke" }] }),
      new Response("bad", { status: 500 }),
    ]);
    let error = null;
    try {
      await runSmoke({ baseUrl: "https://preview.test", token: "tok", fetchImpl: stub.fetch });
    } catch (e) {
      error = e;
    }
    check("rejected submit throws", /HTTP 500/.test(String(error)));
  }

  // Terminal failure surfaces the code, not the body.
  {
    const stub = stubFetch([
      jsonResponse({ sagas: [{ id: "saga-id", name: "system.smoke" }] }),
      jsonResponse({ executionId: "exec-2" }, 202),
      jsonResponse({ status: "Failed", error: { code: "EXECUTION_FAILED" } }),
    ]);
    let error = null;
    try {
      await runSmoke({ baseUrl: "https://preview.test", token: "tok", fetchImpl: stub.fetch });
    } catch (e) {
      error = e;
    }
    check("failed execution throws", /Failed/.test(String(error)));
  }

  // Non-succeeded operation fails the probe.
  {
    const stub = stubFetch([
      jsonResponse({ sagas: [{ id: "saga-id", name: "system.smoke" }] }),
      jsonResponse({ executionId: "exec-3" }, 202),
      jsonResponse({ status: "Succeeded", operations: [{ name: "x", status: "Failed" }] }),
    ]);
    let error = null;
    try {
      await runSmoke({ baseUrl: "https://preview.test", token: "tok", fetchImpl: stub.fetch });
    } catch (e) {
      error = e;
    }
    check("failed operation throws", /not all Succeeded/.test(String(error)));
  }

  // Never-settling execution hits the deadline.
  {
    const stub = stubFetch([
      jsonResponse({ sagas: [{ id: "saga-id", name: "system.smoke" }] }),
      jsonResponse({ executionId: "exec-4" }, 202),
      jsonResponse({ status: "Running", operations: [] }),
      jsonResponse({ status: "Running", operations: [] }),
    ]);
    let error = null;
    try {
      await runSmoke({
        baseUrl: "https://preview.test",
        token: "tok",
        fetchImpl: stub.fetch,
        pollMs: 0,
        timeoutMs: 0,
        sleep: async () => {},
      });
    } catch (e) {
      error = e;
    }
    check("deadline throws", /Timed out/.test(String(error)));
  }

  // Issue #357: plaintext non-loopback bases fail before any fetch; the
  // bearer token never leaves the machine. Loopback http stays usable.
  {
    const stub = stubFetch([]);
    let error = null;
    try {
      await runSmoke({ baseUrl: "http://192.168.1.10:8787", token: "tok", fetchImpl: stub.fetch });
    } catch (e) {
      error = e;
    }
    check("plaintext base throws", /loopback-only/.test(String(error)) && stub.calls.length === 0);
  }
  {
    const stub = stubFetch([
      jsonResponse({ sagas: [{ id: "saga-id", name: "system.smoke" }] }),
      jsonResponse({ executionId: "exec-5" }, 202),
      jsonResponse({ status: "Succeeded", operations: [] }),
    ]);
    const result = await runSmoke({
      baseUrl: "http://127.0.0.1:8903",
      token: "tok",
      fetchImpl: stub.fetch,
      pollMs: 0,
      sleep: async () => {},
    });
    check("loopback http ok", result.executionId === "exec-5");
    check(
      "redirect manual",
      stub.calls.every((call) => call.init?.redirect === "manual"),
    );
  }

  // Issue #227: artifact probe happy path — upload, byte-identical
  // download, cleanup delete.
  {
    const sent = new TextEncoder().encode("probe-bytes-123");
    const stub = stubFetch([
      jsonResponse({ artifact: { id: "11111111-1111-4111-8111-111111111111" } }, 201),
      new Response(sent, { status: 200 }),
      jsonResponse({ deleted: true }),
    ]);
    const result = await runArtifactProbe({
      baseUrl: "https://preview.test",
      token: "tok",
      fetchImpl: stub.fetch,
      bytes: sent,
    });
    check("probe artifact id", result.artifactId === "11111111-1111-4111-8111-111111111111");
    check("probe three calls", stub.calls.length === 3);
    check("probe upload octet-stream", stub.calls[0]?.init?.headers?.["Content-Type"] === "application/octet-stream");
    check("probe delete method", stub.calls[2]?.init?.method === "DELETE");
  }

  // Issue #227: unbound ARTIFACTS bucket fails loudly as metadata-only —
  // no silent pass, no further calls.
  {
    const stub = stubFetch([
      new Response(JSON.stringify({ error: { code: "ARTIFACT_STORE_NOT_CONFIGURED" } }), { status: 503 }),
    ]);
    let error = null;
    try {
      await runArtifactProbe({ baseUrl: "https://preview.test", token: "tok", fetchImpl: stub.fetch });
    } catch (e) {
      error = e;
    }
    check("metadata-only throws", /metadata-only/.test(String(error)) && stub.calls.length === 1);
  }

  // Issue #227: byte mismatch fails, but the cleanup delete still runs.
  {
    const stub = stubFetch([
      jsonResponse({ artifact: { id: "22222222-2222-4222-8222-222222222222" } }, 201),
      new Response(new TextEncoder().encode("wrong-bytes"), { status: 200 }),
      jsonResponse({ deleted: true }),
    ]);
    let error = null;
    try {
      await runArtifactProbe({
        baseUrl: "https://preview.test",
        token: "tok",
        fetchImpl: stub.fetch,
        bytes: new TextEncoder().encode("right-bytes"),
      });
    } catch (e) {
      error = e;
    }
    check("byte mismatch throws", /differ/.test(String(error)) && stub.calls.length === 3);
  }

  console.log(`preview smoke selftest: ${passed} passed.`);
}

const invokedAsCli = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (invokedAsCli) {
  const mode = process.argv[2];
  if (mode === "selftest") {
    await selftest();
  } else {
    const baseUrl = arg("base-url", "");
    const token = arg("token", "");
    if (!baseUrl || !token) {
      console.error("Usage: node scripts/smoke-preview.mjs --base-url URL --token TOKEN | selftest");
      process.exitCode = 2;
    } else {
      try {
        const result = await runSmoke({ baseUrl, token });
        console.log(`preview smoke passed: ${result.executionId} (${result.operations} operations).`);
        // Issue #227: exercise the preview ARTIFACTS byte path (upload →
        // read back → delete) under a random per-run name, then report the
        // disposable name so a failure can be correlated to leftover rows.
        const probe = await runArtifactProbe({ baseUrl, token });
        console.log(`preview artifact probe passed: ${probe.name} (${probe.artifactId}).`);
      } catch (error) {
        console.error(`preview smoke failed: ${error instanceof Error ? error.message : error}`);
        process.exitCode = 1;
      }
    }
  }
}
