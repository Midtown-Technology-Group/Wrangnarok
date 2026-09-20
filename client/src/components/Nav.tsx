// SPDX-License-Identifier: AGPL-3.0
import { Link, NavLink } from "react-router-dom";
import type { BrandingView } from "../lib/client-types";

export interface NavEntry {
  label: string;
  to?: string;
  enabled: boolean;
  issue?: string;
  phase?: string;
}

/**
 * Roadmap-surface nav. Unported entries are visibly disabled AND link their
 * tracking issue so gray-out is honest, not theater. Server enforces the same
 * boundary: unmapped /api/* routes return UNIMPLEMENTED.
 *
 * UX-01 slice 1 (issue #176): the stale disabled "Integrations" entry is
 * gone. It pointed at #160, which has since closed (APP-02 shipped), and no
 * open issue tracks a separate Integrations page — the family is served by
 * the enabled Connections page (portable definitions plus org mappings,
 * CON-01 closed complete). A disabled entry that can name no honest owner
 * is theater, so it reads as removed rather than retargeted.
 */
export const NAV_ENTRIES: NavEntry[] = [
  { label: "History", to: "/history", enabled: true, phase: "Phase 4 (#17)" },
  {
    label: "Audit trail",
    to: "/audit",
    enabled: true,
    phase: "Phase 4 (#172)",
  },
  {
    label: "Notifications",
    to: "/notifications",
    enabled: true,
    phase: "Phase 4 (#172)",
  },
  {
    label: "Dashboard",
    to: "/dashboard",
    enabled: true,
    phase: "Phase 4 (#222)",
  },
  {
    label: "Sagas and Catalog",
    to: "/sagas",
    enabled: true,
    phase: "Phase 1 / Phase 4",
  },
  {
    label: "Admin",
    to: "/admin",
    enabled: true,
    phase: "Phase 3 (#142)",
  },
  {
    label: "Applications",
    to: "/apps",
    enabled: true,
    phase: "Phase 4 (#159)",
  },
  {
    label: "Files",
    to: "/files",
    enabled: true,
    phase: "Phase 4 (#157)",
  },
  {
    label: "Configuration",
    to: "/configs",
    enabled: true,
    phase: "Phase 3 (#147)",
  },
  {
    label: "Connections",
    to: "/connections",
    enabled: true,
    phase: "Phase 3 (#146)",
  },
  {
    label: "Operations",
    to: "/operations",
    enabled: true,
    phase: "Phase 4 (#558)",
  },
  {
    label: "Policy rules",
    to: "/policy-rules",
    enabled: true,
    phase: "Phase 4 (#560)",
  },
  {
    label: "Triggers",
    to: "/triggers",
    enabled: true,
    phase: "Phase 2 / Phase 4 (#557)",
  },
  {
    label: "Artifacts",
    to: "/artifacts",
    enabled: true,
    phase: "Phase 4 (#158)",
  },
  {
    label: "Forms",
    to: "/forms",
    enabled: true,
    phase: "Phase 4 (#155)",
  },
  {
    label: "Tables",
    to: "/tables",
    enabled: true,
    phase: "Phase 4 (#556)",
  },
  {
    label: "AI profiles",
    to: "/ai-profiles",
    enabled: true,
    phase: "Phase 6 (#164)",
  },
  {
    label: "Profile",
    to: "/profile",
    enabled: true,
    phase: "Phase 4 (#176)",
  },
  {
    label: "Branding",
    to: "/admin/branding",
    enabled: true,
    phase: "Phase 4 (#176)",
  },
];

/**
 * Brand mark, adapted from assets/brand/wrangnarok-mark.svg (at-rest SVG
 * source; gradient + currentColor halves preserved). Inline so the header
 * needs no extra asset request; decorative next to the wordmark.
 */
function BrandMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 256 256" aria-hidden="true" focusable="false" className="brand-mark">
      <defs>
        <linearGradient id="nav-ember" x1="32" y1="216" x2="132" y2="52" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F45D0B" />
          <stop offset="1" stopColor="#FFAD2F" />
        </linearGradient>
      </defs>
      <path
        d="M37 133A94 94 0 0 1 101 43"
        fill="none"
        stroke="url(#nav-ember)"
        strokeWidth="11"
        strokeLinecap="round"
      />
      <path
        d="M155 43a94 94 0 0 1 64 90"
        fill="none"
        stroke="currentColor"
        strokeWidth="11"
        strokeLinecap="round"
        opacity=".82"
      />
      <path d="M128 18l11 25 25 11-25 11-11 25-11-25-25-11 25-11z" fill="url(#nav-ember)" />
      <path d="M28 201l58-69v43l42-55v49l42-49v55l58-69v95l-58-55v67l-42-48-42 48v-67z" fill="currentColor" />
      <path d="M28 201l58-69v43l42-55v45l-42 48v-67z" fill="url(#nav-ember)" />
    </svg>
  );
}

/**
 * Shell header. Optional Organization branding (UX-01 slice 1): a loaded
 * view swaps the wordmark, swaps the static mark for the custom logo, and
 * recolors header accents through header-scoped token overrides. Absent
 * branding (loading, signed out, fetch failed) renders the static brand —
 * the shell never blocks on branding.
 */
export function Nav(props: { branding?: BrandingView | null }): React.JSX.Element {
  const branding = props.branding ?? null;
  const word = branding?.appName ?? "Wrangnarök";
  const headerStyle = branding
    ? ({
        "--wrangnarok-sunrise": branding.primaryColor,
        "--wrangnarok-amber": branding.accentColor,
      } as React.CSSProperties)
    : undefined;
  return (
    <header className="site-header" style={headerStyle}>
      <Link to="/history" className="brand" aria-label={`${word} home (Execution history)`}>
        {branding?.logo ? (
          <img
            className="brand-logo"
            src={`/api/branding/public/${branding.orgId}/logo`}
            alt=""
            aria-hidden="true"
            width={32}
            height={32}
          />
        ) : (
          <BrandMark />
        )}
        <span className="brand-word">{word}</span>
      </Link>
      <p className="brand-tagline">Automation across realms</p>
      <nav aria-label="Primary" className="nav">
        <ul className="nav-list">
          {NAV_ENTRIES.map((entry) =>
            entry.enabled && entry.to ? (
              <li key={entry.label}>
                <NavLink to={entry.to} className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
                  {entry.label}
                </NavLink>
              </li>
            ) : (
              <li
                key={entry.label}
                aria-disabled="true"
                title={`${entry.label} — not yet ported (${entry.phase})`}
                className="nav-item--disabled"
              >
                <span>
                  {entry.label} <span className="soon">(soon)</span>
                </span>{" "}
                {entry.issue ? (
                  <a href={entry.issue} target="_blank" rel="noreferrer" aria-label={`${entry.label} tracking issue`}>
                    {entry.issue.split("/").pop()} · {entry.phase}
                  </a>
                ) : null}
              </li>
            ),
          )}
        </ul>
      </nav>
    </header>
  );
}
