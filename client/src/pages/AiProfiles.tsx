// SPDX-License-Identifier: AGPL-3.0
// AI model profiles (AI-01, issue #164). Layout borrowed (not verbatim)
// from client/src/pages/Connections.tsx (token form, loading/error/empty
// states, truncated-mono ID + tooltip table pattern).
//
// Identities-only surface: profile names, assignment keys, capability
// summaries, and resolution results. Provider model ids and deployment
// keys never reach the browser — the server excludes them by construction,
// so there is nothing here to redact, only nothing to show.
import { useCallback, useEffect, useState } from "react";
import {
  getAiBehavior,
  getAiEmbedding,
  getToken,
  listAiAssignments,
  listAiProfiles,
  resolveAiAssignment,
  setAiAssignment,
  setToken,
} from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type {
  AiAssignmentsResponse,
  AiBehaviorResponse,
  AiEmbeddingResponse,
  AiProfilesResponse,
  AiResolutionResponse,
} from "../lib/client-types";

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export interface AiProfilesInitial {
  profiles?: AiProfilesResponse;
  assignments?: AiAssignmentsResponse;
  embedding?: AiEmbeddingResponse;
  behavior?: AiBehaviorResponse;
}

export function AiProfilesList(props: { initial?: AiProfilesInitial }): React.JSX.Element {
  const [profiles, setProfiles] = useState<AiProfilesResponse | null>(props.initial?.profiles ?? null);
  const [assignments, setAssignments] = useState<AiAssignmentsResponse | null>(props.initial?.assignments ?? null);
  const [embedding, setEmbedding] = useState<AiEmbeddingResponse | null>(props.initial?.embedding ?? null);
  const [behavior, setBehavior] = useState<AiBehaviorResponse | null>(props.initial?.behavior ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());
  const [assignKey, setAssignKey] = useState("tuning");
  const [assignProfile, setAssignProfile] = useState("");
  const [saving, setSaving] = useState(false);
  const [resolveKey, setResolveKey] = useState("primary");
  const [resolution, setResolution] = useState<AiResolutionResponse | null>(null);
  const [resolving, setResolving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextProfiles, nextAssignments, nextEmbedding, nextBehavior] = await Promise.all([
        listAiProfiles(),
        listAiAssignments(),
        getAiEmbedding(),
        getAiBehavior(),
      ]);
      setProfiles(nextProfiles);
      setAssignments(nextAssignments);
      setEmbedding(nextEmbedding);
      setBehavior(nextBehavior);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load AI profiles."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        const [nextProfiles, nextAssignments, nextEmbedding, nextBehavior] = await Promise.all([
          listAiProfiles(),
          listAiAssignments(),
          getAiEmbedding(),
          getAiBehavior(),
        ]);
        if (cancelled) return;
        setProfiles(nextProfiles);
        setAssignments(nextAssignments);
        setEmbedding(nextEmbedding);
        setBehavior(nextBehavior);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load AI profiles."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial]);

  async function handleAssign(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await setAiAssignment(assignKey, assignProfile === "" ? null : assignProfile);
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not set the assignment."));
    } finally {
      setSaving(false);
    }
  }

  async function handleResolve(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setResolving(true);
    setError(null);
    try {
      setResolution(await resolveAiAssignment(resolveKey));
    } catch (err) {
      setResolution(null);
      setError(getErrorMessage(err, "This assignment does not resolve to a usable profile."));
    } finally {
      setResolving(false);
    }
  }

  return (
    <section aria-labelledby="ai-profiles-heading">
      <h1 id="ai-profiles-heading">AI profiles</h1>
      <p className="muted">
        Reusable model profile identities for this Organization. Provider model ids and API keys are never shown here —
        the server answers identities only.
      </p>
      <form
        className="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(token);
          void reload();
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
          Loading AI profiles…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="alert">
          {error}
        </p>
      ) : null}
      {profiles ? (
        <>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Profile</th>
                  <th scope="col">Provider</th>
                  <th scope="col">Chat</th>
                  <th scope="col">Capabilities</th>
                  <th scope="col">Capability state</th>
                  <th scope="col">Transport</th>
                </tr>
              </thead>
              <tbody>
                {profiles.profiles.map((entry) => (
                  <tr key={entry.id} data-testid="ai-profile-row">
                    <td>
                      <span className="saga-link">{entry.name}</span>{" "}
                      <code className="mono mono--truncate" title={entry.id}>
                        {shortId(entry.id)}
                      </code>
                    </td>
                    <td>{entry.integrationName}</td>
                    <td>{entry.enabledForChat ? "enabled" : "disabled"}</td>
                    <td>
                      {Object.keys(entry.capabilities).length === 0 ? (
                        <span className="muted">none</span>
                      ) : (
                        Object.keys(entry.capabilities)
                          .sort()
                          .map((name) => (
                            <code key={name} className="mono">
                              {name}
                            </code>
                          ))
                      )}
                    </td>
                    <td>{entry.capabilityState}</td>
                    <td>{entry.openaiTransport ?? <span className="muted">auto</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {profiles.profiles.length === 0 ? (
            <p className="empty-state">No model profiles configured for this Organization yet.</p>
          ) : null}
        </>
      ) : null}
      {assignments ? (
        <>
          <h2>Capability assignments</h2>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Profile</th>
                </tr>
              </thead>
              <tbody>
                {assignments.assignments.map((entry) => (
                  <tr key={entry.key} data-testid="ai-assignment-row">
                    <td>
                      <code className="mono">{entry.key}</code>
                    </td>
                    <td>
                      {entry.profile ? (
                        <>
                          <span className="saga-link">{entry.profile.name}</span>{" "}
                          <code className="mono mono--truncate" title={entry.profile.id}>
                            {shortId(entry.profile.id)}
                          </code>
                        </>
                      ) : (
                        <span className="muted">unmapped</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form className="connection-form" onSubmit={(e) => void handleAssign(e)}>
            <h2>Set an assignment</h2>
            <p className="muted">Admin only. Clearing primary or chat_default is rejected by the server.</p>
            <label htmlFor="assignKey">Key</label>
            <select id="assignKey" value={assignKey} onChange={(e) => setAssignKey(e.target.value)}>
              {(assignments.assignments.map((entry) => entry.key) as string[]).map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
            <label htmlFor="assignProfile">Profile (blank clears)</label>
            <select id="assignProfile" value={assignProfile} onChange={(e) => setAssignProfile(e.target.value)}>
              <option value="">unmapped</option>
              {(profiles?.profiles ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
            <button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Set assignment"}
            </button>
          </form>
          <form className="connection-form" onSubmit={(e) => void handleResolve(e)}>
            <h2>Resolve an assignment</h2>
            <p className="muted">Read-only: answers the usable profile or fails closed.</p>
            <label htmlFor="resolveKey">Key</label>
            <select id="resolveKey" value={resolveKey} onChange={(e) => setResolveKey(e.target.value)}>
              {(assignments.assignments.map((entry) => entry.key) as string[]).map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
            <button type="submit" disabled={resolving}>
              {resolving ? "Resolving…" : "Resolve"}
            </button>
            {resolution ? (
              <p className="status-line" data-testid="ai-resolution">
                {resolution.resolution.key} → {resolution.resolution.profile.name} (
                {resolution.resolution.profile.integrationName})
              </p>
            ) : null}
          </form>
        </>
      ) : null}
      {embedding || behavior ? (
        <>
          <h2>Embedding and behavior</h2>
          <p className="muted">
            Embedding:{" "}
            {embedding?.embedding ? (
              <>
                {embedding.embedding.integrationName}
                {embedding.embedding.dimensions === null ? "" : ` · ${embedding.embedding.dimensions} dimensions`}
              </>
            ) : (
              "unconfigured"
            )}
          </p>
          <p className="muted">
            Default system prompt: {behavior?.behavior ? behavior.behavior.defaultSystemPrompt : "unconfigured"}
          </p>
        </>
      ) : null}
    </section>
  );
}
