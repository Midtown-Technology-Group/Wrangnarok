// SPDX-License-Identifier: AGPL-3.0
// Artifacts pages (FILE-02, issue #158; ADR 019). Layout borrowed (not
// verbatim) from client/src/pages/Applications.tsx (token form,
// loading/error/empty states, truncated-mono ID + tooltip table pattern).
//
// List/detail over the same routes as the CLI: summaries carry no bytes;
// detail shows versions and attachment bindings. Uploads and retention
// administration stay CLI/operator-owned in v1; the UI never sends bytes.
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchArtifactDetail, getToken, listArtifactFormats, listArtifacts, setToken } from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { ArtifactDetail, ArtifactFormat, ArtifactsResponse } from "../lib/client-types";
import { StatusBadge } from "../components/StatusBadge";

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}\u2026` : id;
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

export function ArtifactsList(props: { initial?: ArtifactsResponse }): React.JSX.Element {
  const [data, setData] = useState<ArtifactsResponse | null>(props.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());
  const [formats, setFormats] = useState<ArtifactFormat[] | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    listArtifacts()
      .then((response) => {
        setData(response);
        setLoading(false);
      })
      .catch((failure: unknown) => {
        setError(getErrorMessage(failure, "Could not load Artifacts."));
        setLoading(false);
      });
    listArtifactFormats()
      .then(setFormats)
      .catch(() => setFormats(null));
  }, []);

  useEffect(() => {
    if (!props.initial) reload();
  }, [props.initial, reload]);

  return (
    <section aria-label="Artifacts">
      <h1>Artifacts</h1>
      <TokenForm token={token} onToken={setTokenState} onReload={reload} />
      {loading ? <p>Loading artifacts.</p> : null}
      {error ? <p role="alert">Artifacts failed: {error}</p> : null}
      {!loading && !error && (!data || data.artifacts.length === 0) ? (
        <p>No artifacts yet. Upload one with the CLI: PUT /api/artifacts?name=notes.md.</p>
      ) : null}
      {data && data.artifacts.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">ID</th>
              <th scope="col">Name</th>
              <th scope="col">Version</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.artifacts.map((entry) => (
              <tr key={entry.id}>
                <td>
                  <Link to={`/artifacts/${entry.id}`}>
                    <code className="mono" title={entry.id}>
                      {shortId(entry.id)}
                    </code>
                  </Link>
                </td>
                <td>{entry.name}</td>
                <td>v{entry.version}</td>
                <td>
                  <StatusBadge status={entry.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {formats ? (
        <p className="muted muted--small">
          Generated-output formats (all deferred, no rendering on Workers):{" "}
          {formats.map((entry) => `${entry.format} (${entry.status})`).join(", ")}
        </p>
      ) : null}
    </section>
  );
}

export function ArtifactDetailView(props: { initial?: ArtifactDetail }): React.JSX.Element {
  const { id } = useParams();
  const [data, setData] = useState<ArtifactDetail | null>(props.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());

  const reload = useCallback(() => {
    if (!id && !props.initial) return;
    const target = id ?? props.initial?.id;
    if (!target) return;
    setLoading(true);
    setError(null);
    fetchArtifactDetail(target)
      .then((response) => {
        setData(response);
        setLoading(false);
      })
      .catch((failure: unknown) => {
        setError(getErrorMessage(failure, "Could not load Artifact."));
        setLoading(false);
      });
  }, [id, props.initial]);

  useEffect(() => {
    if (!props.initial) reload();
  }, [reload, props.initial]);

  return (
    <section aria-label="Artifact detail">
      <p>
        <Link to="/artifacts">Artifacts</Link>
      </p>
      <TokenForm token={token} onToken={setTokenState} onReload={reload} />
      {loading ? <p>Loading artifact.</p> : null}
      {error ? <p role="alert">Artifact failed: {error}</p> : null}
      {data ? (
        <article>
          <h1>{data.name}</h1>
          <p className="muted">
            <code className="mono" title={data.id}>
              {shortId(data.id)}
            </code>{" "}
            v{data.version} · {data.mime} · {data.sizeBytes} bytes · <StatusBadge status={data.status} />
          </p>
          <h2>Versions</h2>
          <ul>
            {data.versions.map((entry) => (
              <li key={entry.version} data-testid="artifact-version">
                v{entry.version} · {entry.mime} · {entry.sizeBytes} bytes
              </li>
            ))}
          </ul>
          <h2>Attachment bindings</h2>
          {data.bindings.length === 0 ? (
            <p className="muted">No attachment bindings.</p>
          ) : (
            <ul>
              {data.bindings.map((entry) => (
                <li key={`${entry.scope}:${entry.refId}`} data-testid="artifact-binding">
                  {entry.scope}:{entry.refId}
                </li>
              ))}
            </ul>
          )}
        </article>
      ) : null}
    </section>
  );
}
