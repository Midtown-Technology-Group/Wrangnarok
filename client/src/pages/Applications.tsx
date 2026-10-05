// SPDX-License-Identifier: AGPL-3.0
// Applications pages (APP-01, issue #159; ADR 017). Layout borrowed (not
// verbatim) from client/src/pages/ExecutionHistory.tsx (token form,
// loading/error/empty states, truncated-mono ID + tooltip table pattern).
//
// Independent V2 lifecycle only: create, edit source, validate, build
// (async deploy job), inspect jobs, slug-swap recovery, delete. No
// draft/preview/publish step exists for independent V2 apps, and no
// retained-history rollback UI is promised (recovery is redeploy or a
// parked-old-app slug swap). Solution-owned rows render read-only: the
// server rejects live mutation with MANAGED_RESOURCE.
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  createApp,
  deleteApp,
  editAppSource,
  fetchAppDetail,
  getToken,
  listAppJobs,
  listApps,
  setToken,
  startAppBuild,
  swapAppSlugs,
  validateApp,
} from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { AppDetail, AppJob, AppSummary, AppsResponse } from "../lib/client-types";
import { AppEmbedsSection } from "../components/AppEmbeds";
import { StatusBadge } from "../components/StatusBadge";

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function TokenForm({
  token,
  onToken,
  onReload,
}: {
  token: string;
  onToken: (v: string) => void;
  onReload: () => void;
}): React.JSX.Element {
  return (
    <form
      className="token-form"
      onSubmit={(e) => {
        e.preventDefault();
        setToken(token);
        onReload();
      }}
    >
      <label htmlFor="token">Bearer token (local fixture only, never committed)</label>
      <input
        id="token"
        name="token"
        type="password"
        autoComplete="off"
        value={token}
        onChange={(e) => onToken(e.target.value)}
        placeholder="paste LAB_TOKEN"
      />
      <button type="submit">Reload</button>
    </form>
  );
}

function AppStatusLine({ status, ownerKind }: { status: string; ownerKind: string }): React.JSX.Element {
  return (
    <span>
      <StatusBadge status={status} /> <span className="muted muted--small">{ownerKind}</span>
    </span>
  );
}

function JobLine({ job }: { job: AppJob }): React.JSX.Element {
  return (
    <li data-testid="app-job">
      <code className="mono" title={job.id}>
        {shortId(job.id)}
      </code>{" "}
      r{job.revision} · <StatusBadge status={job.status} />
      {job.error ? (
        <span className="muted">
          {" "}
          · {job.error.code}: {job.error.message}
        </span>
      ) : null}
    </li>
  );
}

