import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, errorMessage, formatDate, humanize, triggerDownload } from "../api.js";
import { useAuth } from "../auth.js";
import { EmptyState, ErrorAlert, PageHeader, TrendChart } from "../components.js";
import { Icon, Select, useToast } from "../ui.js";
import type { Report } from "../types.js";

const PERIODS = [7, 30, 90, 365];

function formatHours(value: number): string {
  if (!value) return "-";
  if (value < 1) return `${Math.round(value * 60)}m`;
  if (value < 48) return `${value.toFixed(1)}h`;
  return `${(value / 24).toFixed(1)}d`;
}

function formatMinutes(value: number): string {
  if (!value) return "-";
  if (value < 60) return `${Math.round(value)}m`;
  return `${(value / 60).toFixed(1)}h`;
}

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
              className={`bar-fill ${item.color ?? ""}`.trim()}
              style={{ width: `${(item.count / max) * 100}%` }}
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
  const toast = useToast();
  const membership = memberships.find((item) => item.slug === tenantSlug);
  const isTenantAdmin = membership?.role === "tenant_admin";
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

  function exportReportCsv() {
    if (!report) return;
    const lines: string[] = [];
    lines.push(`"OpsPilot Report - Last ${report.periodDays} days"`);
    lines.push(`"Generated At","${new Date().toISOString()}"`);
    lines.push("");

    lines.push('"Summary Metric","Value"');
    lines.push(`"Open Tickets",${report.summary.open}`);
    lines.push(`"Unassigned Tickets",${report.summary.unassigned}`);
    lines.push(`"Tickets Created in Period",${report.summary.created_period}`);
    lines.push(`"Tickets Resolved (Last 7 Days)",${report.summary.resolved_week}`);
    lines.push(`"SLA Breached (Period)",${report.summary.sla_breached}`);
    lines.push(`"SLA Met (Period)",${report.summary.sla_met ?? 0}`);
    lines.push(`"SLA Still Running (Period)",${report.summary.sla_still_running ?? 0}`);
    lines.push(`"SLA Compliance Rate (Stopped Clocks)",${(report.summary.sla_compliance_percent ?? 100).toFixed(1)}%`);
    lines.push(`"Average First Response Minutes",${report.summary.avg_response_minutes.toFixed(1)}`);
    lines.push(`"Average Resolution Hours",${report.summary.avg_resolution_hours.toFixed(1)}`);
    lines.push(`"CSAT Average Score",${report.csat.average.toFixed(2)}`);
    lines.push(`"CSAT Responses",${report.csat.responses}`);
    lines.push("");

    lines.push('"Daily Trend - Date","Created","Resolved"');
    for (const p of report.trend) {
      lines.push(`"${p.day}",${p.created},${p.resolved}`);
    }
    lines.push("");

    lines.push('"Tickets by Status","Stage","Count"');
    for (const s of report.by_status) {
      lines.push(`"${s.label.replaceAll('"', '""')}","${s.stage}",${s.count}`);
    }
    lines.push("");

    lines.push('"Tickets by Priority","Count"');
    for (const p of report.by_priority) {
      lines.push(`"${p.label.replaceAll('"', '""')}",${p.count}`);
    }
    lines.push("");

    if (report.by_category && report.by_category.length > 0) {
      lines.push('"Tickets by Category","Count"');
      for (const c of report.by_category) {
        lines.push(`"${c.label.replaceAll('"', '""')}",${c.count}`);
      }
      lines.push("");
    }

    lines.push('"Tickets by Team","Count"');
    for (const t of report.by_team) {
      lines.push(`"${t.label.replaceAll('"', '""')}",${t.count}`);
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    triggerDownload(lines.join("\r\n"), `report-${tenantSlug}-${report.periodDays}d-${dateStr}.csv`);
    toast.success("Export prepared", "Preparing report CSV for download.");
  }

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
          <div className="inline-fields">
            <Select
              ariaLabel="Reporting period"
              value={String(period)}
              onChange={(next) => setPeriod(Number(next))}
              options={PERIODS.map((days) => ({ value: String(days), label: `Last ${days} days` }))}
            />
            {isTenantAdmin && (
              <button
                type="button"
                className="button secondary"
                onClick={exportReportCsv}
                disabled={!report || loading}
                aria-label="Export report metrics as CSV"
                title="Export report metrics to CSV"
              >
                <Icon name="download" className="icon-sm" />
                Export CSV
              </button>
            )}
          </div>
        }
      >
        <p className="muted">Ticket flow, SLA health, and customer satisfaction for this workspace.</p>
      </PageHeader>

      <ErrorAlert message={error} />
      {loading && !report ? (
        <div className="stack-lg" role="status" aria-busy="true">
          <span className="sr-only">Loading report</span>
          <section className="stat-grid report-stats" aria-hidden="true">
            {Array.from({ length: 9 }, (_, index) => (
              <div key={index} className="stat-card">
                <span className="skeleton" style={{ width: 76 }} />
                <span className="skeleton" style={{ width: 56, height: 26 }} />
                <span className="skeleton" style={{ width: 104, height: 8 }} />
              </div>
            ))}
          </section>
          <div className="report-hero-grid" aria-hidden="true">
            <div className="skeleton-panel">
              <span className="skeleton" style={{ width: 108, height: 12 }} />
              <span className="skeleton skeleton-chart" />
            </div>
            <div className="skeleton-panel">
              <span className="skeleton" style={{ width: 140, height: 12 }} />
              <span className="skeleton" style={{ width: 90, height: 34, marginTop: 14 }} />
              <span className="skeleton" style={{ width: 120, height: 12, marginTop: 10 }} />
            </div>
          </div>
          <div className="report-breakdown-grid" aria-hidden="true">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="skeleton-panel">
                <span className="skeleton" style={{ width: 80, height: 12, marginBottom: 12 }} />
                {[80, 55, 35].map((w, i) => (
                  <div key={i} style={{ marginTop: 8 }}>
                    <span className="skeleton" style={{ width: `${w}%`, height: 10 }} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : report ? (
        <>
          <section className="stat-grid report-stats">
            <div className="stat-card">
              <span>Open tickets</span>
              <strong>{report.summary?.open ?? 0}</strong>
              <small>{report.summary?.unassigned ?? 0} unassigned</small>
            </div>
            <div className="stat-card">
              <span>Created</span>
              <strong>{report.summary?.created_period ?? 0}</strong>
              <small>last {report.periodDays} days</small>
            </div>
            <div className="stat-card">
              <span>Resolved</span>
              <strong>{report.summary?.resolved_week ?? 0}</strong>
              <small>last 7 days</small>
            </div>
            <div className="stat-card">
              <span>SLA compliance</span>
              <strong className={(report.summary?.sla_compliance_percent ?? 100) < 90 ? "warning" : "success"}>
                {report.summary?.sla_compliance_percent !== undefined ? `${report.summary.sla_compliance_percent}%` : "-"}
              </strong>
              <small>stopped clocks only</small>
            </div>
            <div className="stat-card">
              <span>SLA breached</span>
              <strong className={(report.summary?.sla_breached ?? 0) > 0 ? "danger" : undefined}>
                {report.summary?.sla_breached ?? 0}
              </strong>
              <small>in period</small>
            </div>
            <div className="stat-card">
              <span>SLA met</span>
              <strong className={(report.summary?.sla_met ?? 0) > 0 ? "success" : undefined}>
                {report.summary?.sla_met ?? 0}
              </strong>
              <small>in period</small>
            </div>
            <div className="stat-card">
              <span>SLA still running</span>
              <strong>
                {report.summary?.sla_still_running ?? 0}
              </strong>
              <small>in period</small>
            </div>
            <div className="stat-card">
              <span>Avg first response</span>
              <strong>{formatMinutes(report.summary?.avg_response_minutes ?? 0)}</strong>
              <small>last {report.periodDays} days</small>
            </div>
            <div className="stat-card">
              <span>Avg resolution</span>
              <strong>{formatHours(report.summary?.avg_resolution_hours ?? 0)}</strong>
              <small>last {report.periodDays} days</small>
            </div>
          </section>

          <div className="report-hero-grid">
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
                    {report.csat.responses} response{report.csat.responses === 1 ? "" : "s"}, {report.csat.comments} written
                  </p>
                </>
              )}
            </section>
          </div>

          <div className="report-breakdown-grid">
            <section className="card">
              <h2>By status</h2>
              <BarList items={report.by_status.map((item) => ({ label: item.label, count: item.count }))} />
            </section>
            <section className="card">
              <h2>By priority</h2>
              <BarList items={report.by_priority.map((item) => ({ label: item.label, count: item.count, color: item.color }))} />
            </section>
            <section className="card">
              <h2>By category</h2>
              <BarList items={report.by_category ?? []} />
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
                    <p className="muted small">{item.requester_name} - {formatDate(item.submitted_at)}</p>
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
