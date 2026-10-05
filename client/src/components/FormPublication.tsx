// SPDX-License-Identifier: AGPL-3.0
// Anonymous public-form publication UI (EMBED-01 slice 2, issue #156).
//
// Admin publish/review/block for one form's anonymous admission path,
// mounted as a section of the form detail page next to the signed-embed
// section. There is no secret material in this class, so the summary
// carries everything: the public link ID, the honeypot field, the
// fingerprint, and the live staleness bit the review button keys on.
// Publishing opens an anonymous admission path, so the section is
// admin-only server-side like the embed inventory.
import { useEffect, useState } from "react";
import { getFormPublication, publishForm, reviewPublication, unpublishForm } from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { FormPublicationResponse } from "../lib/client-types";

function shortHash(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

export function FormPublicationSection(props: {
  formName: string;
  initial?: FormPublicationResponse;
}): React.JSX.Element {
  const [data, setData] = useState<FormPublicationResponse | null>(props.initial ?? null);
  const [busy, setBusy] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);

  async function reload(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setData(await getFormPublication(props.formName));
    } catch (err) {
      setError(getErrorMessage(err, "Could not load the publication."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        setData(await getFormPublication(props.formName));
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load the publication."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.formName, props.initial]);

  async function publishNow(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await publishForm(props.formName, honeypot.trim().length === 0 ? {} : { honeypotField: honeypot.trim() });
      setHoneypot("");
      setNotice("Form published: anonymous submissions are confirmation-only and disclose no execution.");
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not publish the form."));
    } finally {
      setBusy(false);
    }
  }

  async function onReview(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await reviewPublication(props.formName);
      setNotice("Publication reviewed: the capability fingerprint re-bound to the live declaration.");
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not review the publication."));
    } finally {
      setBusy(false);
    }
  }

  async function onUnpublish(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await unpublishForm(props.formName);
      setNotice("Publication blocked: anonymous routes answer 404.");
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not block the publication."));
    } finally {
      setBusy(false);
    }
  }

  const publication = data?.publication ?? null;

  return (
    <section aria-labelledby="form-publication-heading">
      <h2 id="form-publication-heading">Public form</h2>
      <p className="muted">
        Anonymous admission for this form (admin only). Submissions are confirmation-only — no execution or history is
        disclosed — guarded by a honeypot field and single-use sessions. Editing the form invalidates the publication
        until review. Distinct from signed embed grants: no secrets exist here.
      </p>
      {loading ? (
        <p role="status" className="status-line">
          Loading publication…
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
      {publication ? (
        <>
          <dl>
            <div>
              <dt>Public link ID</dt>
              <dd>
                <code className="mono" title={publication.id} data-testid="publication-id">
                  {shortHash(publication.id)}
                </code>
              </dd>
            </div>
            <div>
              <dt>Honeypot field</dt>
              <dd>
                <code className="mono">{publication.honeypotField}</code>
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd data-testid="publication-status">
                {publication.enabled ? (publication.stale ? "Stale — review required" : "Live") : "Blocked"}
              </dd>
            </div>
          </dl>
          <p>
            {publication.enabled && publication.stale ? (
              <>
                <button type="button" disabled={busy} onClick={() => void onReview()}>
                  Review and re-bind
                </button>{" "}
              </>
            ) : null}
            {publication.enabled ? (
              <button type="button" disabled={busy} onClick={() => void onUnpublish()}>
                Block publication
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => void publishNow()}>
                Re-publish
              </button>
            )}
          </p>
        </>
      ) : (
        <p className="empty-state" data-testid="publication-empty">
          Not published.
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void publishNow();
        }}
      >
        <label htmlFor="publication-honeypot">Honeypot field (optional, must not collide with a form field)</label>
        <input
          id="publication-honeypot"
          name="honeypotField"
          type="text"
          autoComplete="off"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
          placeholder="wrangnarok_hp"
        />
        <button type="submit" disabled={busy}>
          {publication ? "Re-publish" : "Publish"}
        </button>
      </form>
    </section>
  );
}
