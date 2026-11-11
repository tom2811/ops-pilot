import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, errorMessage, formatDate } from "../api.js";
import { useAuth } from "../auth.js";
import { EmptyState, ErrorAlert, PageHeader, Pager, SkeletonRows } from "../components.js";
import { Icon, Select } from "../ui.js";

type OutboundEmailRow = {
  id: string;
  channel: string;
  subject: string;
  delivery_status: string;
  attempts: number;
  provider_message_id: string | null;
  sent_at: string | null;
  created_at: string;
  last_error: string | null;
  recipient_email: string | null;
};

type InboundEmailRow = {
  id: string;
  message_id: string;
  from_address: string;
  to_address: string;
  subject: string;
  action: string;
  ticket_id: string | null;
  ticket_number?: number | null;
  created_at: string;
};

type LogEvent = {
  key: string;
  kind: "outbound" | "inbound";
  actor: string;
  subject: string;
  statusTone: string;
  statusLabel: string;
  errorDetail: string | null;
  fullError?: string | null;
  providerId: string | null;
  timestamp: string;
};

function parseErrorDetail(error: string): { label: string; full: string } {
  if (error.includes("You can only send testing emails")) {
    return {
      label: "550: Sandbox recipient restricted",
      full: "Resend sandbox mode allows delivery only to the registered account owner. To send to any recipient, verify a custom domain in Resend.",
    };
  }
  if (error.includes("ENOTFOUND")) {
    return { label: "DNS: Host unreachable", full: error };
  }
  if (error.includes("ETIMEDOUT")) {
    return { label: "Timeout: Connection timed out", full: error };
  }
  if (error.includes("ECONNREFUSED")) {
    return { label: "Connection: Port refused", full: error };
  }
  const match = error.match(/SMTP (\d{3})/i);
  if (match) {
    return { label: `SMTP ${match[1]}: Delivery rejected`, full: error };
  }
  return { label: error.length > 36 ? `${error.slice(0, 33)}...` : error, full: error };
}

