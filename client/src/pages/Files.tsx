// SPDX-License-Identifier: AGPL-3.0
// Files page (FILE-01, issue #157; ADR 018). Layout borrowed (not verbatim)
// from client/src/pages/ExecutionHistory.tsx (token form,
// loading/error/empty states, truncated-mono + tooltip table pattern).
//
// Read slice plus browser upload/download against the same authorized
// routes as every other surface: declared locations, Organization-scoped
// structural listing, and Bearer-shape download. Uploads go through the
// finalize-after-upload flow the Worker verifies (slot, PUT bytes,
// finalize with asserted size/digest); the page never stores secrets.
import { useCallback, useEffect, useState } from "react";
import { createFileLocation, downloadFile, getToken, listFileLocations, listFiles, setToken } from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { FileLocation, FileMeta } from "../lib/client-types";
import { StatusBadge } from "../components/StatusBadge";

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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function FilesList(): React.JSX.Element {
  const [token, setTokenValue] = useState(getToken());
  const [locations, setLocations] = useState<FileLocation[]>([]);
  const [selected, setSelected] = useState("");
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [uploading, setUploading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const listed = await listFileLocations();
      setLocations(listed.locations);
      const current = selected || listed.locations[0]?.name || "";
      setSelected(current);
      if (current) {
        const page = await listFiles(current);
        setFiles(page.files);
      } else {
        setFiles([]);
      }
    } catch (err) {
      setError(getErrorMessage(err, "Could not load Files."));
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onSelect(location: string): Promise<void> {
    setSelected(location);
    setError(null);
    try {
      const page = await listFiles(location);
      setFiles(page.files);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load Files."));
      setFiles([]);
    }
  }

  async function onCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await createFileLocation(newName.trim());
      setNewName("");
      setNotice(`Location declared.`);
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not load Files."));
    }
  }

  async function onUploadFiles(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0 || !selected) return;
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const stored = getToken();
      if (stored) headers["Authorization"] = `Bearer ${stored}`;
      for (const file of fileList) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const digest = await sha256Hex(bytes);
        const slotRes = await fetch("/api/files/uploads", {
          method: "POST",
          headers,
          body: JSON.stringify({ entries: [{ location: selected, path: file.name }] }),
        });
        if (!slotRes.ok) throw new Error(`Upload slot failed: HTTP ${slotRes.status}.`);
        const slot = (await slotRes.json()) as { entries: { allowed: boolean; token?: string }[] };
        const entry = slot.entries[0];
        if (!entry?.allowed || !entry.token) throw new Error("Upload denied for this location.");
        const putRes = await fetch(`/api/files/content?token=${entry.token}`, {
          method: "PUT",
          headers: {
            ...(stored ? { Authorization: `Bearer ${stored}` } : {}),
            "Content-Type": file.type || "application/octet-stream",
          },
          body: bytes as Uint8Array<ArrayBuffer>,
        });
        if (!putRes.ok) throw new Error(`Upload PUT failed: HTTP ${putRes.status}.`);
        const finRes = await fetch("/api/files/finalize", {
          method: "POST",
          headers,
          body: JSON.stringify({
            location: selected,
            path: file.name,
            contentType: (file.type || "application/octet-stream").toLowerCase(),
            size: bytes.byteLength,
            sha256: digest,
          }),
        });
        if (!finRes.ok) throw new Error(`Upload finalize failed: HTTP ${finRes.status}.`);
      }
      setNotice(`${fileList.length} file(s) uploaded and verified.`);
      const page = await listFiles(selected);
      setFiles(page.files);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load Files."));
    } finally {
      setUploading(false);
    }
  }

  async function onDownload(path: string): Promise<void> {
    setError(null);
    try {
      const blob = await downloadFile(selected, path);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = path.split("/").pop() || "download";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load Files."));
    }
  }

  return (
    <section aria-label="Managed files">
      <h1>Files</h1>
      <p className="muted">
        Managed file locations with policy-checked upload and download. Writes land in declared locations only; the
        server verifies every upload before it becomes readable.
      </p>
      <TokenForm token={token} onToken={setTokenValue} onReload={() => void reload()} />
      {loading ? <p>Loading locations…</p> : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}
      {!loading && locations.length === 0 && !error ? <p>No file locations yet. Declare one below.</p> : null}
      {locations.length > 0 ? (
        <div className="row">
          <label htmlFor="location">Location</label>
          <select id="location" value={selected} onChange={(e) => void onSelect(e.target.value)}>
            {locations.map((location) => (
              <option key={location.name} value={location.name}>
                {location.name} (max {location.maxBytes} bytes{location.sharedRead ? ", shared read" : ""})
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {selected ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Path</th>
              <th scope="col">Status</th>
              <th scope="col">Version</th>
              <th scope="col">Size</th>
              <th scope="col">Type</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr key={file.path} data-testid="file-row">
                <td>
                  <code className="mono" title={file.sha256}>
                    {file.path}
                  </code>
                </td>
                <td>
                  <StatusBadge status={file.status === "ready" ? "Succeeded" : "Pending"} />
                </td>
                <td className="cell--numeric">v{file.version}</td>
                <td className="cell--numeric">{file.size}</td>
                <td>
                  <span className="muted muted--small">{file.contentType}</span>
                </td>
                <td>
                  {file.status === "ready" ? (
                    <button type="button" onClick={() => void onDownload(file.path)}>
                      Download
                    </button>
                  ) : (
                    <span className="muted muted--small">unverified</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {selected && files.length === 0 && !loading ? <p>No files in this location yet.</p> : null}
      <form onSubmit={(e) => void onCreate(e)} className="row">
        <label htmlFor="new-location">Declare a location</label>
        <input
          id="new-location"
          name="new-location"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="uploads"
        />
        <button type="submit">Declare</button>
      </form>
      {selected ? (
        <div className="row">
          <label htmlFor="upload">Upload to {selected}</label>
          <input
            id="upload"
            name="upload"
            type="file"
            multiple
            disabled={uploading}
            onChange={(e) => void onUploadFiles(e.target.files)}
          />
          {uploading ? <span className="muted">Uploading…</span> : null}
        </div>
      ) : null}
    </section>
  );
}
