import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, errorMessage, formatDate, humanize } from "../api.js";
import { useAuth } from "../auth.js";
import { EmptyState, ErrorAlert, PageHeader, Spinner } from "../components.js";
import type { AuditEntry, AuditLog } from "../types.js";

function formatValue(value: unknown): string {
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

function summarize(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value !== "object") return String(value);
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, item]) => item !== null && item !== undefined,
  );
  if (entries.length === 0) return "—";
  return entries.map(([key, item]) => `${key}: ${formatValue(item)}`).join(", ");
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const hasDetail = entry.before !== null || entry.after !== null;

  return (
    <>
      <tr>
        <td className="mono nowrap">{formatDate(entry.created_at)}</td>
        <td>
          <strong>{humanize(entry.action.replace(".", " "))}</strong>
          <div className="muted small mono">{entry.action}</div>
        </td>
        <td>{humanize(entry.entity_type)}</td>
        <td>{entry.actor_name ?? humanize(entry.actor_role)}</td>
        <td className="nowrap">
          {hasDetail ? (
            <button className="button ghost small" onClick={() => setOpen((current) => !current)}>
              {open ? "Hide" : "Details"}
            </button>
          ) : (
            <span className="muted small">—</span>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5}>
            <div className="audit-detail">
              <div>
                <span className="muted small">Before</span>
                <p>{summarize(entry.before)}</p>
              </div>
              <div>
                <span className="muted small">After</span>
                <p>{summarize(entry.after)}</p>
              </div>
              <div>
                <span className="muted small">Correlation ID</span>
                <p className="mono small">{entry.correlation_id}</p>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function AuditLogPage() {
  const { tenantSlug = "" } = useParams();
  const { memberships } = useAuth();
  const membership = memberships.find((item) => item.slug === tenantSlug);
  const canView = membership?.permissions.includes("audit.view") ?? false;
  const [data, setData] = useState<AuditLog | null>(null);
  const [entityType, setEntityType] = useState("");
  const [action, setAction] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set("page", String(page));
    if (entityType) params.set("entityType", entityType);
    if (action) params.set("action", action);
    api<AuditLog>(`/t/${tenantSlug}/audit-log?${params.toString()}`)
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantSlug, page, entityType, action, canView]);

  if (!canView) {
    return (
      <div className="stack-lg">
        <PageHeader title="Audit log" />
        <EmptyState title="Audit log is not available">
          Ask an administrator for the audit log permission.
        </EmptyState>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 50)));

  return (
    <div className="stack-lg">
      <PageHeader eyebrow="Governance" title="Audit log">
        <p className="muted">Append-only record of configuration, people, and ticket changes.</p>
      </PageHeader>

      <ErrorAlert message={error} />

      <section className="card">
        <div className="filter-bar">
          <select
            value={entityType}
            onChange={(event) => {
              setEntityType(event.target.value);
              setPage(1);
            }}
            aria-label="Entity type"
          >
            <option value="">All entity types</option>
            {(data?.entity_types ?? []).map((item) => (
              <option key={item} value={item}>
                {humanize(item)}
              </option>
            ))}
          </select>
          <select
            value={action}
            onChange={(event) => {
              setAction(event.target.value);
              setPage(1);
            }}
            aria-label="Action prefix"
          >
            <option value="">All actions</option>
            <option value="ticket">Tickets</option>
            <option value="config">Configuration</option>
            <option value="user">People</option>
            <option value="role">Roles</option>
            <option value="platform">Platform</option>
          </select>
        </div>

        {loading && !data ? (
          <Spinner label="Loading audit entries…" />
        ) : data && data.items.length === 0 ? (
          <EmptyState title="No audit entries">Nothing matches the current filters.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Actor</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data?.items.map((entry) => (
                  <AuditRow key={entry.id} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && (
          <div className="pagination">
            <span className="muted small">
              {data.total} entr{data.total === 1 ? "y" : "ies"}
            </span>
            <div className="pagination-actions">
              <button
                className="button ghost small"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </button>
              <span className="muted small">
                Page {page} of {totalPages}
              </span>
              <button
                className="button ghost small"
                disabled={page >= totalPages}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

