// SPDX-License-Identifier: AGPL-3.0
// Proof-stack vendor fault branches (issue #262): every Integration Action
// maps transport faults onto its fixed-shape taxonomy and never leaks
// bodies, URLs, or credentials. Direct Action calls with intercepted fetch —
// no D1, no Workflow bindings.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Fault } from "../src/domain";
import { addAdUserToGroups, createAdUser, provisionAdMailbox } from "../src/integrations/ad";
import { addGoogleUserToGroups, createGoogleUser, provisionGoogleMailbox } from "../src/integrations/googleworkspace";
import {
  addGraphUserToGroups,
  assignGraphLicense,
  createGraphUser,
  provisionGraphMailbox,
} from "../src/integrations/graph";
const GRAPH = "https://graph-in-test.invalid";
const GOOGLE = "https://google-in-test.invalid";
const NINJA = "https://ninja-in-test.invalid/api";
const AD = "https://ad-in-test.invalid/directory";
const SECRETS = { clientId: "test-client-id", clientSecret: "test-client-secret-sentinel" };
const SUBJECT = {
  givenName: "Ada",
  familyName: "Lovelace",
  userPrincipalName: "ada@example.com",
  displayName: "Ada Lovelace",
};
afterEach(() => {
  vi.restoreAllMocks();
});
function mockResponder(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => handler(input instanceof Request ? input.url : String(input), init));
}
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    expect.unreachable("vendor faults must throw");
    return "unreachable";
  } catch (error) {
    expect(error).toBeInstanceOf(Fault);
    return (error as Fault).code;
  }
}
describe("graph Actions", () => {
  it("creates users, assigns groups, provisions mailboxes, and licenses", async () => {
    mockResponder((url) => {
      if (url === `${GRAPH}/v1.0/users`) {
        return Response.json({ id: "entra-user-1", userPrincipalName: SUBJECT.userPrincipalName });
      }
      if (url === `${GRAPH}/v1.0/groups:assign`) return Response.json({ assigned: ["engineering"] });
      if (url === `${GRAPH}/v1.0/mailbox:provision`) return Response.json({ mailbox: "entra-user-1@example.com" });
      if (url === `${GRAPH}/v1.0/licenses:assign`) return Response.json({ assigned: true });
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    await expect(createGraphUser({ endpoint: GRAPH }, SUBJECT, "op-1", 1000)).resolves.toMatchObject({
      id: "entra-user-1",
    });
    await expect(
      addGraphUserToGroups({ endpoint: GRAPH }, "entra-user-1", ["engineering"], "op-2", 1000),
    ).resolves.toMatchObject({ assigned: ["engineering"] });
    await expect(provisionGraphMailbox({ endpoint: GRAPH }, "entra-user-1", "op-3", 1000)).resolves.toMatchObject({
      mailbox: "entra-user-1@example.com",
    });
    await expect(assignGraphLicense({ endpoint: GRAPH }, "entra-user-1", "sku", "op-4", 1000)).resolves.toBe(true);
  });
  it("maps transport faults onto the fixed taxonomy", async () => {
    mockResponder((url) => {
      if (url.includes("/unauthorized/")) return new Response("{}", { status: 401 });
      if (url.includes("/limited/")) return new Response("{}", { status: 429 });
      if (url.includes("/redirect/")) return new Response("{}", { status: 302 });
      if (url.includes("/broken/")) return new Response("{}", { status: 500 });
      return Response.json({ id: "x", userPrincipalName: "x@y" });
    });
    const connFor = (suffix: string) => ({ endpoint: `${GRAPH}${suffix}` });
    expect(await codeOf(() => createGraphUser(connFor("/unauthorized"), SUBJECT, "op", 1000))).toBe(
      "GRAPH_UNAUTHORIZED",
    );
    expect(await codeOf(() => createGraphUser(connFor("/limited"), SUBJECT, "op", 1000))).toBe("GRAPH_RATE_LIMITED");
    expect(await codeOf(() => createGraphUser(connFor("/redirect"), SUBJECT, "op", 1000))).toBe("GRAPH_VENDOR_FAILED");
    expect(await codeOf(() => createGraphUser(connFor("/broken"), SUBJECT, "op", 1000))).toBe("GRAPH_VENDOR_FAILED");
    // Unsafe endpoints fail closed before any fetch.
    expect(await codeOf(() => createGraphUser({ endpoint: "https://evil.example.com" }, SUBJECT, "op", 1000))).toBe(
      "INVALID_CONNECTION",
    );
  });
  it("rejects misshapen vendor bodies and slow vendors", async () => {
    mockResponder((url) => {
      if (url.includes("/slow/")) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(Response.json({ id: "x", userPrincipalName: "y" })), 200);
        });
      }
      if (url.endsWith("/users")) return Response.json({ nope: true });
      if (url.endsWith(":assign") && url.includes("groups")) return Response.json({ assigned: [42] });
      if (url.endsWith(":provision")) return Response.json({ mailbox: 42 });
      if (url.endsWith("licenses:assign")) return Response.json("yes");
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const conn = { endpoint: GRAPH };
    expect(await codeOf(() => createGraphUser(conn, SUBJECT, "op", 1000))).toBe("GRAPH_BAD_RESPONSE");
    expect(await codeOf(() => addGraphUserToGroups(conn, "u", ["g"], "op", 1000))).toBe("GRAPH_BAD_RESPONSE");
    expect(await codeOf(() => provisionGraphMailbox(conn, "u", "op", 1000))).toBe("GRAPH_BAD_RESPONSE");
    expect(await codeOf(() => assignGraphLicense(conn, "u", "sku", "op", 1000))).toBe("GRAPH_BAD_RESPONSE");
    expect(await codeOf(() => createGraphUser({ endpoint: `${GRAPH}/slow` }, SUBJECT, "op", 25))).toBe(
      "GRAPH_VENDOR_TIMEOUT",
    );
  });
});
describe("googleworkspace Actions", () => {
  it("creates users, assigns groups, and provisions mailboxes", async () => {
    mockResponder((url) => {
      if (url === `${GOOGLE}/admin/directory/v1/users`) {
        return Response.json({ id: "google-user-1", userPrincipalName: SUBJECT.userPrincipalName });
      }
      if (url === `${GOOGLE}/admin/directory/v1/groups:assign`) return Response.json({ assigned: ["all-staff"] });
      if (url === `${GOOGLE}/admin/directory/v1/mailbox:provision`) {
        return Response.json({ mailbox: "google-user-1@example.com" });
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const conn = { endpoint: GOOGLE };
    await expect(createGoogleUser(conn, SUBJECT, "op-1", 1000)).resolves.toMatchObject({ id: "google-user-1" });
    await expect(addGoogleUserToGroups(conn, "google-user-1", ["all-staff"], "op-2", 1000)).resolves.toMatchObject({
      assigned: ["all-staff"],
    });
    await expect(provisionGoogleMailbox(conn, "google-user-1", "op-3", 1000)).resolves.toMatchObject({
      mailbox: "google-user-1@example.com",
    });
  });
  it("maps transport faults and misshapen bodies", async () => {
    mockResponder((url) => {
      if (url.includes("/slow/")) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(Response.json({ id: "x", userPrincipalName: "y" })), 200);
        });
      }
      if (url.includes("/unauthorized/")) return new Response("{}", { status: 401 });
      if (url.includes("/limited/")) return new Response("{}", { status: 429 });
      if (url.includes("/redirect/")) return new Response("{}", { status: 302 });
      if (url.includes("/broken/")) return new Response("{}", { status: 500 });
      if (url.endsWith("/users")) return Response.json({ nope: true });
      if (url.endsWith(":assign")) return Response.json({ assigned: [42] });
      if (url.endsWith(":provision")) return Response.json({ mailbox: 42 });
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const connFor = (suffix: string) => ({ endpoint: `${GOOGLE}${suffix}` });
    expect(await codeOf(() => createGoogleUser(connFor("/unauthorized"), SUBJECT, "op", 1000))).toBe(
      "GOOGLEWORKSPACE_UNAUTHORIZED",
    );
    expect(await codeOf(() => createGoogleUser(connFor("/limited"), SUBJECT, "op", 1000))).toBe(
      "GOOGLEWORKSPACE_RATE_LIMITED",
    );
    expect(await codeOf(() => createGoogleUser(connFor("/redirect"), SUBJECT, "op", 1000))).toBe(
      "GOOGLEWORKSPACE_VENDOR_FAILED",
    );
    expect(await codeOf(() => createGoogleUser(connFor("/broken"), SUBJECT, "op", 1000))).toBe(
      "GOOGLEWORKSPACE_VENDOR_FAILED",
    );
    const conn = { endpoint: GOOGLE };
    expect(await codeOf(() => createGoogleUser(conn, SUBJECT, "op", 1000))).toBe("GOOGLEWORKSPACE_BAD_RESPONSE");
    expect(await codeOf(() => addGoogleUserToGroups(conn, "u", ["g"], "op", 1000))).toBe(
      "GOOGLEWORKSPACE_BAD_RESPONSE",
    );
    expect(await codeOf(() => provisionGoogleMailbox(conn, "u", "op", 1000))).toBe("GOOGLEWORKSPACE_BAD_RESPONSE");
    expect(await codeOf(() => createGoogleUser({ endpoint: `${GOOGLE}/slow` }, SUBJECT, "op", 25))).toBe(
      "GOOGLEWORKSPACE_VENDOR_TIMEOUT",
    );
  });
});
describe("ad Actions through the NinjaOne Transport", () => {
  function tokenMock(token: unknown, status = 200) {
    return mockResponder((url) => {
      if (url === "https://ninja-in-test.invalid/oauth/token") {
        return new Response(JSON.stringify(token), { status, headers: { "Content-Type": "application/json" } });
      }
      if (url === `${NINJA}/v2/ad/execute`)
        return Response.json({
          id: "ad-user-1",
          userPrincipalName: "ada@example.com",
          assigned: ["g"],
          mailbox: "m@example.com",
        });
      throw new Error(`Unexpected outbound request: ${url}`);
    });
  }
  it("creates users, assigns groups, and provisions mailboxes through the Transport", async () => {
    tokenMock({ access_token: "tok", expires_in: 3600, token_type: "Bearer" });
    const directory = { endpoint: AD };
    await expect(createAdUser(NINJA, SECRETS, directory, SUBJECT, "op-1", "exec-1", 1000)).resolves.toMatchObject({
      id: "ad-user-1",
    });
    await expect(
      addAdUserToGroups(NINJA, SECRETS, directory, "ad-user-1", ["g"], "op-2", "exec-1", 1000),
    ).resolves.toMatchObject({ assigned: ["g"] });
    await expect(
      provisionAdMailbox(NINJA, SECRETS, directory, "ad-user-1", "op-3", "exec-1", 1000),
    ).resolves.toMatchObject({ mailbox: "m@example.com" });
  });
  it("requires Transport credentials behind the Action boundary", async () => {
    const directory = { endpoint: AD };
    expect(await codeOf(() => createAdUser(NINJA, {}, directory, SUBJECT, "op", "exec-1", 1000))).toBe(
      "AD_TRANSPORT_NOT_CONFIGURED",
    );
    expect(
      await codeOf(() =>
        createAdUser("https://evil.example.com/api", SECRETS, directory, SUBJECT, "op", "exec-1", 1000),
      ),
    ).toBe("INVALID_CONNECTION");
  });
  it("maps token faults without leaking credential substrings", async () => {
    tokenMock({}, 401);
    expect(await codeOf(() => createAdUser(NINJA, SECRETS, { endpoint: AD }, SUBJECT, "op", "exec-1", 1000))).toBe(
      "AD_TRANSPORT_UNAUTHORIZED",
    );
    tokenMock({ nope: true });
    expect(await codeOf(() => createAdUser(NINJA, SECRETS, { endpoint: AD }, SUBJECT, "op", "exec-1", 1000))).toBe(
      "AD_TRANSPORT_BAD_RESPONSE",
    );
  });
  it("keeps credentials out of the complete Fault shape", async () => {
    async function fullFault(run: () => Promise<unknown>): Promise<Fault> {
      try {
        await run();
        expect.unreachable("vendor faults must throw");
        throw new Error("unreachable");
      } catch (error) {
        expect(error).toBeInstanceOf(Fault);
        return error as Fault;
      }
    }
    tokenMock({}, 401);
    for (const fault of [
      await fullFault(() => createAdUser(NINJA, SECRETS, { endpoint: AD }, SUBJECT, "op", "exec-1", 1000)),
      await fullFault(() => addAdUserToGroups(NINJA, SECRETS, { endpoint: AD }, "u", ["g"], "op", "exec-1", 1000)),
    ]) {
      expect(fault.code).toMatch(/^AD_TRANSPORT_/);
      const dumped = JSON.stringify({ code: fault.code, message: fault.message });
      expect(dumped).not.toContain(SECRETS.clientId);
      expect(dumped).not.toContain(SECRETS.clientSecret);
    }
  });
  it("maps Transport execution faults and misshapen bodies", async () => {
    const directory = { endpoint: AD };
    for (const [suffix, code] of [
      ["/unauthorized", "AD_TRANSPORT_UNAUTHORIZED"],
      ["/limited", "AD_TRANSPORT_RATE_LIMITED"],
      ["/redirect", "AD_TRANSPORT_FAILED"],
      ["/broken", "AD_TRANSPORT_FAILED"],
    ] as const) {
      mockResponder((url) => {
        if (url === "https://ninja-in-test.invalid/oauth/token") {
          return Response.json({ access_token: "tok", expires_in: 3600, token_type: "Bearer" });
        }
        return new Response("{}", {
          status: suffix === "/unauthorized" ? 401 : suffix === "/limited" ? 429 : suffix === "/redirect" ? 302 : 500,
        });
      });
      const poisoned = `${NINJA}${suffix}`;
      expect(await codeOf(() => createAdUser(poisoned, SECRETS, directory, SUBJECT, "op", "exec-1", 1000))).toBe(code);
    }
    mockResponder((url) => {
      if (url === "https://ninja-in-test.invalid/oauth/token") {
        return Response.json({ access_token: "tok", expires_in: 3600, token_type: "Bearer" });
      }
      if (url === `${NINJA}/v2/ad/execute`) return Response.json({ nope: true });
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    expect(await codeOf(() => createAdUser(NINJA, SECRETS, directory, SUBJECT, "op", "exec-1", 1000))).toBe(
      "AD_BAD_RESPONSE",
    );
    expect(await codeOf(() => addAdUserToGroups(NINJA, SECRETS, directory, "u", ["g"], "op", "exec-1", 1000))).toBe(
      "AD_BAD_RESPONSE",
    );
    expect(await codeOf(() => provisionAdMailbox(NINJA, SECRETS, directory, "u", "op", "exec-1", 1000))).toBe(
      "AD_BAD_RESPONSE",
    );
  });
  it("treats slow Transports as timeouts", async () => {
    mockResponder((url) => {
      if (url === "https://ninja-in-test.invalid/oauth/token") {
        return Response.json({ access_token: "tok", expires_in: 3600, token_type: "Bearer" });
      }
      return new Promise<Response>((resolve) => {
        setTimeout(() => resolve(Response.json({ id: "x", userPrincipalName: "y" })), 200);
      });
    });
    expect(await codeOf(() => createAdUser(NINJA, SECRETS, { endpoint: AD }, SUBJECT, "op", "exec-1", 25))).toBe(
      "AD_VENDOR_TIMEOUT",
    );
  });
});
