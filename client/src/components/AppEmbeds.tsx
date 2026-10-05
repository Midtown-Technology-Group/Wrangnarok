// SPDX-License-Identifier: AGPL-3.0
// Signed app-embed grants UI (EMBED-01 slice 2, issue #156).
//
// Admin create/list/rotate/revoke for one app's external capabilities,
// mounted as a section of the application detail page. Mirrors the
// FormEmbedsSection posture: the raw secret renders once after
// issue/rotate with a plant-it-now warning and is never fetched again
// (the server offers no readback); the inventory lists summaries only.
// Admin-only server-side: ordinary members see the ADMIN_ONLY failure,
// never the grants. A grant fingerprints the ACTIVE deployment, so the
// section also surfaces when a redeploy left grants stale (rotate heals).
import { useEffect, useState } from "react";
import { createAppEmbed, listAppEmbeds, rotateAppEmbed, revokeAppEmbed } from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import { parseOriginsInput } from "./FormEmbeds";
import type { AppEmbedGrantsResponse } from "../lib/client-types";

function shortHash(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

export function AppEmbedsSection(props: { appId: string; initial?: AppEmbedGrantsResponse }): React.JSX.Element {
  const [data, setData] = useState<AppEmbedGrantsResponse | null>(props.initial ?? null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ grantId: string; secret: string } | null>(null);
  const [origins, setOrigins] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);

  async function reload(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setData(await listAppEmbeds(props.appId));
    } catch (err) {
      setError(getErrorMessage(err, "Could not load app embed grants."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        setData(await listAppEmbeds(props.appId));
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load app embed grants."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.appId, props.initial]);

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
      const created = await createAppEmbed(props.appId, {
        allowedOrigins,
        ...(expiresAt.trim().length === 0 ? {} : { expiresAt: expiresAt.trim() }),
      });
      setIssued({ grantId: created.grant.id, secret: created.secret });
      setOrigins("");
      setExpiresAt("");
      setNotice("Grant issued. Plant the secret on the embed host now — it will not be shown again.");
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not issue an app embed grant."));
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
      const rotated = await rotateAppEmbed(props.appId, id);
      setIssued({ grantId: rotated.grant.id, secret: rotated.secret });
      setNotice("Grant rotated: the old secret is dead and the fingerprint re-bound. Plant the new secret now.");
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not rotate the app embed grant."));
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
      await revokeAppEmbed(props.appId, id);
      if (issued?.grantId === id) setIssued(null);
      setNotice("Grant revoked. Outstanding secrets and reads are dead.");
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not revoke the app embed grant."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="app-embeds-heading">
      <h2 id="app-embeds-heading">Embeds</h2>
      <p className="muted">
        Signed external capabilities for this app (admin only). Each grant binds exact-match origins and the active
        deployment fingerprint; redeploying invalidates grants until rotation. Secrets render once. This grant class is
        distinct from form embeds and anonymous publication: IDs never cross surfaces.
      </p>
      {loading ? (
        <p role="status" className="status-line">
          Loading app embed grants…
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
        <label htmlFor="app-embed-origins">Allowed origins (exact match, comma or space separated)</label>
        <input
          id="app-embed-origins"
          name="origins"
          type="text"
          autoComplete="off"
          value={origins}
          onChange={(e) => setOrigins(e.target.value)}
          placeholder="https://portal.example.com"
        />
        <label htmlFor="app-embed-expires">Expires at (optional ISO instant)</label>
        <input
          id="app-embed-expires"
          name="expiresAt"
          type="text"
          autoComplete="off"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          placeholder="2036-01-01T00:00:00.000Z"
        />
        <button type="submit" disabled={busy}>
          Issue grant
        </button>
      </form>
      {data ? (
        data.embeds.length === 0 ? (
          <p className="empty-state">No app embed grants yet.</p>
        ) : (
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
                {data.embeds.map((grant) => (
                  <tr key={grant.id} data-testid="app-embed-row">
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
                          <button type="button" disabled={busy} onClick={() => void onRotate(grant.id)}>
                            Rotate
                          </button>{" "}
                          <button type="button" disabled={busy} onClick={() => void onRevoke(grant.id)}>
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
        )
      ) : null}
    </section>
  );
}
