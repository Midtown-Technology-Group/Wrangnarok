// SPDX-License-Identifier: AGPL-3.0
// AUTH-01 admin UI: Organizations, members, delete previews. Same caller
// policies as the noninteractive APIs — the server enforces every boundary,
// this page only renders what the APIs return.
import { useEffect, useState } from "react";
import { getErrorMessage } from "../lib/api-error";
import { getToken } from "../lib/api-client";
import {
  createOrg,
  deleteOrg,
  deletePreview,
  disableOrg,
  disableUser,
  enableOrg,
  enableUser,
  fetchMembers,
  fetchOrgs,
  inviteMember,
  updateMember,
  type DeletePreview,
  type MemberRow,
  type OrgSummary,
} from "../lib/orgs-client";

function headers(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

export { headers as adminHeaders };

export function AdminOrgs(): React.JSX.Element {
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [inviteId, setInviteId] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteKind, setInviteKind] = useState("ordinary");

  async function reload(): Promise<void> {
    setError(null);
    try {
      const next = await fetchOrgs();
      setOrgs(next);
      if (!selected && next.length > 0) setSelected(next[0]?.id ?? "");
    } catch (err) {
      setError(getErrorMessage(err, "Could not load Organizations."));
    }
  }

  useEffect(() => {
    void reload();
    // Mount-only load: reload is stable-by-construction (no props/state
    // inputs), so no dependency array entries are missing here.
  }, []);

  useEffect(() => {
    if (!selected) {
      setMembers(null);
      setPreview(null);
      return;
    }
    void (async () => {
      try {
        setMembers(await fetchMembers(selected));
      } catch (err) {
        setMembers(null);
        setError(getErrorMessage(err, "Could not load members."));
      }
    })();
  }, [selected, orgs]);

  async function act(run: () => Promise<unknown>, ok: string): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await run();
      setNotice(ok);
      await reload();
      if (selected) {
        try {
          setMembers(await fetchMembers(selected));
        } catch {
          setMembers(null);
        }
      }
      setPreview(null);
    } catch (err) {
      setError(getErrorMessage(err, "Action failed."));
    }
  }

  return (
    <section aria-labelledby="admin-heading">
      <h1 id="admin-heading">Organization administration</h1>
      <p className="muted">
        Instance admins create and disable Organizations and onboard users globally. Organization admins invite members
        and revoke access. Bulk operations are intentionally omitted in this slice: repeat the single-row actions above
        (see ADR 015).
      </p>
      {error ? (
        <p role="alert" className="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="status-line">
          {notice}
        </p>
      ) : null}
      <form
        className="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => createOrg(name).then(() => setName("")), `Created Organization ${name}.`);
        }}
      >
        <label htmlFor="org-name">New Organization name</label>
        <input id="org-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="acme" />
        <button type="submit">Create</button>
      </form>
      {orgs ? (
        <div className="filter-field">
          <label htmlFor="org-select">Organization</label>
          <select id="org-select" value={selected} onChange={(e) => setSelected(e.target.value)}>
            {orgs.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name} ({org.status})
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {selected ? (
        <div className="pills" role="group" aria-label="Organization actions">
          <button
            type="button"
            className="pill"
            onClick={() => void act(() => disableOrg(selected), "Organization disabled.")}
          >
            Disable
          </button>
          <button
            type="button"
            className="pill"
            onClick={() => void act(() => enableOrg(selected), "Organization enabled.")}
          >
            Enable
          </button>
          <button
            type="button"
            className="pill"
            onClick={() =>
              void (async () => {
                setError(null);
                try {
                  setPreview(await deletePreview(selected));
                } catch (err) {
                  setError(getErrorMessage(err, "Could not preview deletion."));
                }
              })()
            }
          >
            Preview delete
          </button>
        </div>
      ) : null}
      {preview ? (
        <div>
          <p className="muted" data-testid="delete-preview">
            {preview.orgName}: {preview.executions} Executions, {preview.operations} Operations,{" "}
            {preview.connectionsLoose} loose Connections, {preview.connectionsManaged} managed, {preview.bundleInstalls}{" "}
            installs, {preview.memberships} memberships, {preview.forms} forms, {preview.apps} apps (
            {preview.appsManaged} Solution-owned), {preview.tables} tables with {preview.tableRows} rows,{" "}
            {preview.fileLocations} file locations with {preview.files} files, {preview.artifacts} artifacts,{" "}
            {preview.endpoints} endpoints, {preview.configsLoose} loose configs ({preview.configsManaged} managed),{" "}
            {preview.auditEvents} audit events (retained), {preview.notifications} notifications, {preview.bundleActive}{" "}
            active bundle pointers with {preview.bundleOwnedRows} owned rows. Retained: {preview.retained.join(", ")}.{" "}
            {preview.canDelete ? "Deletable." : preview.blockedBy.join(" ")}
          </p>
          {preview.canDelete ? (
            <button
              type="button"
              className="pill"
              onClick={() => void act(() => deleteOrg(selected).then(() => setSelected("")), "Organization deleted.")}
            >
              Delete {preview.orgName}
            </button>
          ) : null}
        </div>
      ) : null}
      {members ? (
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Kind</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId} data-testid="member-row">
                  <td>
                    <code className="mono">{m.userId}</code>
                  </td>
                  <td>{m.role}</td>
                  <td>{m.status}</td>
                  <td>{m.kind}</td>
                  <td>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() =>
                        void act(
                          () => updateMember(selected, m.userId, { status: "suspended" }),
                          `Suspended ${m.userId}.`,
                        )
                      }
                    >
                      Suspend
                    </button>{" "}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() =>
                        void act(() => updateMember(selected, m.userId, { status: "revoked" }), `Revoked ${m.userId}.`)
                      }
                    >
                      Revoke
                    </button>{" "}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() =>
                        void act(
                          () => updateMember(selected, m.userId, { role: m.role === "admin" ? "member" : "admin" }),
                          `Role changed for ${m.userId}.`,
                        )
                      }
                    >
                      {m.role === "admin" ? "Demote" : "Promote"}
                    </button>{" "}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => void act(() => disableUser(m.userId), `Disabled user ${m.userId}.`)}
                    >
                      Disable user
                    </button>{" "}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => void act(() => enableUser(m.userId), `Enabled user ${m.userId}.`)}
                    >
                      Enable user
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {selected ? (
        <form
          className="token-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              () => inviteMember(selected, inviteId, inviteRole, inviteKind).then(() => setInviteId("")),
              `Invited ${inviteId}.`,
            );
          }}
        >
          <label htmlFor="invite-id">Invite user ID (email or UUID)</label>
          <input
            id="invite-id"
            value={inviteId}
            onChange={(e) => setInviteId(e.target.value)}
            placeholder="sam@example.com"
          />
          <select aria-label="Role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <select aria-label="Kind" value={inviteKind} onChange={(e) => setInviteKind(e.target.value)}>
            <option value="ordinary">ordinary</option>
            <option value="external">external</option>
          </select>
          <button type="submit">Invite</button>
        </form>
      ) : null}
    </section>
  );
}
