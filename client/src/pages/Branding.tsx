// SPDX-License-Identifier: AGPL-3.0
// Organization branding admin (UX-01 slice 1, issue #176). Layout borrowed
// (not verbatim) from client/src/pages/Files.tsx (token form,
// loading/error/notice states) and client/src/pages/Connections.tsx
// (read view plus managed write form).
//
// Members read the safe branding view; admins write name/colors, upload or
// remove the logo, and reset to the static defaults. The server gates every
// write (requireManageOrg); the role fetched here only decides which
// affordances render — a null role (instance-admin path) still shows the
// form, never a client-side denial.
import { useCallback, useEffect, useState } from "react";
import {
  deleteLogo,
  fetchBranding,
  fetchCaller,
  getToken,
  resetBranding,
  setToken,
  updateBranding,
  uploadLogo,
} from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { BrandingResponse, BrandingView } from "../lib/client-types";

export const LOGO_MIME_ALLOWLIST = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const LOGO_MAX_BYTES = 5 * 1024 * 1024;

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
      <label htmlFor="token">Bearer [REDACTED] (local fixture only, never committed)</label>
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

/** Public logo URL: dogfoods the safe unauthenticated branding read, so the
 * preview and the shell header render exactly what pre-auth consumers see. */
export function publicLogoUrl(orgId: string): string {
  return `/api/branding/public/${orgId}/logo`;
}

function precheckLogo(file: File): string | null {
  if (!(LOGO_MIME_ALLOWLIST as readonly string[]).includes(file.type.toLowerCase())) {
    return "Logos must be PNG, JPEG, GIF, or WebP images.";
  }
  if (file.size === 0) return "Logo bytes must not be empty.";
  if (file.size > LOGO_MAX_BYTES) return "Logo bytes must fit 5 MiB.";
  return null;
}

