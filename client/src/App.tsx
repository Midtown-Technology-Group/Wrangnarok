// SPDX-License-Identifier: AGPL-3.0
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { Nav } from "./components/Nav";
import { AdminOrgs } from "./pages/AdminOrgs";
import { ApplicationDetailView, ApplicationsList } from "./pages/Applications";
import { AuditList } from "./pages/Audit";
import { ArtifactDetailView, ArtifactsList } from "./pages/Artifacts";
import { ConfigsList } from "./pages/Configs";
import { ConnectionsList } from "./pages/Connections";
import { DashboardView } from "./pages/Dashboard";
import { ExecutionDetailView } from "./pages/ExecutionDetail";
import { ExecutionHistoryList } from "./pages/ExecutionHistory";
import { FilesList } from "./pages/Files";
import { FormDetailView, FormsList } from "./pages/Forms";
import { NotificationsList } from "./pages/Notifications";
import { SagasList } from "./pages/Sagas";

function FormRoute(): React.JSX.Element {
  const { name } = useParams();
  if (!name) return <p>Not found. Try Forms.</p>;
  return <FormDetailView name={name} />;
}

export function App(): React.JSX.Element {
  return (
    <div className="shell">
      <Nav />
      <main className="page">
        <Routes>
          <Route path="/" element={<Navigate to="/history" replace />} />
          <Route path="/history" element={<ExecutionHistoryList />} />
          <Route path="/history/:id" element={<ExecutionDetailView />} />
          <Route path="/dashboard" element={<DashboardView />} />
          <Route path="/sagas" element={<SagasList />} />
          <Route path="/configs" element={<ConfigsList />} />
          <Route path="/admin" element={<AdminOrgs />} />
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
          <Route path="*" element={<p>Not found. Try History.</p>} />
        </Routes>
      </main>
    </div>
  );
}
