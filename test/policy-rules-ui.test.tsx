// SPDX-License-Identifier: AGPL-3.0
// Policy-rule administration UI (issue #560): fixture-backed render plus
// client-wrapper round trips over the existing GET/POST/DELETE org and
// global routes. Scope/effect/subject/resource stay explicit per row;
// edit and dry-run affordances must not exist because the API has none.
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createGlobalPolicyRule,
  createOrgPolicyRule,
  deleteGlobalPolicyRule,
  deleteOrgPolicyRule,
  listGlobalPolicyRules,
  listOrgPolicyRules,
} from "../client/src/lib/api-client";
import { ApiError } from "../client/src/lib/api-error";
import type { PolicyRulesResponse } from "../client/src/lib/client-types";
import type { OrgSummary } from "../client/src/lib/orgs-client";
import { NAV_ENTRIES } from "../client/src/components/Nav";
import { PolicyRulesList, scopeErrorMessage } from "../client/src/pages/PolicyRules";

const ORG_A = "00000000-0000-4000-8000-000000000001";
const RULE_ORG = "00000000-0000-4000-8000-000000000011";
const RULE_GLOBAL = "00000000-0000-4000-8000-000000000012";
const SAGA_ID = "720b9ebf-9b6a-4eac-bae9-6ed22c970401";

const orgs: OrgSummary[] = [
  { id: ORG_A, name: "acme", status: "active", createdAt: "2026-09-01T00:00:00.000Z", disabledAt: null },
];

const orgRules: PolicyRulesResponse = {
  rules: [
    {
      id: RULE_ORG,
      orgId: ORG_A,
      resourceKind: "saga",
      resourceId: SAGA_ID,
      action: "execute",
      subjectType: "user",
      subjectRef: "sam@example.com",
      createdAt: "2026-09-10T00:00:00.000Z",
    },
    {
      id: RULE_GLOBAL,
      orgId: null,
      resourceKind: "form",
      resourceId: "hello-greeting",
      action: "read",
      subjectType: "kind",
      subjectRef: "external",
      createdAt: "2026-09-09T00:00:00.000Z",
    },
  ],
};

const globalRules: PolicyRulesResponse = {
  rules: [
    {
      id: RULE_GLOBAL,
      orgId: null,
      resourceKind: "app",
      resourceId: "22222222-2222-4222-8222-222222222222",
      action: "serve",
      subjectType: "all",
      subjectRef: "all",
      createdAt: "2026-09-09T00:00:00.000Z",
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("lists Organization rules over GET /api/orgs/:id/policy-rules", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ rules: orgRules.rules }));
  const data = await listOrgPolicyRules(ORG_A);
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
  expect(url).toBe(`/api/orgs/${ORG_A}/policy-rules`);
  expect(init?.method ?? "GET").toBe("GET");
  expect(data.rules).toHaveLength(2);
});

it("creates an Organization rule with the API body shape and deletes by ID", async () => {
  const created = { ...orgRules.rules[0] };
  const seen: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    const raw = (init as RequestInit | undefined)?.body;
    seen.push({ url, method, body: raw === undefined ? undefined : JSON.parse(String(raw)) });
    if (method === "POST") return Response.json(created, { status: 201 });
    return Response.json({ deleted: true });
  });
  const rule = await createOrgPolicyRule(ORG_A, {
    resourceKind: "saga",
    resourceId: SAGA_ID,
    action: "execute",
    subjectType: "user",
    subjectRef: "sam@example.com",
  });
  expect(rule.id).toBe(RULE_ORG);
  await deleteOrgPolicyRule(ORG_A, RULE_ORG);
  expect(seen).toHaveLength(2);
  expect(seen[0]).toMatchObject({
    url: `/api/orgs/${ORG_A}/policy-rules`,
    method: "POST",
    body: {
      resourceKind: "saga",
      resourceId: SAGA_ID,
      action: "execute",
      subjectType: "user",
      subjectRef: "sam@example.com",
    },
  });
  expect(seen[1]).toMatchObject({ url: `/api/orgs/${ORG_A}/policy-rules/${RULE_ORG}`, method: "DELETE" });
  // Only the API's verbs appear: no PUT/PATCH edit anywhere in the flow.
  for (const call of seen) expect(["POST", "DELETE"]).toContain(call.method);
});

