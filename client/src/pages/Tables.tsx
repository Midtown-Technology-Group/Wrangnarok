// SPDX-License-Identifier: AGPL-3.0
// Tables pages (issue #556): table explorer and row administration over the
// real /api/tables routes (TABLE-01/TABLE-02). Layout borrowed (not verbatim)
// from client/src/pages/Files.tsx (token form, loading/error/empty states,
// truncated-mono + tooltip table pattern).
//
// No realtime subscriptions exist on the Worker: every section refreshes
// through an explicit bounded button (manual re-query), and the page says
// so instead of implying push.
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getToken, setToken } from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import {
  batchDeleteTableRows,
  batchWriteTableRows,
  countTableRows,
  createTable,
  deleteTable,
  deleteTableRow,
  fetchTable,
  grantTableAccess,
  insertTableRow,
  listTables,
  queryTableRows,
  readTableRow,
  revokeTableAccess,
  updateTableRow,
} from "../lib/tables-client";
import type {
  TableBatchItemResult,
  TableGrantAction,
  TablePage,
  TableRowDoc,
  TableSummary,
  TablesResponse,
  TableWriteMode,
} from "../lib/tables-client";

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

function preview(data: Record<string, unknown>): string {
  const text = JSON.stringify(data);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function totalLabel(total: number): string {
  if (total === -1) return "count skipped";
  if (total === -2) return "count bounded (more than the scan window)";
  return `${total} matching row${total === 1 ? "" : "s"}`;
}

export function TablesList(props: { initial?: TablesResponse }): React.JSX.Element {
  const [data, setData] = useState<TablesResponse | null>(props.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());
  const [newName, setNewName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    listTables()
      .then((response) => {
        setData(response);
        setLoading(false);
      })
      .catch((failure: unknown) => {
        setError(getErrorMessage(failure, "Could not load Tables."));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!props.initial) reload();
  }, [props.initial, reload]);

  async function onCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const created = await createTable(newName.trim());
      setNewName("");
      setNotice(`Table "${created.name}" declared. You own it.`);
      const response = await listTables();
      setData(response);
    } catch (failure) {
      setError(getErrorMessage(failure, "Could not create Table."));
    }
  }

  return (
    <section aria-label="Tables">
      <h1>Tables</h1>
      <p className="muted">
        Organization-scoped JSON-document tables. Fresh tables are visible to their owner only until a grant names
        someone else. No live updates — press Refresh to re-query.
      </p>
      <TokenForm token={token} onToken={setTokenState} onReload={reload} />
      <div className="row">
        <button type="button" onClick={reload} disabled={loading}>
          Refresh
        </button>
      </div>
      {loading ? <p>Loading tables.</p> : null}
      {error ? (
        <p role="alert" className="error">
          Tables failed: {error}
        </p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}
      {!loading && !error && (!data || data.tables.length === 0) ? <p>No tables yet. Declare one below.</p> : null}
      {data && data.tables.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Owner</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {data.tables.map((entry) => (
              <tr key={entry.id} data-testid="table-row">
                <td>
                  <Link to={`/tables/${entry.name}`}>
                    <code className="mono" title={entry.id}>
                      {entry.name}
                    </code>
                  </Link>
                </td>
                <td>
                  <code className="mono" title={entry.ownerUserId}>
                    {entry.ownerUserId.length > 12 ? `${entry.ownerUserId.slice(0, 8)}…` : entry.ownerUserId}
                  </code>
                </td>
                <td>
                  <span className="muted muted--small">{entry.createdAt}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <form onSubmit={(e) => void onCreate(e)} className="row">
        <label htmlFor="new-table">Declare a table</label>
        <input
          id="new-table"
          name="new-table"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="notes"
        />
        <button type="submit">Declare</button>
      </form>
    </section>
  );
}

function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Documents must be JSON objects.");
  }
  return value as Record<string, unknown>;
}

export function TableDetailView(props: { initial?: TableSummary; initialRows?: TablePage }): React.JSX.Element {
  const { name } = useParams();
  const tableName = name ?? props.initial?.name ?? "";
  const [table, setTable] = useState<TableSummary | null>(props.initial ?? null);
  const [rows, setRows] = useState<TablePage | null>(props.initialRows ?? null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [token, setTokenState] = useState(getToken());
  const [filter, setFilter] = useState("");
  const [prefix, setPrefix] = useState("");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [limit, setLimit] = useState("20");
  const [skipCount, setSkipCount] = useState(false);
  const [docIds, setDocIds] = useState("");
  const [cursor, setCursor] = useState<string | null>(props.initialRows?.nextCursor ?? null);
  const [docId, setDocId] = useState("");
  const [docBody, setDocBody] = useState('{\n  "title": "hello"\n}');
  const [batchMode, setBatchMode] = useState<TableWriteMode>("insert");
  const [batchBody, setBatchBody] = useState('[\n  { "id": "a", "data": { "title": "hello" } }\n]');
  const [batchDeleteIds, setBatchDeleteIds] = useState("");
  const [batchResults, setBatchResults] = useState<TableBatchItemResult[] | null>(null);
  const [grantAction, setGrantAction] = useState<TableGrantAction>("read");
  const [grantee, setGrantee] = useState("");

  const reloadTable = useCallback(async () => {
    if (!tableName) return;
    setLoading(true);
    setError(null);
    try {
      setTable(await fetchTable(tableName));
    } catch (failure) {
      setError(getErrorMessage(failure, "Could not load Table."));
      setTable(null);
    } finally {
      setLoading(false);
    }
  }, [tableName]);

  const runQuery = useCallback(
    async (nextCursor?: string | null) => {
      if (!tableName) return;
      setRowsLoading(true);
      setError(null);
      try {
        const page = await queryTableRows(tableName, {
          ...(filter.trim() ? { filters: [filter.trim()] } : {}),
          ...(docIds.trim()
            ? {
                documentIds: docIds
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter((entry) => entry),
              }
            : {}),
          ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
          order,
          skipCount,
          limit: Number(limit) || 20,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        });
        setRows(page);
        setCursor(page.nextCursor);
      } catch (failure) {
        setError(getErrorMessage(failure, "Could not query rows."));
        setRows(null);
      } finally {
        setRowsLoading(false);
      }
    },
    [tableName, filter, docIds, prefix, order, skipCount, limit],
  );

  useEffect(() => {
    if (!props.initial) void reloadTable();
  }, [props.initial, reloadTable]);

  useEffect(() => {
    if (!props.initialRows && tableName) void runQuery(null);
  }, [props.initialRows, tableName, runQuery]);

  async function onRefreshCount(): Promise<void> {
    if (!tableName) return;
    setError(null);
    try {
      const counted = await countTableRows(tableName, {
        ...(filter.trim() ? { filters: [filter.trim()] } : {}),
        ...(docIds.trim()
          ? {
              documentIds: docIds
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry),
            }
          : {}),
        ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
        skipCount,
      });
      setRows((current) =>
        current
          ? { ...current, total: counted.total }
          : { rows: [], hasMore: false, nextCursor: null, total: counted.total },
      );
      setNotice(`Count refreshed: ${totalLabel(counted.total)}.`);
    } catch (failure) {
      setError(getErrorMessage(failure, "Could not count rows."));
    }
  }

  async function onInsert(): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      const row = await insertTableRow(tableName, docId.trim(), parseJsonObject(docBody));
      setNotice(`Inserted "${row.id}".`);
      await runQuery(null);
    } catch (failure) {
      setError(getErrorMessage(failure, "Could not insert row."));
    }
  }

  async function onReplace(): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      const row = await updateTableRow(tableName, docId.trim(), parseJsonObject(docBody));
      setNotice(`Replaced "${row.id}".`);
      await runQuery(null);
    } catch (failure) {
      setError(getErrorMessage(failure, "Could not replace row."));
    }
  }

  async function onViewRow(id: string): Promise<void> {
    setError(null);
    try {
      const row = await readTableRow(tableName, id);
      setDocId(row.id);
      setDocBody(JSON.stringify(row.data, null, 2));
    } catch (failure) {
      setError(getErrorMessage(failure, "Could not read row."));
    }
  }

  async function onDeleteRow(id: string): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await deleteTableRow(tableName, id);
      setNotice(`Deleted "${id}".`);
      await runQuery(null);
    } catch (failure) {
      setError(getErrorMessage(failure, "Could not delete row."));
    }
  }

  async function onBatchWrite(): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      const items: unknown = JSON.parse(batchBody);
      if (!Array.isArray(items)) throw new Error("Batch items must be a JSON array of { id?, data }.");
      const result = await batchWriteTableRows(tableName, { write_mode: batchMode, items: items as never });
      setBatchResults(result.results);
      setNotice(`Batch wrote ${result.count} of ${result.results.length} document(s).`);
      await runQuery(null);
    } catch (failure) {
      setError(getErrorMessage(failure, "Could not run batch write."));
    }
  }

  async function onBatchDelete(): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      const ids = batchDeleteIds
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry);
      const result = await batchDeleteTableRows(tableName, ids);
      setBatchResults(result.results);
      setNotice(`Batch deleted ${result.count} document(s).`);
      await runQuery(null);
    } catch (failure) {
      setError(getErrorMessage(failure, "Could not run batch delete."));
    }
  }

  async function onGrant(): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await grantTableAccess(tableName, grantAction, grantee.trim());
      setNotice(`Granted ${grantAction} to ${grantee.trim()}. Applies to their next call.`);
      setGrantee("");
    } catch (failure) {
      setError(getErrorMessage(failure, "Could not grant access."));
    }
  }

  async function onRevoke(): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await revokeTableAccess(tableName, grantAction, grantee.trim());
      setNotice(`Revoked ${grantAction} from ${grantee.trim()}. Applies to their next call.`);
      setGrantee("");
    } catch (failure) {
      setError(getErrorMessage(failure, "Could not revoke access."));
    }
  }

  async function onDeleteTable(): Promise<void> {
    setError(null);
    try {
      await deleteTable(tableName);
      setTable(null);
      setRows(null);
      setNotice(`Table "${tableName}" deleted.`);
    } catch (failure) {
      setError(getErrorMessage(failure, "Could not delete Table."));
    }
  }

  return (
    <section aria-label="Table detail">
      <p>
        <Link to="/tables">Tables</Link>
      </p>
      <h1>{tableName || "Table"}</h1>
      <p className="muted">No live updates — every section below re-queries only when you press its button.</p>
      <TokenForm
        token={token}
        onToken={setTokenState}
        onReload={() => {
          void reloadTable();
          void runQuery(null);
        }}
      />
      {loading ? <p>Loading table.</p> : null}
      {error ? (
        <p role="alert" className="error">
          Table failed: {error}
        </p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}
      {table ? (
        <p className="muted">
          Owner <code className="mono">{table.ownerUserId}</code> · created {table.createdAt}
        </p>
      ) : null}
      {!loading && !table && !error ? <p>Table not found, or no grant names you.</p> : null}

      {table ? (
        <>
          <h2>Rows</h2>
          <div className="row">
            <label htmlFor="rows-filter">Filter (path=json)</label>
            <input
              id="rows-filter"
              name="rows-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder='title="hello"'
            />
            <label htmlFor="rows-prefix">Prefix</label>
            <input
              id="rows-prefix"
              name="rows-prefix"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="doc id prefix"
            />
            <label htmlFor="rows-order">Order</label>
            <select id="rows-order" value={order} onChange={(e) => setOrder(e.target.value as "asc" | "desc")}>
              <option value="asc">asc</option>
              <option value="desc">desc</option>
            </select>
            <label htmlFor="rows-limit">Limit</label>
            <input
              id="rows-limit"
              name="rows-limit"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="20"
            />
            <label htmlFor="rows-skip">Skip count</label>
            <input
              id="rows-skip"
              name="rows-skip"
              type="checkbox"
              checked={skipCount}
              onChange={(e) => setSkipCount(e.target.checked)}
            />
          </div>
          <div className="row">
            <label htmlFor="rows-ids">Document IDs (comma-separated allowlist)</label>
            <input
              id="rows-ids"
              name="rows-ids"
              value={docIds}
              onChange={(e) => setDocIds(e.target.value)}
              placeholder="a, b"
            />
            <button type="button" onClick={() => void runQuery(null)} disabled={rowsLoading}>
              Refresh
            </button>
            <button type="button" onClick={() => void onRefreshCount()} disabled={rowsLoading}>
              Refresh count
            </button>
          </div>
          {rowsLoading ? <p>Loading rows…</p> : null}
          {rows ? <p className="muted">{totalLabel(rows.total)}.</p> : null}
          {rows && rows.rows.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th scope="col">Document ID</th>
                  <th scope="col">Data</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.rows.map((row: TableRowDoc) => (
                  <tr key={row.id} data-testid="table-row-doc">
                    <td>
                      <code className="mono" title={row.id}>
                        {row.id}
                      </code>
                    </td>
                    <td>
                      <code className="mono" title={JSON.stringify(row.data)}>
                        {preview(row.data)}
                      </code>
                    </td>
                    <td>
                      <span className="muted muted--small">{row.updatedAt}</span>
                    </td>
                    <td>
                      <button type="button" onClick={() => void onViewRow(row.id)}>
                        View
                      </button>{" "}
                      <button type="button" onClick={() => void onDeleteRow(row.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {rows && rows.rows.length === 0 ? <p>No rows match this query.</p> : null}
          {rows?.hasMore && cursor ? (
            <div className="row">
              <button type="button" onClick={() => void runQuery(cursor)} disabled={rowsLoading}>
                Next page
              </button>
            </div>
          ) : null}

          <h2>Single row</h2>
          <div className="row">
            <label htmlFor="row-id">Document ID</label>
            <input id="row-id" name="row-id" value={docId} onChange={(e) => setDocId(e.target.value)} placeholder="a" />
          </div>
          <div className="row">
            <label htmlFor="row-body">Document (JSON object)</label>
            <textarea
              id="row-body"
              name="row-body"
              rows={5}
              cols={48}
              value={docBody}
              onChange={(e) => setDocBody(e.target.value)}
            />
          </div>
          <div className="row">
            <button type="button" onClick={() => void onInsert()}>
              Insert
            </button>
            <button type="button" onClick={() => void onReplace()}>
              Replace
            </button>
          </div>

          <h2>Batch</h2>
          <p className="muted muted--small">
            One atomic request over 0–25 documents; oversized batches fail closed and nothing is auto-chunked.
          </p>
          <div className="row">
            <label htmlFor="batch-mode">Write mode</label>
            <select id="batch-mode" value={batchMode} onChange={(e) => setBatchMode(e.target.value as TableWriteMode)}>
              <option value="insert">insert</option>
              <option value="merge_upsert">merge_upsert</option>
              <option value="replace_upsert">replace_upsert</option>
            </select>
          </div>
          <div className="row">
            <label htmlFor="batch-body">Items (JSON array)</label>
            <textarea
              id="batch-body"
              name="batch-body"
              rows={5}
              cols={48}
              value={batchBody}
              onChange={(e) => setBatchBody(e.target.value)}
            />
            <button type="button" onClick={() => void onBatchWrite()}>
              Run batch write
            </button>
          </div>
          <div className="row">
            <label htmlFor="batch-delete">Delete IDs (comma-separated)</label>
            <input
              id="batch-delete"
              name="batch-delete"
              value={batchDeleteIds}
              onChange={(e) => setBatchDeleteIds(e.target.value)}
              placeholder="a, b"
            />
            <button type="button" onClick={() => void onBatchDelete()}>
              Run batch delete
            </button>
          </div>
          {batchResults ? (
            <ul>
              {batchResults.map((entry) => (
                <li key={entry.docId} data-testid="batch-result">
                  <code className="mono">{entry.docId}</code> · {entry.ok ? "ok" : (entry.error?.code ?? "failed")}
                </li>
              ))}
            </ul>
          ) : null}

          <h2>Grants</h2>
          <p className="muted muted--small">
            Owner-only. Grants name user IDs and apply to the grantee&apos;s next call; there is no push.
          </p>
          <div className="row">
            <label htmlFor="grant-action">Action</label>
            <select
              id="grant-action"
              value={grantAction}
              onChange={(e) => setGrantAction(e.target.value as TableGrantAction)}
            >
              <option value="read">read</option>
              <option value="insert">insert</option>
              <option value="update">update</option>
              <option value="delete">delete</option>
            </select>
            <label htmlFor="grant-user">User ID</label>
            <input
              id="grant-user"
              name="grant-user"
              value={grantee}
              onChange={(e) => setGrantee(e.target.value)}
              placeholder="user id"
            />
            <button type="button" onClick={() => void onGrant()}>
              Grant
            </button>
            <button type="button" onClick={() => void onRevoke()}>
              Revoke
            </button>
          </div>

          <h2>Danger zone</h2>
          <div className="row">
            <button type="button" onClick={() => void onDeleteTable()}>
              Delete table
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

export function TableDetailRoute(): React.JSX.Element {
  return <TableDetailView />;
}
