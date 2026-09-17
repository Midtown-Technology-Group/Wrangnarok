// SPDX-License-Identifier: AGPL-3.0
// Signed form-embed grants UI (EMBED-01 slice 1, issue #156).
//
// Admin create/list/rotate/revoke for one form's external capabilities,
// mounted as a section of the form detail page. The raw secret renders
// once after issue/rotate with a plant-it-now warning and is never
// fetched again (the server offers no readback); the inventory lists
// summaries only. Admin-only server-side: ordinary members see the
// ADMIN_ONLY failure, never the grants.
import { useEffect, useState } from "react";
import { createFormEmbed, listFormEmbeds, rotateFormEmbed, revokeFormEmbed } from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { EmbedGrantSummary, EmbedGrantsResponse } from "../lib/client-types";

/** Split an origins textarea into entries: commas, spaces, and newlines
 * separate; blanks drop. The server validates exact-match shape. */
export function parseOriginsInput(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export interface IssuedSecret {
  grantId: string;
  secret: string;
}

function shortHash(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function GrantsTable(props: {
  grants: EmbedGrantSummary[];
  busy: boolean;
  onRotate: (id: string) => void;
  onRevoke: (id: string) => void;
}): React.JSX.Element {
  if (props.grants.length === 0) return <p className="empty-state">No embed grants yet.</p>;
  return (
    <div className="table-scroll">
      <table className="history-table">
        <thead>
          <tr>
            <th scope="col">Grant</th>
            <th scope="col">Allowed origins</th>
            <th scope="col">Fingerprint</th>
            <th scope="col">Status</th>
            <th scope="col">Expires</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {props.grants.map((grant) => (
            <tr key={grant.id} data-testid="embed-row">
              <td>
                <code className="mono" title={grant.id}>
                  {shortHash(grant.id)}
                </code>
              </td>
              <td>{grant.allowedOrigins.join(", ")}</td>
              <td>
                <code className="mono" title={grant.fingerprint}>
                  {shortHash(grant.fingerprint)}
                </code>
              </td>
              <td>{grant.enabled ? "Active" : "Revoked"}</td>
              <td>{grant.expiresAt ?? "—"}</td>
              <td>
                {grant.enabled ? (
                  <>
                    <button type="button" disabled={props.busy} onClick={() => props.onRotate(grant.id)}>
                      Rotate
                    </button>{" "}
                    <button type="button" disabled={props.busy} onClick={() => props.onRevoke(grant.id)}>
                      Revoke
                    </button>
                  </>
                ) : (
                  <span className="muted">Revoked</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FormEmbedsSection(props: {
  formName: string;
  initial?: EmbedGrantsResponse;
  initialIssued?: IssuedSecret | null;
}): React.JSX.Element {
  const [data, setData] = useState<EmbedGrantsResponse | null>(props.initial ?? null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedSecret | null>(props.initialIssued ?? null);
  const [origins, setOrigins] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);

  async function reload(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setData(await listFormEmbeds(props.formName));
    } catch (err) {
      setError(getErrorMessage(err, "Could not load embed grants."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        setData(await listFormEmbeds(props.formName));
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load embed grants."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.formName, props.initial]);

  async function onCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    const allowedOrigins = parseOriginsInput(origins);
    if (allowedOrigins.length === 0) {
      setError("List at least one exact-match origin (https://host[:port], no wildcards).");
      return;
    }
    setBusy(true);
    try {
      const created = await createFormEmbed(props.formName, {
        allowedOrigins,
        ...(expiresAt.trim().length === 0 ? {} : { expiresAt: expiresAt.trim() }),
      });
      setIssued({ grantId: created.grant.id, secret: created.secret });
      setOrigins("");
      setExpiresAt("");
      setNotice("Grant issued. Plant the secret on the embed host now — it will not be shown again.");
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not issue an embed grant."));
    } finally {
      setBusy(false);
    }
  }

  async function onRotate(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const rotated = await rotateFormEmbed(props.formName, id);
      setIssued({ grantId: rotated.grant.id, secret: rotated.secret });
      setNotice("Grant rotated: the old secret is dead and the fingerprint re-bound. Plant the new secret now.");
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not rotate the embed grant."));
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await revokeFormEmbed(props.formName, id);
      if (issued?.grantId === id) setIssued(null);
      setNotice("Grant revoked. Outstanding secrets and sessions are dead.");
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not revoke the embed grant."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="form-embeds-heading">
      <h2 id="form-embeds-heading">Embeds</h2>
      <p className="muted">
        Signed external capabilities for this form (admin only). Each grant binds exact-match origins and a declaration
        fingerprint; editing the form invalidates grants until rotation. Secrets render once.
      </p>
      {loading ? (
        <p role="status" className="status-line">
          Loading embed grants…
        </p>
      ) : null}
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
      {issued ? (
        <p role="status" className="status-line">
          New secret for <code className="mono">{shortHash(issued.grantId)}</code>:{" "}
          <code className="mono">{issued.secret}</code> — plant it on the embed host now; it will not be shown again.{" "}
          <button type="button" onClick={() => setIssued(null)}>
            Dismiss
          </button>
        </p>
      ) : null}
      <form onSubmit={(e) => void onCreate(e)}>
        <label htmlFor="embed-origins">Allowed origins (exact match, comma or space separated)</label>
        <input
          id="embed-origins"
          name="origins"
          type="text"
          autoComplete="off"
          value={origins}
          onChange={(e) => setOrigins(e.target.value)}
          placeholder="https://portal.example.com"
        />
        <label htmlFor="embed-expires">Expires at (optional ISO instant)</label>
        <input
          id="embed-expires"
          name="expiresAt"
          type="text"
          autoComplete="off"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          placeholder="2027-01-01T00:00:00.000Z"
        />
        <button type="submit" disabled={busy}>
          Issue grant
        </button>
      </form>
      {data ? (
        <GrantsTable
          grants={data.embeds}
          busy={busy}
          onRotate={(id) => void onRotate(id)}
          onRevoke={(id) => void onRevoke(id)}
        />
      ) : null}
    </section>
  );
}