it("lists, creates, and deletes global rules over /api/policy-rules", async () => {
  const seen: Array<{ url: string; method: string }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    seen.push({ url, method });
    if (method === "POST") return Response.json(globalRules.rules[0], { status: 201 });
    if (url === "/api/policy-rules") return Response.json({ rules: globalRules.rules });
    return Response.json({ deleted: true });
  });
  const data = await listGlobalPolicyRules();
  expect(data.rules).toHaveLength(1);
  await createGlobalPolicyRule({
    resourceKind: "app",
    resourceId: "22222222-2222-4222-8222-222222222222",
    action: "serve",
    subjectType: "all",
    subjectRef: "all",
  });
  await deleteGlobalPolicyRule(RULE_GLOBAL);
  expect(seen).toContainEqual({ url: "/api/policy-rules", method: "GET" });
  expect(seen).toContainEqual({ url: "/api/policy-rules", method: "POST" });
  expect(seen).toContainEqual({ url: `/api/policy-rules/${RULE_GLOBAL}`, method: "DELETE" });
});

it("rejects malformed rule payloads instead of rendering guesses", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ rules: [{ id: "nope" }] }));
  await expect(listOrgPolicyRules(ORG_A)).rejects.toThrow("Unexpected policy rules response shape.");
  await expect(listGlobalPolicyRules()).rejects.toThrow("Unexpected policy rules response shape.");
});

it("renders scope, effect, subject, and resource per row; global rows stay read-only in org scope", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PolicyRulesList initial={{ orgs, orgRules, globalRules }} />
    </MemoryRouter>,
  );
  expect(html).toContain("Policy rules");
  expect(html).toContain("Organization");
  expect(html).toContain("Global");
  expect(html).toContain("allow");
  expect(html).toContain("user:sam@example.com");
  expect(html).toContain("kind:external");
  expect(html).toContain("hello-greeting");
  // Global rows visible in the org listing delete under Global scope, not here.
  expect(html).toContain("Global scope");
  // Org rows carry a Delete affordance; nothing offers Edit or dry-run.
  expect(html).toContain(">Delete<");
  expect(html).not.toContain(">Edit<");
  expect(html).not.toContain("Dry run");
  expect(html).toContain("no edit and no dry-run");
});

it("renders the create form with kind-gated actions and subject inputs", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PolicyRulesList initial={{ orgs, orgRules: { rules: [] }, globalRules: { rules: [] } }} />
    </MemoryRouter>,
  );
  expect(html).toContain("Add a policy rule");
  expect(html).toContain("This Organization");
  expect(html).toContain("Global (instance admins only)");
  // Default kind saga gates to execute only.
  expect(html).toContain("execute");
  expect(html).toContain("Subject (user ID)");
  expect(html).toContain("Create policy rule");
});

it("renders empty states when either scope has no rules", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PolicyRulesList initial={{ orgs, orgRules: { rules: [] }, globalRules: { rules: [] } }} />
    </MemoryRouter>,
  );
  expect(html).toContain("No policy rules for this Organization yet.");
  expect(html).toContain("No global policy rules yet.");
});

it("names the required authority on deny, keeping the server message", () => {
  const orgDenied = scopeErrorMessage("Organization", new ApiError("ADMIN_ONLY", "Organization admin only.", 403));
  expect(orgDenied).toContain("Organization admin");
  expect(orgDenied).toContain("Organization admin only.");
  const globalDenied = scopeErrorMessage("Global", new ApiError("FORBIDDEN", "Instance admin only.", 403));
  expect(globalDenied).toContain("instance admin");
  expect(globalDenied).toContain("Instance admin only.");
  const other = scopeErrorMessage("Organization", new Error("boom"));
  expect(other).toBe("boom");

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PolicyRulesList
        initial={{ orgs, orgRules: null, globalRules: null, orgError: orgDenied, globalError: globalDenied }}
      />
    </MemoryRouter>,
  );
  expect(html).toContain("Organization admin");
  expect(html).toContain("instance admin");
});

it("is reachable at /policy-rules through an enabled nav entry", () => {
  const entry = NAV_ENTRIES.find((item) => item.label === "Policy rules");
  expect(entry).toMatchObject({ to: "/policy-rules", enabled: true });
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/policy-rules"]}>
      <Routes>
        <Route path="/policy-rules" element={<PolicyRulesList initial={{ orgs, orgRules, globalRules }} />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(html).toContain("Policy rules");
  expect(html).toContain("user:sam@example.com");
});
