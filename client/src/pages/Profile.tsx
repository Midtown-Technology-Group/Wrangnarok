// SPDX-License-Identifier: AGPL-3.0
// Own profile page (UX-01 slice 1, issue #176). Layout borrowed (not verbatim)
// from client/src/pages/Files.tsx (token form, loading/error/notice states,
// labeled-field + button patterns).
//
// Caller-scoped only: display name, theme preference, avatar upload/remove.
// Password/security settings are absent by design — identity is IdP-owned
// (Access) per AUTH-03, and no second credential store may grow here.
import { useCallback, useEffect, useState } from "react";
import {
  deleteAvatar,
  downloadAvatar,
  fetchProfile,
  getToken,
  setToken,
  updateProfile,
  uploadAvatar,
} from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { ProfileResponse, ProfileTheme, ProfileView } from "../lib/client-types";

export const AVATAR_MIME_ALLOWLIST = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"] as const;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

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

/** Apply the caller's theme preference to the document shell. Guarded for
 * non-DOM renders (SSR in tests): no document, no-op. */
export function applyTheme(theme: ProfileTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset["theme"] = theme;
}

function precheckAvatar(file: File): string | null {
  if (!(AVATAR_MIME_ALLOWLIST as readonly string[]).includes(file.type.toLowerCase())) {
    return "Avatars must be PNG, JPEG, GIF, WebP, or SVG images.";
  }
  if (file.size === 0) return "Avatar bytes must not be empty.";
  if (file.size > AVATAR_MAX_BYTES) return "Avatar bytes must fit 2 MiB.";
  return null;
}

export function OwnProfile(props: { initial?: ProfileResponse }): React.JSX.Element {
  const [token, setTokenValue] = useState(getToken());
  const [profile, setProfile] = useState<ProfileView | null>(props.initial?.profile ?? null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(props.initial?.profile.displayName ?? "");
  const [theme, setTheme] = useState<ProfileTheme>(props.initial?.profile.theme ?? "system");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const next = await fetchProfile();
      setProfile(next.profile);
      setDisplayName(next.profile.displayName);
      setTheme(next.profile.theme);
      applyTheme(next.profile.theme);
    } catch (err) {
      setProfile(null);
      setError(getErrorMessage(err, "Could not load your profile."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (props.initial) {
      applyTheme(props.initial.profile.theme);
      return;
    }
    void reload();
  }, [props.initial, reload]);

  // Owner-only avatar bytes through the authorized route; revoked on change.
  useEffect(() => {
    if (!profile?.avatar) {
      setAvatarUrl(null);
      return;
    }
    let live = true;
    let url: string | null = null;
    void (async () => {
      try {
        const blob = await downloadAvatar();
        if (!live) return;
        url = URL.createObjectURL(blob);
        setAvatarUrl(url);
      } catch {
        if (live) setAvatarUrl(null);
      }
    })();
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [profile]);

  async function onSave(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await updateProfile({ displayName, theme });
      setProfile(next.profile);
      applyTheme(next.profile.theme);
      setNotice("Profile saved.");
    } catch (err) {
      setError(getErrorMessage(err, "Could not save your profile."));
    } finally {
      setSaving(false);
    }
  }

  async function onUpload(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) return;
    const file = fileList[0];
    if (!file) return;
    const rejected = precheckAvatar(file);
    if (rejected) {
      setError(rejected);
      return;
    }
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const next = await uploadAvatar(bytes, file.type.toLowerCase());
      setProfile(next.profile);
      setNotice("Avatar uploaded.");
    } catch (err) {
      setError(getErrorMessage(err, "Could not upload your avatar."));
    } finally {
      setUploading(false);
    }
  }

  async function onRemoveAvatar(): Promise<void> {
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const next = await deleteAvatar();
      setProfile(next.profile);
      setNotice("Avatar removed.");
    } catch (err) {
      setError(getErrorMessage(err, "Could not remove your avatar."));
    } finally {
      setUploading(false);
    }
  }

  return (
    <section aria-label="Your profile">
      <h1>Profile</h1>
      <p className="muted">
        Your display name, theme preference, and avatar. Only you see this page&apos;s data; sign-in and security stay
        with your Organization&apos;s identity provider.
      </p>
      <TokenForm token={token} onToken={setTokenValue} onReload={() => void reload()} />
      {loading ? (
        <p role="status" className="status-line">
          Loading your profile…
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
      {profile && !loading ? (
        <>
          <form className="token-form" onSubmit={(e) => void onSave(e)}>
            <label htmlFor="profile-display-name">Display name</label>
            <input
              id="profile-display-name"
              name="displayName"
              type="text"
              autoComplete="nickname"
              maxLength={80}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Ada Lovelace"
            />
            <label htmlFor="profile-theme">Theme</label>
            <select
              id="profile-theme"
              name="theme"
              value={theme}
              onChange={(e) => setTheme(e.target.value as ProfileTheme)}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
            <button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save profile"}
            </button>
          </form>
          <h2>Avatar</h2>
          {avatarUrl ? (
            <p>
              <img className="avatar-image" src={avatarUrl} alt="Your avatar" width={96} height={96} />
            </p>
          ) : (
            <p className="empty-state">No avatar set.</p>
          )}
          <form className="token-form" onSubmit={(e) => e.preventDefault()}>
            <label htmlFor="profile-avatar">Avatar image (PNG, JPEG, GIF, WebP, or SVG, up to 2 MiB)</label>
            <input
              id="profile-avatar"
              name="avatar"
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
              disabled={uploading}
              onChange={(e) => void onUpload(e.target.files)}
            />
            {profile.avatar ? (
              <button type="button" disabled={uploading} onClick={() => void onRemoveAvatar()}>
                {uploading ? "Working…" : "Remove avatar"}
              </button>
            ) : null}
          </form>
          {uploading ? (
            <p role="status" className="status-line">
              Uploading avatar…
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
