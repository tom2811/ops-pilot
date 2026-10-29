import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { formatTicketNumber } from "@opspilot/core";
import { api, errorMessage } from "../api.js";
import { useAuth } from "../auth.js";
import {
  EmptyState,
  ErrorAlert,
  PageHeader,
  PriorityBadge,
  StatusBadge,
  TrendChart,
} from "../components.js";
import { Icon } from "../ui.js";
import type { Config, Report, Ticket, TicketList } from "../types.js";

function formatDay(value: string): string {
  const date = new Date(value);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
}

function WorkList({
  tenantSlug,
  prefix,
  tickets,
  showPriority = true,
}: {
  tenantSlug: string;
  prefix: string;
  tickets: Ticket[];
  showPriority?: boolean;
}) {
  return (
    <ul className="work-list">
      {tickets.map((ticket) => (
        <li key={ticket.id}>
          <Link className="work-row" to={`/t/${tenantSlug}/tickets/${ticket.id}`}>
            <span className="work-num mono">{formatTicketNumber(prefix, ticket.number)}</span>
            <span className="work-subject">
              <strong>{ticket.subject}</strong>
              <small>
                {ticket.category_name}
                {ticket.team_name ? ` - ${ticket.team_name}` : ""}
              </small>
            </span>
            <StatusBadge label={ticket.status_label} stage={ticket.status_stage} />
            {showPriority && <PriorityBadge label={ticket.priority_label} />}
            <time className="work-time muted small">{formatDay(ticket.updated_at)}</time>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function RecentList({ tenantSlug, prefix, tickets }: { tenantSlug: string; prefix: string; tickets: Ticket[] }) {
  return (
    <ul className="recent-list">
      {tickets.map((ticket) => (
        <li key={ticket.id}>
          <Link className="recent-row" to={`/t/${tenantSlug}/tickets/${ticket.id}`}>
            <span className="recent-main">
              <strong>{ticket.subject}</strong>
              <small>
                {formatTicketNumber(prefix, ticket.number)} - {formatDay(ticket.updated_at)}
              </small>
            </span>
            <StatusBadge label={ticket.status_label} stage={ticket.status_stage} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function OverviewPage() {
  const { tenantSlug = "" } = useParams();
  const { memberships } = useAuth();
  const membership = memberships.find((item) => item.slug === tenantSlug);
  const role = membership?.role ?? "employee";
  const isEmployee = role === "employee";
  const canViewReports = Boolean(membership?.permissions.includes("reports.view"));

  const [report, setReport] = useState<Report | null>(null);
  const [myWork, setMyWork] = useState<TicketList | null>(null);
  const [unassigned, setUnassigned] = useState<TicketList | null>(null);
  const [recent, setRecent] = useState<TicketList | null>(null);
  const [closedCount, setClosedCount] = useState<number | null>(null);
  const [prefix, setPrefix] = useState("OPS");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const base = `/t/${tenantSlug}/tickets`;
    const mine = isEmployee
      ? `${base}?state=open&pageSize=6`
      : `${base}?assignee=me&state=open&pageSize=6`;
    const requests: Promise<unknown>[] = [
      api<TicketList>(mine).then((data) => {
        if (!cancelled) setMyWork(data);
      }),
      api<TicketList>(`${base}?sort=updated&pageSize=6`).then((data) => {
        if (!cancelled) setRecent(data);
      }),
      api<Config>(`/t/${tenantSlug}/config`).then((data) => {
        if (!cancelled) setPrefix(data.settings?.ticket_prefix ?? "OPS");
      }),
    ];

    if (isEmployee) {
      requests.push(
        api<TicketList>(`${base}?state=closed&pageSize=1`).then((data) => {
          if (!cancelled) setClosedCount(data.total);
        }),
      );
    } else {
      requests.push(
        api<TicketList>(`${base}?assignee=none&state=open&pageSize=5`).then((data) => {
          if (!cancelled) setUnassigned(data);
        }),
      );
    }

    if (canViewReports) {
      requests.push(
        api<Report>(`/t/${tenantSlug}/reports?days=14`).then((data) => {
          if (!cancelled) setReport(data);
        }),
      );
    }

    Promise.allSettled(requests)
      .then((results) => {
        if (cancelled) return;
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") setError(errorMessage(failed.reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tenantSlug, isEmployee, canViewReports, refresh]);

  const openCount = myWork?.total ?? 0;
  return (
    <div className="stack-lg">
      <PageHeader
        eyebrow={`${membership?.name ?? "Workspace"} overview`}
        title="Overview"
        actions={
          <>
            <button
              type="button"
              className="icon-btn"
              aria-label="Refresh overview"
              title="Refresh"
              onClick={() => setRefresh((value) => value + 1)}
            >
              <Icon name="refresh" />
            </button>
            <Link className="button" to={`/t/${tenantSlug}/tickets?new=1`}>
              <Icon name="plus" className="icon-sm" />
              New ticket
            </Link>
          </>
        }
      >
        <p className="muted">
          {isEmployee
            ? "Your open requests and the latest updates, in one place."
            : "The queue, your assigned work, and the last two weeks of flow."}
        </p>
      </PageHeader>

      <ErrorAlert message={error} />

      {loading && !myWork ? (
        <div className="stack-lg" role="status" aria-busy="true">
          <span className="sr-only">Loading overview</span>
          <section className={`stat-grid ${isEmployee ? "overview-stats-3" : "overview-stats-4"}`} aria-hidden="true">
            {Array.from({ length: isEmployee ? 3 : 4 }, (_, index) => (
              <div key={index} className="stat-card">
                <span className="skeleton" style={{ width: 64 }} />
                <span className="skeleton" style={{ width: 44, height: 26 }} />
                <span className="skeleton" style={{ width: 96, height: 8 }} />
              </div>
            ))}
          </section>
          <div className="overview-grid" aria-hidden="true">
            <div className="skeleton-panel">
              <div className="skeleton-stack">
                <span className="skeleton" style={{ width: 96, height: 12 }} />
                {[0, 1, 2, 3].map((index) => (
                  <span key={index} className="skeleton" style={{ width: `${82 - index * 9}%` }} />
                ))}
              </div>
            </div>
            <div className="skeleton-panel">
              <div className="skeleton-stack">
                <span className="skeleton" style={{ width: 72, height: 12 }} />
                <span className="skeleton skeleton-chart" style={{ marginTop: 0 }} />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <section className={`stat-grid ${isEmployee ? "overview-stats-3" : "overview-stats-4"}`}>
            {isEmployee ? (
              <>
                <div className="stat-card">
                  <span>Open</span>
                  <strong>{openCount}</strong>
                  <small>requests in progress</small>
                </div>
                <div className="stat-card">
                  <span>Resolved</span>
                  <strong>{closedCount ?? "-"}</strong>
                  <small>completed requests</small>
                </div>
                <div className="stat-card">
                  <span>Total</span>
                  <strong>{openCount + (closedCount ?? 0)}</strong>
                  <small>all requests</small>
                </div>
              </>
            ) : (
              <>
                <div className="stat-card">
                  <span>Open</span>
                  <strong>{report?.summary.open ?? openCount}</strong>
                  <small>visible to you</small>
                </div>
                <div className="stat-card">
                  <span>Unassigned</span>
                  <strong className={(report?.summary.unassigned ?? unassigned?.total ?? 0) > 0 ? "danger" : undefined}>
                    {report?.summary.unassigned ?? unassigned?.total ?? "-"}
                  </strong>
                  <small>waiting for an owner</small>
                </div>
                <div className="stat-card">
                  <span>SLA breached</span>
                  <strong className={(report?.summary.sla_breached ?? 0) > 0 ? "danger" : undefined}>
                    {report?.summary.sla_breached ?? "-"}
                  </strong>
                  <small>response or resolution</small>
                </div>
                <div className="stat-card">
                  <span>Resolved</span>
                  <strong>{report?.summary.resolved_week ?? "-"}</strong>
                  <small>last 7 days</small>
                </div>
              </>
            )}
          </section>

          <div className="overview-grid">
            <div className="overview-main">
              <section className="list-panel">
                <div className="panel-head">
                  <h2>{isEmployee ? "Your open requests" : "My work"}</h2>
                  <Link className="button ghost small" to={`/t/${tenantSlug}/tickets`}>
                    View all
                  </Link>
                </div>
                {myWork && myWork.items.length > 0 ? (
                  <WorkList tenantSlug={tenantSlug} prefix={prefix} tickets={myWork.items} />
                ) : (
                  <EmptyState title={isEmployee ? "No open requests" : "Nothing assigned"}>
                    {isEmployee
                      ? "Open a ticket when you need help from the team."
                      : "Pick something up from the unassigned queue below."}
                  </EmptyState>
                )}
              </section>

              {!isEmployee && (
                <section className="list-panel">
                  <div className="panel-head">
                    <h2>Unassigned</h2>
                    <Link className="button ghost small" to={`/t/${tenantSlug}/tickets`}>
                      Open queue
                    </Link>
                  </div>
                  {unassigned && unassigned.items.length > 0 ? (
                    <WorkList
                      tenantSlug={tenantSlug}
                      prefix={prefix}
                      tickets={unassigned.items}
                      showPriority={false}
                    />
                  ) : (
                    <EmptyState title="Queue is clear">Every visible ticket has an owner.</EmptyState>
                  )}
                </section>
              )}
            </div>

            <aside className="overview-side">
              {canViewReports && report ? (
                <section className="card">
                  <div className="section-heading">
                    <h2>Ticket flow</h2>
                    <span className="muted small">Last 14 days</span>
                  </div>
                  <TrendChart points={report.trend} />
                </section>
              ) : isEmployee ? (
                <section className="card">
                  <div className="section-heading">
                    <h2>Need assistance?</h2>
                    <span className="muted small">IT Service Desk</span>
                  </div>
                  <p className="muted small">
                    Submit a support ticket for hardware, application access, security, or office tech issues.
                  </p>
                  <div style={{ marginTop: 14 }}>
                    <Link className="button full-width" to={`/t/${tenantSlug}/tickets?new=1`}>
                      <Icon name="plus" className="icon-sm" />
                      New request
                    </Link>
                  </div>
                </section>
              ) : null}

              <section className="list-panel">
                <div className="panel-head">
                  <h2>Recently updated</h2>
                </div>
                {recent && recent.items.length > 0 ? (
                  <RecentList tenantSlug={tenantSlug} prefix={prefix} tickets={recent.items} />
                ) : (
                  <EmptyState title="No activity yet" />
                )}
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