export function EmailLogsPage() {
  const { tenantSlug = "" } = useParams();
  const { memberships } = useAuth();
  const membership = memberships.find((item) => item.slug === tenantSlug);
  const canView =
    (membership?.permissions.includes("audit.view") ||
      membership?.permissions.includes("config.manage")) ??
    false;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{ outbound: OutboundEmailRow[]; inbound: InboundEmailRow[] } | null>(null);
  const [filter, setFilter] = useState<"all" | "outbound" | "inbound">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const pageSize = 20;

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    setLoading(true);

    api<{ outbound: OutboundEmailRow[]; inbound: InboundEmailRow[] }>(`/t/${tenantSlug}/email-logs`)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setData(null);
          setError(errorMessage(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tenantSlug, canView, refresh]);

  if (!canView) {
    return (
      <div className="stack-lg">
        <PageHeader title="Email delivery logs" />
        <EmptyState title="Permission required">
          You do not have permission to view email delivery diagnostics.
        </EmptyState>
      </div>
    );
  }

  const outboundEvents: LogEvent[] = (data?.outbound ?? []).map((row) => {
    const isSent = row.delivery_status === "sent";
    const isFailed = row.delivery_status === "failed";

    const parsed = isFailed && row.last_error ? parseErrorDetail(row.last_error) : null;

    return {
      key: `outbound-${row.id}`,
      kind: "outbound",
      actor: row.recipient_email ?? "System User",
      subject: row.subject,
      statusTone: isSent ? "status-open" : isFailed ? "status-urgent" : "status-in_progress",
      statusLabel: isSent ? "Delivered · 250 OK" : isFailed ? "Delivery Failed" : "Queued",
      errorDetail: parsed?.label ?? null,
      fullError: parsed?.full ?? null,
      providerId: row.provider_message_id,
      timestamp: row.sent_at || row.created_at,
    };
  });

  const inboundEvents: LogEvent[] = (data?.inbound ?? []).map((row) => ({
    key: `inbound-${row.id}`,
    kind: "inbound",
    actor: row.from_address,
    subject: row.subject,
    statusTone: row.action === "ticket_created" ? "status-closed" : "status-in_progress",
    statusLabel:
      row.action === "ticket_created"
        ? (row.ticket_number ? `Ticket #${row.ticket_number} Created` : "Ticket Created")
        : "Comment Appended",
    errorDetail: null,
    providerId: row.message_id ? row.message_id.slice(0, 36) : null,
    timestamp: row.created_at,
  }));

  const allEvents = [...outboundEvents, ...inboundEvents]
    .filter((event) => (filter === "all" ? true : event.kind === filter))
    .filter((event) => {
      if (!search.trim()) return true;
      const term = search.toLowerCase();
      return (
        event.actor.toLowerCase().includes(term) ||
        event.subject.toLowerCase().includes(term) ||
        (event.providerId && event.providerId.toLowerCase().includes(term))
      );
    })
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const totalPages = Math.max(1, Math.ceil(allEvents.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedEvents = allEvents.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <div className="stack-lg">
      <PageHeader eyebrow="Telemetry & Diagnostics" title="Email delivery logs">
        <p className="muted">
          Real-time event stream tracking outbound transactional SMTP dispatches and incoming email-to-ticket webhooks.
        </p>
      </PageHeader>

      <ErrorAlert message={error} />

      <section className="stat-grid overview-stats-3">
        <div className="stat-card">
          <span className="muted small">All Events</span>
          <strong>{outboundEvents.length + inboundEvents.length}</strong>
        </div>
        <div className="stat-card">
          <span className="muted small">Outbound SMTP Dispatches</span>
          <strong>{outboundEvents.length}</strong>
        </div>
        <div className="stat-card">
          <span className="muted small">Inbound Intake Webhooks</span>
          <strong>{inboundEvents.length}</strong>
        </div>
      </section>

      <section className="list-panel">
        <div className="toolbar">
          <input
            type="search"
            placeholder="Search recipient, sender, subject…"
            aria-label="Search email logs"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          <Select
            ariaLabel="Filter channel"
            value={filter}
            onChange={(next) => {
              setFilter(next as "all" | "outbound" | "inbound");
              setPage(1);
            }}
            options={[
              { value: "all", label: `All channels (${outboundEvents.length + inboundEvents.length})` },
              { value: "outbound", label: `Outbound SMTP (${outboundEvents.length})` },
              { value: "inbound", label: `Inbound Intake (${inboundEvents.length})` },
            ]}
          />
          {(search || filter !== "all") && (
            <button
              type="button"
              className="button ghost"
              onClick={() => {
                setSearch("");
                setFilter("all");
                setPage(1);
              }}
            >
              Clear
            </button>
          )}

          <span className="toolbar-spacer" />

          <button
            type="button"
            className="icon-btn"
            aria-label="Refresh logs"
            title="Refresh logs"
            onClick={() => setRefresh((v) => v + 1)}
          >
            <Icon name="refresh" />
          </button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: "160px" }}>Channel</th>
                <th style={{ width: "260px" }}>Sender / Recipient</th>
                <th>Subject & Trigger</th>
                <th style={{ width: "200px" }}>Delivery Status</th>
                <th style={{ width: "200px" }}>Provider ID / Time</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <SkeletonRows cols={5} rows={6} />
              ) : pagedEvents.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted" style={{ textAlign: "center", padding: "28px" }}>
                    {search ? "No events matching your search criteria." : "No email activity recorded yet."}
                  </td>
                </tr>
              ) : (
                pagedEvents.map((item) => (
                  <tr key={item.key}>
                    <td>
                      <span className={`badge ${item.kind === "outbound" ? "subtle" : "status-in_progress"}`}>
                        {item.kind === "outbound" ? "Outbound SMTP" : "Inbound Intake"}
                      </span>
                    </td>
                    <td>
                      <strong>{item.actor}</strong>
                    </td>
                    <td>
                      <span>{item.subject}</span>
                    </td>
                    <td>
                      <span className={`badge ${item.statusTone}`}>
                        {item.statusLabel}
                      </span>
                      {item.errorDetail && (
                        <div
                          className="muted small mono"
                          style={{ marginTop: "3px", cursor: item.fullError ? "help" : "default" }}
                          title={item.fullError || item.errorDetail}
                        >
                          {item.errorDetail}
                        </div>
                      )}
                    </td>
                    <td className="muted small">
                      {item.providerId && (
                        <div className="mono" style={{ marginBottom: "2px" }}>
                          {item.providerId}
                        </div>
                      )}
                      <div>{formatDate(item.timestamp)}</div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {data && (
          <div className="list-foot">
            <span className="muted small">
              {allEvents.length === 0 ? (
                "0 entries"
              ) : (
                <>
                  Showing {(currentPage - 1) * pageSize + 1}–
                  {Math.min(currentPage * pageSize, allEvents.length)} of{" "}
                  {allEvents.length} {allEvents.length === 1 ? "entry" : "entries"}
                </>
              )}
            </span>
            <Pager
              page={currentPage}
              totalPages={totalPages}
              onChange={setPage}
            />
          </div>
        )}
      </section>
    </div>
  );
}