export function BrandingAdmin(props: {
  initial?: BrandingResponse;
  initialRole?: "member" | "admin" | null;
}): React.JSX.Element {
  const [token, setTokenValue] = useState(getToken());
  const [branding, setBranding] = useState<BrandingView | null>(props.initial?.branding ?? null);
  const [role, setRole] = useState<"member" | "admin" | null>(props.initialRole ?? null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [appName, setAppName] = useState(props.initial?.branding.appName ?? "");
  const [primaryColor, setPrimaryColor] = useState(props.initial?.branding.primaryColor ?? "");
  const [accentColor, setAccentColor] = useState(props.initial?.branding.accentColor ?? "");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const next = await fetchBranding();
      setBranding(next.branding);
      setAppName(next.branding.appName);
      setPrimaryColor(next.branding.primaryColor);
      setAccentColor(next.branding.accentColor);
      try {
        setRole((await fetchCaller()).role);
      } catch {
        // Caller-role failure never hides the form: the server gates writes.
        setRole(null);
      }
    } catch (err) {
      setBranding(null);
      setError(getErrorMessage(err, "Could not load branding."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (props.initial) return;
    void reload();
  }, [props.initial, reload]);

  async function onSave(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await updateBranding({ appName, primaryColor, accentColor });
      setBranding(next.branding);
      setNotice("Branding saved.");
    } catch (err) {
      setError(getErrorMessage(err, "Could not save branding."));
    } finally {
      setSaving(false);
    }
  }

  async function onReset(): Promise<void> {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await resetBranding();
      setBranding(next.branding);
      setAppName(next.branding.appName);
      setPrimaryColor(next.branding.primaryColor);
      setAccentColor(next.branding.accentColor);
      setNotice("Branding reset to defaults.");
    } catch (err) {
      setError(getErrorMessage(err, "Could not reset branding."));
    } finally {
      setSaving(false);
    }
  }

  async function onUpload(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) return;
    const file = fileList[0];
    if (!file) return;
    const rejected = precheckLogo(file);
    if (rejected) {
      setError(rejected);
      return;
    }
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const next = await uploadLogo(bytes, file.type.toLowerCase());
      setBranding(next.branding);
      setNotice("Logo uploaded.");
    } catch (err) {
      setError(getErrorMessage(err, "Could not upload the logo."));
    } finally {
      setUploading(false);
    }
  }

  async function onRemoveLogo(): Promise<void> {
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const next = await deleteLogo();
      setBranding(next.branding);
      setNotice("Logo removed.");
    } catch (err) {
      setError(getErrorMessage(err, "Could not remove the logo."));
    } finally {
      setUploading(false);
    }
  }

  const canWrite = role !== "member";

  return (
    <section aria-label="Organization branding">
      <h1>Branding</h1>
      <p className="muted">
        Your Organization&apos;s application name, colors, and logo. Members read this view; only Organization admins
        change it. The public branding read serves the same safe fields to pre-auth shells.
      </p>
      <TokenForm token={token} onToken={setTokenValue} onReload={() => void reload()} />
      {loading ? (
        <p role="status" className="status-line">
          Loading branding…
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
      {branding && !loading ? (
        <>
          <h2>Current branding</h2>
          <dl className="detail-grid">
            <dt>Application name</dt>
            <dd>{branding.appName}</dd>
            <dt>Primary color</dt>
            <dd>
              <span className="color-swatch" style={{ backgroundColor: branding.primaryColor }} aria-hidden="true" />{" "}
              <code className="mono">{branding.primaryColor}</code>
            </dd>
            <dt>Accent color</dt>
            <dd>
              <span className="color-swatch" style={{ backgroundColor: branding.accentColor }} aria-hidden="true" />{" "}
              <code className="mono">{branding.accentColor}</code>
            </dd>
            <dt>Logo</dt>
            <dd>
              {branding.logo ? (
                <img
                  className="logo-image"
                  src={publicLogoUrl(branding.orgId)}
                  alt={`${branding.appName} logo`}
                  width={96}
                  height={96}
                />
              ) : (
                <span className="empty-state">No custom logo; the static brand mark shows.</span>
              )}
            </dd>
          </dl>
          <h2>Preview</h2>
          <p className="brand-preview" style={{ borderColor: branding.primaryColor }}>
            <span className="brand-preview-word" style={{ color: branding.primaryColor }}>
              {branding.appName}
            </span>{" "}
            <span className="brand-preview-chip" style={{ backgroundColor: branding.accentColor }}>
              accent
            </span>
          </p>
          {canWrite ? (
            <>
              <h2>Admin settings</h2>
              <form className="token-form" onSubmit={(e) => void onSave(e)}>
                <label htmlFor="branding-app-name">Application name</label>
                <input
                  id="branding-app-name"
                  name="appName"
                  type="text"
                  autoComplete="off"
                  maxLength={80}
                  value={appName}
                  onChange={(e) => setAppName(e.target.value)}
                />
                <label htmlFor="branding-primary">Primary color (#rgb, #rrggbb, or #rrggbbaa)</label>
                <input
                  id="branding-primary"
                  name="primaryColor"
                  type="text"
                  autoComplete="off"
                  maxLength={9}
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                />
                <label htmlFor="branding-accent">Accent color (#rgb, #rrggbb, or #rrggbbaa)</label>
                <input
                  id="branding-accent"
                  name="accentColor"
                  type="text"
                  autoComplete="off"
                  maxLength={9}
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                />
                <button type="submit" disabled={saving}>
                  {saving ? "Saving…" : "Save branding"}
                </button>
                <button type="button" disabled={saving} onClick={() => void onReset()}>
                  Reset to defaults
                </button>
              </form>
              <h2>Logo</h2>
              <form className="token-form" onSubmit={(e) => e.preventDefault()}>
                <label htmlFor="branding-logo">Logo image (PNG, JPEG, GIF, or WebP, up to 5 MiB)</label>
                <input
                  id="branding-logo"
                  name="logo"
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  disabled={uploading}
                  onChange={(e) => void onUpload(e.target.files)}
                />
                {branding.logo ? (
                  <button type="button" disabled={uploading} onClick={() => void onRemoveLogo()}>
                    {uploading ? "Working…" : "Remove logo"}
                  </button>
                ) : null}
              </form>
              {uploading ? (
                <p role="status" className="status-line">
                  Uploading logo…
                </p>
              ) : null}
            </>
          ) : (
            <p className="muted">Branding writes need an Organization admin. This read-only view is current.</p>
          )}
        </>
      ) : null}
    </section>
  );
}
