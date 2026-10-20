import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, errorMessage, formatDate, humanize } from "../api.js";
import { useAuth } from "../auth.js";
import { EmptyState, ErrorAlert, PageHeader, Spinner } from "../components.js";
import type { Report, ReportTrendPoint } from "../types.js";

const PERIODS = [7, 30, 90, 365];

function formatHours(value: number): string {
  if (!value) return "—";
  if (value < 1) return `${Math.round(value * 60)}m`;
  if (value < 48) return `${value.toFixed(1)}h`;
  return `${(value / 24).toFixed(1)}d`;
}

function formatMinutes(value: number): string {
  if (!value) return "—";
  if (value < 60) return `${Math.round(value)}m`;
  return `${(value / 60).toFixed(1)}h`;
}

function TrendChart({ points }: { points: ReportTrendPoint[] }) {
  if (points.length === 0) return <EmptyState title="No activity in this period" />;
  const max = Math.max(1, ...points.map((point) => Math.max(point.created, point.resolved)));
  const x = (index: number) => (points.length === 1 ? 50 : (index / (points.length - 1)) * 100);
  const y = (value: number) => 40 - (value / max) * 36;
  const line = (key: "created" | "resolved") =>
    points.map((point, index) => `${x(index)},${y(point[key])}`).join(" ");

  return (
    <div className="trend-chart">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Tickets created and resolved over time">
        <line x1="0" y1="40" x2="100" y2="40" className="chart-axis" />
        <polyline points={line("created")} className="chart-line created" />
        <polyline points={line("resolved")} className="chart-line resolved" />
      </svg>
      <div className="chart-legend">
        <span><i className="chart-dot created" /> Created</span>
        <span><i className="chart-dot resolved" /> Resolved</span>
        <span className="muted">{points[0]?.day} → {points[points.length - 1]?.day}</span>
      </div>
    </div>
  );
}

const BAR_COLORS: Record<string, string> = {
  red: "#d92d20",
  orange: "#f79009",
  blue: "#1570ef",
  green: "#12b76a",
  gray: "#98a2b3",
};

function BarList({ items }: { items: { label: string; count: number; color?: string }[] }) {
  if (items.length === 0) return <EmptyState title="Nothing to show" />;
  const max = Math.max(1, ...items.map((item) => item.count));
  return (
    <div className="bar-list">
      {items.map((item) => (
        <div className="bar-row" key={item.label}>
          <div className="bar-meta">
            <span>{humanize(item.label)}</span>
            <strong>{item.count}</strong>
          </div>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{
                width: `${(item.count / max) * 100}%`,
                background: item.color ? (BAR_COLORS[item.color] ?? undefined) : undefined,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function Stars({ value }: { value: number }) {
  const rounded = Math.round(value);
  return (
    <span className="stars" aria-label={`${value.toFixed(1)} out of 5`}>
      {"★".repeat(rounded)}
      <span className="stars-empty">{"★".repeat(Math.max(0, 5 - rounded))}</span>
    </span>
  );
}

export function ReportsPage() {
  const { tenantSlug = "" } = useParams();
  const { memberships } = useAuth();
  const membership = memberships.find((item) => item.slug === tenantSlug);
  const [period, setPeriod] = useState(30);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!membership?.permissions.includes("reports.view")) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<Report>(`/t/${tenantSlug}/reports?days=${period}`)
      .then((data) => {
        if (!cancelled) setReport(data);
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
  }, [tenantSlug, period, membership]);

  if (!membership?.permissions.includes("reports.view")) {
    return (
      <div className="stack-lg">
        <PageHeader title="Reports" />
        <EmptyState title="Reports are not available">Ask an administrator for the reports permission.</EmptyState>
      </div>
    );
  }

  return (
    <div className="stack-lg">
      <PageHeader
        eyebrow="Insights"
        title="Reports"
        actions={
          <select value={period} onChange={(event) => setPeriod(Number(event.target.value))} aria-label="Reporting period">
            {PERIODS.map((days) => (
              <option key={days} value={days}>
                Last {days} days
              </option>
            ))}
          </select>
        }
      >
        <p className="muted">Ticket flow, SLA health, and customer satisfaction for this workspace.</p>
      </PageHeader>

      <ErrorAlert message={error} />
      {loading && !report ? (
        <Spinner />
      ) : report ? (
        <>
          <section className="stat-grid">
            <div className="stat-card">
              <span>Open tickets</span>
              <strong>{report.summary.open}</strong>
              <small>{report.summary.unassigned} unassigned</small>
            </div>
            <div className="stat-card">
              <span>Created</span>
              <strong>{report.summary.created_period}</strong>
              <small>last {report.periodDays} days</small>
            </div>
            <div className="stat-card">
              <span>Resolved</span>
              <strong>{report.summary.resolved_week}</strong>
              <small>last 7 days</small>
            </div>
            <div className="stat-card">
              <span>SLA breached</span>
              <strong className={report.summary.sla_breached > 0 ? "danger" : undefined}>{report.summary.sla_breached}</strong>
              <small>all visible tickets</small>
            </div>
            <div className="stat-card">
              <span>Avg first response</span>
              <strong>{formatMinutes(report.summary.avg_response_minutes)}</strong>
              <small>last {report.periodDays} days</small>
            </div>
            <div className="stat-card">
              <span>Avg resolution</span>
              <strong>{formatHours(report.summary.avg_resolution_hours)}</strong>
              <small>last {report.periodDays} days</small>
            </div>
          </section>

          <div className="report-grid">
            <section className="card">
              <h2>Ticket flow</h2>
              <TrendChart points={report.trend} />
            </section>
            <section className="card csat-card">
              <h2>Customer satisfaction</h2>
              {report.csat.responses === 0 ? (
                <EmptyState title="No feedback yet">Ratings appear once resolved tickets are rated.</EmptyState>
              ) : (
                <>
                  <div className="csat-score">
                    <strong>{report.csat.average.toFixed(1)}</strong>
                    <Stars value={report.csat.average} />
                  </div>
                  <p className="muted">
                    {report.csat.responses} response{report.csat.responses === 1 ? "" : "s"} · {report.csat.comments} written
                  </p>
                </>
              )}
            </section>
          </div>

          <div className="report-grid">
            <section className="card">
              <h2>By status</h2>
              <BarList items={report.by_status.map((item) => ({ label: item.label, count: item.count }))} />
            </section>
            <section className="card">
              <h2>By priority</h2>
              <BarList items={report.by_priority.map((item) => ({ label: item.label, count: item.count, color: item.color }))} />
            </section>
            <section className="card">
              <h2>By team</h2>
              <BarList items={report.by_team} />
            </section>
          </div>

          <section className="card">
            <h2>Recent feedback</h2>
            {report.recent_feedback.length === 0 ? (
              <EmptyState title="No feedback yet" />
            ) : (
              <ul className="feedback-list">
                {report.recent_feedback.map((item) => (
                  <li key={`${item.number}-${item.submitted_at}`}>
                    <div className="feedback-list-head">
                      <strong>#{item.number} {item.subject}</strong>
                      <Stars value={item.rating} />
                    </div>
                    {item.comment && <p>{item.comment}</p>}
                    <p className="muted small">{item.requester_name} · {formatDate(item.submitted_at)}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
