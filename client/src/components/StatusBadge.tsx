// SPDX-License-Identifier: AGPL-3.0
// Presentation-only status badge. Status is always rendered as text plus a
// decorative glyph so state is never conveyed by color alone.
import type { ExecutionStatus } from "../lib/client-types";

const KNOWN_STATUSES: ReadonlySet<string> = new Set<string>([
  "Succeeded",
  "Failed",
  "Running",
  "Pending",
  "Cancelling",
  "Cancelled",
  "TimedOut",
  // Authored-app lifecycle (APP-01, ADR 017): lowercase lifecycle + job states.
  // Operational notifications (OPS-01, ADR 020): lowercase job progress.
  "created",
  "ready",
  "building",
  "live",
  "failed",
  "queued",
  "running",
  "succeeded",
  "pending",
  "awaiting_action",
  "completed",
  "cancelled",
]);

const GLYPHS: Readonly<Record<string, string>> = {
  Succeeded: "✓",
  Failed: "✕",
  Running: "●",
  Pending: "○",
  Cancelling: "◌",
  Cancelled: "■",
  TimedOut: "◷",
  created: "○",
  ready: "○",
  building: "●",
  live: "✓",
  failed: "✕",
  queued: "○",
  running: "●",
  succeeded: "✓",
  pending: "○",
  awaiting_action: "◌",
  completed: "✓",
  cancelled: "■",
};

export function StatusBadge({ status }: { status: ExecutionStatus | string }): React.JSX.Element {
  const modifier = KNOWN_STATUSES.has(status) ? `badge--${status.toLowerCase()}` : "badge--unknown";
  const glyph = GLYPHS[status] ?? "•";
  return (
    <span className={`badge ${modifier}`}>
      <span aria-hidden="true" className="badge-glyph">
        {glyph}
      </span>
      {status}
    </span>
  );
}
