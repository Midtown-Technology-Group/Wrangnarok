// SPDX-License-Identifier: AGPL-3.0
// Policy-rule administration (issue #560) over the existing AUTH-02 routes:
// GET/POST /api/orgs/:id/policy-rules and GET/POST /api/policy-rules plus
// their DELETE one-routes. List/create/delete only — the API has no edit
// (PUT/PATCH) and no dry-run/impact-preview shape, so this page offers
// neither and says so. Effect is fixed `allow` (deny by absence); scope,
// subject, and resource render per row from the server payload.
import { useCallback, useEffect, useState } from "react";
import {
  createGlobalPolicyRule,
  createOrgPolicyRule,
  deleteGlobalPolicyRule,
  deleteOrgPolicyRule,
  getToken,
  listGlobalPolicyRules,
  listOrgPolicyRules,
  setToken,
} from "../lib/api-client";
import { ApiError, getErrorMessage } from "../lib/api-error";
import type { PolicyRule, PolicyRulesResponse, PolicyRuleWrite } from "../lib/client-types";
import { fetchOrgs, type OrgSummary } from "../lib/orgs-client";

const ACTIONS_BY_KIND: Record<string, string[]> = {
  saga: ["execute"],
  form: ["read", "submit", "write"],
  app: ["read", "write", "serve"],
};

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function subjectLabel(rule: PolicyRule): string {
  if (rule.subjectType === "all") return "all";
  return `${rule.subjectType}:${rule.subjectRef}`;
}

/** Deny-aware load error copy: 401/403 name the authority the server
 * requires (org admin vs instance admin) alongside the server message;
 * anything else passes the server message through. Pure for tests. */
export function scopeErrorMessage(scope: "Organization" | "Global", err: unknown): string {
  const server = getErrorMessage(err, `Could not load ${scope === "Global" ? "global" : "Organization"} policy rules.`);
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    const need =
      scope === "Global"
        ? "Global policy rules need an instance admin."
        : "Organization policy rules need an Organization admin for that Organization.";
    return `${need} Server: ${server}`;
  }
  return server;
}

export interface PolicyRulesInitial {
  orgs?: OrgSummary[];
  orgRules?: PolicyRulesResponse | null;
  globalRules?: PolicyRulesResponse | null;
  orgError?: string | null;
  globalError?: string | null;
}