export function ApplicationsList(props: { initial?: AppsResponse }): React.JSX.Element {
  const [data, setData] = useState<AppsResponse | null>(props.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await listApps());
    } catch (err) {
      setError(getErrorMessage(err, "Could not load Applications."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await listApps();
        if (!cancelled) setData(next);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load Applications."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial]);

  const submitCreate = useCallback(async () => {
    if (!name || !slug || creating) return;
    setCreating(true);
    setError(null);
    try {
      await createApp(name, slug);
      setName("");
      setSlug("");
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not create the app."));
    } finally {
      setCreating(false);
    }
  }, [name, slug, creating, reload]);

  return (
    <section aria-labelledby="apps-heading">
      <h1 id="apps-heading">Applications</h1>
      <p className="muted">
        Independent apps deploy through edit, validate, build, and deploy. No draft or publish step. Recovery is
        redeploy or a parked-old-app slug swap. Solution-owned apps are read-only here.
      </p>
      <TokenForm token={token} onToken={setTokenState} onReload={() => void reload()} />
      {loading ? (
        <p role="status" className="status-line">
          Loading Applications…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="alert">
          {error}
        </p>
      ) : null}
      <form
        className="token-form"
        aria-label="Create an independent app"
        onSubmit={(e) => {
          e.preventDefault();
          void submitCreate();
        }}
      >
        <label htmlFor="app-name">Name</label>
        <input
          id="app-name"
          name="name"
          type="text"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="storefront"
          maxLength={128}
        />
        <label htmlFor="app-slug">Slug (unique route per Organization)</label>
        <input
          id="app-slug"
          name="slug"
          type="text"
          autoComplete="off"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="storefront"
          maxLength={64}
        />
        <button type="submit" disabled={creating || !name || !slug}>
          {creating ? "Creating…" : "Create app"}
        </button>
      </form>
      {data ? (
        <>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">App</th>
                  <th scope="col">Slug</th>
                  <th scope="col">Status</th>
                  <th scope="col">Revision</th>
                  <th scope="col">
                    <span className="visually-hidden">Open detail</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.apps.map((app: AppSummary) => (
                  <tr key={app.id} data-testid="app-row">
                    <td>
                      <Link to={`/apps/${app.id}`} className="saga-link">
                        {app.name}
                      </Link>
                      <div className="muted muted--small">
                        <code className="mono" title={app.id}>
                          {shortId(app.id)}
                        </code>
                      </div>
                    </td>
                    <td>
                      <code className="mono">{app.slug}</code>
                    </td>
                    <td>
                      <AppStatusLine status={app.status} ownerKind={app.ownerKind} />
                    </td>
                    <td>
                      <span className="muted">{app.revision === null ? "—" : `r${app.revision}`}</span>
                    </td>
                    <td className="cell--chevron">
                      <Link to={`/apps/${app.id}`} className="chevron-link" aria-label={`Open Application ${app.name}`}>
                        <span aria-hidden="true">›</span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.apps.length === 0 ? <p className="empty-state">No Applications yet.</p> : null}
        </>
      ) : null}
    </section>
  );
}

const STARTER_SOURCE = `<h1>hello</h1>`;
const STARTER_PATH = "index.html";

export function ApplicationDetailView(props: { initial?: AppDetail }): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<AppDetail | null>(props.initial ?? null);
  const [jobs, setJobs] = useState<AppJob[] | null>(props.initial ? props.initial.jobs : null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());
  const [working, setWorking] = useState(false);
  const [source, setSource] = useState(STARTER_SOURCE);
  const [swapWith, setSwapWith] = useState("");

  const reload = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchAppDetail(id);
      setData(next);
      setJobs(next.jobs);
      const current = next.revisions[next.revisions.length - 1];
      if (current && current.files.length > 0 && current.files[0]) setSource(current.files[0].content);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load the app."));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (props.initial || !id) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchAppDetail(id);
        if (cancelled) return;
        setData(next);
        setJobs(next.jobs);
        const current = next.revisions[next.revisions.length - 1];
        if (current && current.files.length > 0 && current.files[0]) setSource(current.files[0].content);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load the app."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial, id]);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setWorking(true);
      setError(null);
      setNotice(null);
      try {
        await fn();
        setNotice(`${label} succeeded.`);
        await reload();
        if (label === "Delete") void navigate("/apps");
      } catch (err) {
        setError(getErrorMessage(err, `${label} failed.`));
        await reload();
      } finally {
        setWorking(false);
      }
    },
    [reload, navigate],
  );

  const refreshJobs = useCallback(async () => {
    if (!id) return;
    try {
      setJobs(await listAppJobs(id));
    } catch (err) {
      setError(getErrorMessage(err, "Could not load deploy jobs."));
    }
  }, [id]);

  if (!id)
    return (
      <p role="alert" className="alert">
        Missing app id.
      </p>
    );
  const owned = data?.ownerKind === "solution";

  return (
    <section aria-labelledby="app-detail-heading">
      <p>
        <Link to="/apps" className="saga-link">
          ‹ Applications
        </Link>
      </p>
      <h1 id="app-detail-heading">{data ? data.name : "Application"}</h1>
      {data ? (
        <p className="summary-line" data-testid="app-summary">
          <code className="mono">{data.slug}</code> · <AppStatusLine status={data.status} ownerKind={data.ownerKind} />{" "}
          · {data.revision === null ? "no revision" : `r${data.revision}`}
          {data.activeDeployment ? (
            <>
              {" "}
              · active{" "}
              <code className="mono" title={data.activeDeployment.id}>
                {shortId(data.activeDeployment.id)}
              </code>
            </>
          ) : null}
        </p>
      ) : null}
      {owned ? (
        <p role="note" className="status-line">
          Solution-owned: read-only here. Change it through the bundle install path; live edits answer MANAGED_RESOURCE.
        </p>
      ) : null}
      <TokenForm token={token} onToken={setTokenState} onReload={() => void reload()} />
      {loading ? (
        <p role="status" className="status-line">
          Loading Application…
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
      {data ? (
        <>
          <h2>Source (revision {data.revision === null ? "—" : `r${data.revision}`})</h2>
          <form
            aria-label="Edit app source"
            onSubmit={(e) => {
              e.preventDefault();
              if (!id || owned) return;
              void run("Save source", () =>
                editAppSource(
                  id,
                  [{ path: STARTER_PATH, content: source }],
                  [{ name: "wrangnarok-ui", version: "1.0.0" }],
                ),
              );
            }}
          >
            <label htmlFor="app-source">index.html content (validated shape-only, never executed)</label>
            <textarea
              id="app-source"
              name="source"
              rows={6}
              cols={60}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              disabled={owned}
            />
            <div>
              <button type="submit" disabled={working || owned}>
                Save source
              </button>{" "}
              <button
                type="button"
                disabled={working || owned}
                onClick={() => void run("Validate", () => validateApp(id))}
              >
                Validate
              </button>{" "}
              <button
                type="button"
                disabled={working || owned}
                onClick={() => void run("Build", () => startAppBuild(id))}
              >
                Build and deploy
              </button>
            </div>
          </form>
          {data.revisions.length > 0 && data.revisions[data.revisions.length - 1]?.failures ? (
            <ul>
              {data.revisions[data.revisions.length - 1]?.failures?.map((failure) => (
                <li key={`${failure.field}:${failure.code}`} data-testid="app-failure">
                  <code className="mono">{failure.field}</code> · {failure.code}: {failure.message}
                </li>
              ))}
            </ul>
          ) : null}
          <h2>Deploy jobs</h2>
          <p>
            <button type="button" onClick={() => void refreshJobs()}>
              Refresh jobs
            </button>
          </p>
          {jobs && jobs.length > 0 ? (
            <ul>
              {jobs.map((job) => (
                <JobLine key={job.id} job={job} />
              ))}
            </ul>
          ) : (
            <p className="empty-state">No deploy jobs yet.</p>
          )}
          <h2>Recovery</h2>
          <p className="muted">
            No retained-history rollback exists: recover by fixing source and redeploying, or by swapping slugs with a
            parked copy of the previous app.
          </p>
          <form
            aria-label="Swap slugs with a parked app"
            onSubmit={(e) => {
              e.preventDefault();
              if (!id || !swapWith || owned) return;
              void run("Swap", () => swapAppSlugs(id, swapWith));
            }}
          >
            <label htmlFor="swap-with">Parked app id</label>
            <input
              id="swap-with"
              name="swapWith"
              type="text"
              autoComplete="off"
              value={swapWith}
              onChange={(e) => setSwapWith(e.target.value)}
              placeholder="app UUID holding the previous revision"
              disabled={owned}
            />
            <button type="submit" disabled={working || owned || !swapWith}>
              Swap slugs
            </button>
          </form>
          {id ? <AppEmbedsSection appId={id} /> : null}
          <h2>Danger</h2>
          <p>
            <button type="button" disabled={working || owned} onClick={() => void run("Delete", () => deleteApp(id))}>
              Delete this app
            </button>
          </p>
        </>
      ) : null}
    </section>
  );
}
