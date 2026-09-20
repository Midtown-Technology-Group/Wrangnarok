// SPDX-License-Identifier: AGPL-3.0
import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { Nav } from "./components/Nav";
import { AdminOrgs } from "./pages/AdminOrgs";
import { AiProfilesList } from "./pages/AiProfiles";
import { ApplicationDetailView, ApplicationsList } from "./pages/Applications";
import { AuditList } from "./pages/Audit";
import { ArtifactDetailView, ArtifactsList } from "./pages/Artifacts";
import { BrandingAdmin } from "./pages/Branding";
import { ConfigsList } from "./pages/Configs";
import { ConnectionsList } from "./pages/Connections";
import { DashboardView } from "./pages/Dashboard";
import { ExecutionDetailView } from "./pages/ExecutionDetail";
import { ExecutionHistoryList } from "./pages/ExecutionHistory";
import { FilesList } from "./pages/Files";
import { FormDetailView, FormsList } from "./pages/Forms";
import { NotificationsList } from "./pages/Notifications";
import { applyTheme, OwnProfile } from "./pages/Profile";
import { SagasList } from "./pages/Sagas";
import { ToolsMcp } from "./pages/ToolsMcp";
import { fetchBranding, fetchProfile, getToken } from "./lib/api-client";
import { applyBrandingToDocument } from "./lib/brand-contrast";
import type { BrandingView } from "./lib/client-types";

function FormRoute(): React.JSX.Element {
  const { name } = useParams();
  if (!name) return <p>Not found. Try Forms.</p>;
  return <FormDetailView name={name} />;
}

/** Shell personalization (UX-01 slices 1-2): Organization branding for
 * the header plus the caller's theme preference. Slice 2 extends the brand
 * to the full document shell (title + theme-color) so tabs and mobile
 * chrome carry the custom name. Best-effort and silent: no token, failed
 * fetch, or missing document leaves the static brand and the default
 * theme — the shell never blocks on personalization. */
function useShellPersonalization(): BrandingView | null {
  const [branding, setBranding] = useState<BrandingView | null>(null);
  useEffect(() => {
    if (!getToken()) return;
    let live = true;
    void (async () => {
      try {
        const next = await fetchBranding();
        if (live) {
          setBranding(next.branding);
          applyBrandingToDocument(next.branding);
        }
      } catch {
        if (live) {
          setBranding(null);
          applyBrandingToDocument(null);
        }
      }
      try {
        const profile = await fetchProfile();
        if (live) applyTheme(profile.profile.theme);
      } catch {
        // Theme stays at the document default; the Profile page reports.
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return branding;
}

export function App(): React.JSX.Element {
  const branding = useShellPersonalization();
  return (
    <div className="shell">
      <Nav branding={branding} />
      <main className="page">
        <Routes>
          <Route path="/" element={<Navigate to="/history" replace />} />
          <Route path="/history" element={<ExecutionHistoryList />} />
          <Route path="/history/:id" element={<ExecutionDetailView />} />
          <Route path="/dashboard" element={<DashboardView />} />
          <Route path="/sagas" element={<SagasList />} />
          <Route path="/configs" element={<ConfigsList />} />
          <Route path="/admin" element={<AdminOrgs />} />
          <Route path="/admin/branding" element={<BrandingAdmin />} />
          <Route path="/profile" element={<OwnProfile />} />
          <Route path="/apps" element={<ApplicationsList />} />
          <Route path="/apps/:id" element={<ApplicationDetailView />} />
          <Route path="/audit" element={<AuditList />} />
          <Route path="/notifications" element={<NotificationsList />} />
          <Route path="/artifacts" element={<ArtifactsList />} />
          <Route path="/artifacts/:id" element={<ArtifactDetailView />} />
          <Route path="/files" element={<FilesList />} />
          <Route path="/forms" element={<FormsList />} />
          <Route path="/forms/:name" element={<FormRoute />} />
          <Route path="/connections" element={<ConnectionsList />} />
          <Route path="/ai-profiles" element={<AiProfilesList />} />
          <Route path="/tools-mcp" element={<ToolsMcp />} />
          <Route path="*" element={<p>Not found. Try History.</p>} />
        </Routes>
      </main>
    </div>
  );
}