export function PolicyRulesList(props: { initial?: PolicyRulesInitial }): React.JSX.Element {
  const initial = props.initial;
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(initial?.orgs ?? null);
  const [selected, setSelected] = useState(initial?.orgs?.[0]?.id ?? "");
  const [orgRules, setOrgRules] = useState<PolicyRulesResponse | null>(initial?.orgRules ?? null);
  const [globalRules, setGlobalRules] = useState<PolicyRulesResponse | null>(initial?.globalRules ?? null);
  const [orgError, setOrgError] = useState<string | null>(initial?.orgError ?? null);
  const [globalError, setGlobalError] = useState<string | null>(initial?.globalError ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(initial ? false : true);
  const [token, setTokenState] = useState(getToken());
  const [createScope, setCreateScope] = useState<"org" | "global">("org");
  const [kind, setKind] = useState("saga");
  const [resourceId, setResourceId] = useState("");
  const [action, setAction] = useState("execute");
  const [subjectType, setSubjectType] = useState("user");
  const [subjectRef, setSubjectRef] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const reloadOrgRules = useCallback(async (orgId: string) => {
    setOrgError(null);
    try {
      setOrgRules(await listOrgPolicyRules(orgId));
    } catch (err) {
      setOrgRules(null);
      setOrgError(scopeErrorMessage("Organization", err));
    }
  }, []);

  const reloadGlobal = useCallback(async () => {
    setGlobalError(null);
    try {
      setGlobalRules(await listGlobalPolicyRules());
    } catch (err) {
      setGlobalRules(null);
      setGlobalError(scopeErrorMessage("Global", err));
    }
  }, []);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const next = await fetchOrgs();
        if (cancelled) return;
        setOrgs(next);
        const first = next[0]?.id ?? "";
        setSelected(first);
        if (first) await reloadOrgRules(first);
        else setOrgRules({ rules: [] });
      } catch (err) {
        if (!cancelled) {
          setOrgs([]);
          setOrgRules(null);
          setOrgError(scopeErrorMessage("Organization", err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
      await reloadGlobal();
    })();
    return () => {
      cancelled = true;
    };
  }, [initial, reloadGlobal, reloadOrgRules]);

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      const write: PolicyRuleWrite = {
        resourceKind: kind,
        resourceId,
        action,
        subjectType,
        subjectRef: subjectType === "all" ? "all" : subjectRef,
      };
      if (createScope === "org") {
        await createOrgPolicyRule(selected, write);
        await reloadOrgRules(selected);
        setNotice("Organization policy rule created.");
      } else {
        await createGlobalPolicyRule(write);
        await reloadGlobal();
        setNotice("Global policy rule created.");
      }
      setResourceId("");
      setSubjectRef("");
    } catch (err) {
      if (createScope === "org") setOrgError(getErrorMessage(err, "Could not create the policy rule."));
      else setGlobalError(getErrorMessage(err, "Could not create the policy rule."));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteOrg(rule: PolicyRule): Promise<void> {
    setDeleting(rule.id);
    try {
      await deleteOrgPolicyRule(selected, rule.id);
      setNotice("Organization policy rule deleted.");
      await reloadOrgRules(selected);
    } catch (err) {
      setOrgError(getErrorMessage(err, "Could not delete the policy rule."));
    } finally {
      setDeleting(null);
    }
  }

  async function handleDeleteGlobal(rule: PolicyRule): Promise<void> {
    setDeleting(rule.id);
    try {
      await deleteGlobalPolicyRule(rule.id);
      setNotice("Global policy rule deleted.");
      await reloadGlobal();
    } catch (err) {
      setGlobalError(getErrorMessage(err, "Could not delete the policy rule."));
    } finally {
      setDeleting(null);
    }
  }

  const kindActions = ACTIONS_BY_KIND[kind] ?? [];

  return (
    <section aria-labelledby="policy-rules-heading">
      <h1 id="policy-rules-heading">Policy rules</h1>
      <p className="muted">
        Direct allow grants over existing policy-rule routes. Scope is Organization or global; every rule grants{" "}
        <code className="mono">allow</code> and anything without a matching rule denies by absence. Rules are immutable:
        create and delete only — the API offers no edit and no dry-run or impact preview.
      </p>
      <form
        className="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(token);
          if (selected) void reloadOrgRules(selected);
          void reloadGlobal();
        }}
      >
        <label htmlFor="token">Bearer [REDACTED] (local fixture only, never committed)</label>
        <input
          id="token"
          name="token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setTokenState(e.target.value)}
          placeholder="paste LAB_TOKEN"
        />
        <button type="submit">Reload</button>
      </form>
      {loading ? (
        <p role="status" className="status-line">
          Loading policy rules…
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="status-line">
          {notice}
        </p>
      ) : null}
      {orgs ? (
        <div className="filter-field">
          <label htmlFor="org-select">Organization</label>
          <select
            id="org-select"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              if (e.target.value) void reloadOrgRules(e.target.value);
            }}
          >
            {orgs.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name} ({org.status})
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <h2>Organization scope</h2>
      {orgError ? (
        <p role="alert" className="alert">
          {orgError}
        </p>
      ) : null}
      {orgRules ? (
        <>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Scope</th>
                  <th scope="col">Resource</th>
                  <th scope="col">Action</th>
                  <th scope="col">Effect</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {orgRules.rules.map((rule) => (
                  <tr key={rule.id} data-testid="policy-rule-row">
                    <td>{rule.orgId === null ? "Global" : "Organization"}</td>
                    <td>
                      <code className="mono">{rule.resourceKind}</code>{" "}
                      <code className="mono mono--truncate" title={rule.resourceId}>
                        {rule.resourceId}
                      </code>
                    </td>
                    <td>{rule.action}</td>
                    <td>allow</td>
                    <td>
                      <code className="mono mono--truncate" title={subjectLabel(rule)}>
                        {subjectLabel(rule)}
                      </code>
                    </td>
                    <td>
                      {rule.orgId === null ? (
                        <span className="muted" title="Global rows delete under Global scope below">
                          Global scope
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleDeleteOrg(rule)}
                          disabled={deleting === rule.id}
                          title={rule.id}
                        >
                          {deleting === rule.id ? "Deleting…" : "Delete"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {orgRules.rules.length === 0 ? (
            <p className="empty-state">No policy rules for this Organization yet.</p>
          ) : null}
        </>
      ) : null}
      <h2>Global scope</h2>
      <p className="muted">Instance admins only. Global rules apply across Organizations.</p>
      {globalError ? (
        <p role="alert" className="alert">
          {globalError}
        </p>
      ) : null}
      {globalRules ? (
        <>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Scope</th>
                  <th scope="col">Resource</th>
                  <th scope="col">Action</th>
                  <th scope="col">Effect</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {globalRules.rules.map((rule) => (
                  <tr key={rule.id} data-testid="policy-rule-row">
                    <td>Global</td>
                    <td>
                      <code className="mono">{rule.resourceKind}</code>{" "}
                      <code className="mono mono--truncate" title={rule.resourceId}>
                        {rule.resourceId}
                      </code>
                    </td>
                    <td>{rule.action}</td>
                    <td>allow</td>
                    <td>
                      <code className="mono mono--truncate" title={subjectLabel(rule)}>
                        {subjectLabel(rule)}
                      </code>
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() => void handleDeleteGlobal(rule)}
                        disabled={deleting === rule.id}
                        title={rule.id}
                      >
                        {deleting === rule.id ? "Deleting…" : "Delete"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {globalRules.rules.length === 0 ? <p className="empty-state">No global policy rules yet.</p> : null}
        </>
      ) : null}
      <form className="connection-form" onSubmit={(e) => void handleCreate(e)}>
        <h2>Add a policy rule</h2>
        <label htmlFor="rule-scope">Scope</label>
        <select
          id="rule-scope"
          value={createScope}
          onChange={(e) => setCreateScope(e.target.value as "org" | "global")}
        >
          <option value="org">This Organization</option>
          <option value="global">Global (instance admins only)</option>
        </select>
        <label htmlFor="rule-kind">Resource kind</label>
        <select
          id="rule-kind"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setAction((ACTIONS_BY_KIND[e.target.value] ?? [""])[0] ?? "");
          }}
        >
          <option value="saga">saga</option>
          <option value="form">form</option>
          <option value="app">app</option>
        </select>
        <label htmlFor="rule-resource">Resource ID (Saga/App UUID, Form name, or * for the whole kind)</label>
        <input
          id="rule-resource"
          name="resourceId"
          type="text"
          autoComplete="off"
          value={resourceId}
          onChange={(e) => setResourceId(e.target.value)}
          placeholder="*"
        />
        <label htmlFor="rule-action">Action</label>
        <select id="rule-action" value={action} onChange={(e) => setAction(e.target.value)}>
          {kindActions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <label htmlFor="rule-subject-type">Subject type</label>
        <select id="rule-subject-type" value={subjectType} onChange={(e) => setSubjectType(e.target.value)}>
          <option value="user">user</option>
          <option value="kind">kind</option>
          <option value="all">all</option>
        </select>
        {subjectType === "kind" ? (
          <>
            <label htmlFor="rule-subject">Subject (membership kind)</label>
            <select id="rule-subject" value={subjectRef} onChange={(e) => setSubjectRef(e.target.value)}>
              <option value="">Select…</option>
              <option value="ordinary">ordinary</option>
              <option value="external">external</option>
            </select>
          </>
        ) : subjectType === "all" ? (
          <p className="muted">Subject: every member (all).</p>
        ) : (
          <>
            <label htmlFor="rule-subject">Subject (user ID)</label>
            <input
              id="rule-subject"
              name="subjectRef"
              type="text"
              autoComplete="off"
              value={subjectRef}
              onChange={(e) => setSubjectRef(e.target.value)}
              placeholder="sam@example.com"
            />
          </>
        )}
        <p className="muted">
          Effect is always <code className="mono">allow</code>; there is no deny effect, no edit, and no dry-run.
        </p>
        <button type="submit" disabled={saving || (createScope === "org" && !selected)}>
          {saving ? "Creating…" : "Create policy rule"}
        </button>
      </form>
      <p className="muted" data-testid="policy-rule-id-note">
        Rule IDs are truncated ({shortId("00000000-0000-4000-8000-000000000000")}); hover a truncated value for the full
        ID. Delete uses the full server ID.
      </p>
    </section>
  );
}
