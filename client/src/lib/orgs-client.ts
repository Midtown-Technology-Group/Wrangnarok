// SPDX-License-Identifier: AGPL-3.0
// Typed fetch wrappers for the AUTH-01 admin APIs. Bearer fixture only,
// same as lib/api-client.ts.
import { parseApiError } from "./api-error";
import { getToken } from "./api-client";

export interface OrgSummary {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  disabledAt: string | null;
}

export interface MemberRow {
  userId: string;
  role: string;
  status: string;
  kind: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeletePreview {
  orgId: string;
  orgName: string;
  executions: number;
  operations: number;
  connectionsLoose: number;
  connectionsManaged: number;
  bundleInstalls: number;
  memberships: number;
  forms: number;
  apps: number;
  appsManaged: number;
  tables: number;
  tableRows: number;
  fileLocations: number;
  files: number;
  artifacts: number;
  endpoints: number;
  configsLoose: number;
  configsManaged: number;
  auditEvents: number;
  notifications: number;
  bundleActive: number;
  bundleOwnedRows: number;
  retained: string[];
  canDelete: boolean;
  blockedBy: string[];
}

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function read(response: Response): Promise<unknown> {
  if (!response.ok) throw await parseApiError(response);
  return (await response.json()) as unknown;
}

export async function fetchOrgs(): Promise<OrgSummary[]> {
  const data = (await read(await fetch("/api/orgs", { headers: headers() }))) as { orgs: OrgSummary[] };
  if (!Array.isArray(data.orgs)) throw new Error("Unexpected orgs response shape.");
  return data.orgs;
}

export async function createOrg(name: string): Promise<OrgSummary> {
  return (await read(
    await fetch("/api/orgs", { method: "POST", headers: headers(true), body: JSON.stringify({ name }) }),
  )) as OrgSummary;
}

export async function disableOrg(id: string): Promise<OrgSummary> {
  return (await read(await fetch(`/api/orgs/${id}/disable`, { method: "POST", headers: headers() }))) as OrgSummary;
}

export async function enableOrg(id: string): Promise<OrgSummary> {
  return (await read(await fetch(`/api/orgs/${id}/enable`, { method: "POST", headers: headers() }))) as OrgSummary;
}

export async function deletePreview(id: string): Promise<DeletePreview> {
  return (await read(await fetch(`/api/orgs/${id}/delete-preview`, { headers: headers() }))) as DeletePreview;
}

export async function deleteOrg(id: string): Promise<{ orgId: string }> {
  return (await read(await fetch(`/api/orgs/${id}`, { method: "DELETE", headers: headers() }))) as { orgId: string };
}

export async function fetchMembers(orgId: string): Promise<MemberRow[]> {
  const data = (await read(await fetch(`/api/orgs/${orgId}/members`, { headers: headers() }))) as {
    members: MemberRow[];
  };
  if (!Array.isArray(data.members)) throw new Error("Unexpected members response shape.");
  return data.members;
}

export async function inviteMember(orgId: string, userId: string, role: string, kind: string): Promise<MemberRow> {
  return (await read(
    await fetch(`/api/orgs/${orgId}/members`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ userId, role, kind }),
    }),
  )) as MemberRow;
}

export async function updateMember(orgId: string, userId: string, update: Record<string, string>): Promise<MemberRow> {
  return (await read(
    await fetch(`/api/orgs/${orgId}/members/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: headers(true),
      body: JSON.stringify(update),
    }),
  )) as MemberRow;
}

export async function disableUser(userId: string): Promise<{ userId: string }> {
  return (await read(
    await fetch(`/api/users/${encodeURIComponent(userId)}/disable`, { method: "POST", headers: headers() }),
  )) as { userId: string };
}

export async function enableUser(userId: string): Promise<{ userId: string }> {
  return (await read(
    await fetch(`/api/users/${encodeURIComponent(userId)}/enable`, { method: "POST", headers: headers() }),
  )) as { userId: string };
}
