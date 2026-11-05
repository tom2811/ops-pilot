import { Component, type ErrorInfo, type ReactNode } from "react";
import { humanize } from "./api.js";
import { Icon } from "./ui.js";
import type { ReportTrendPoint } from "./types.js";

export function StatusBadge({ label, stage }: { label: string; stage: string }) {
  return <span className={`badge status-${stage}`}>{label}</span>;
}

export function PriorityBadge({ label, color }: { label: string; color?: string }) {
  return <span className={`badge priority-${color ?? "gray"}`}>{label}</span>;
}

export function RoleBadge({ role }: { role: string }) {
  return <span className="badge subtle">{humanize(role)}</span>;
}

export function SlaBadge({ label, state }: { label: string; state: string }) {
  return <span className={`badge sla-${state}`}>{label}</span>;
}

export function PageHeader({
  eyebrow,
  title,
  actions,
  children,
}: {
  eyebrow?: string;
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {children}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
    </div>
  );
}

export function ErrorAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="alert error">{message}</div>;
}

export function CardSkeleton({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="center-page">
      <div className="card narrow card-skeleton" role="status" aria-busy="true">
        <span className="sr-only">{label}</span>
        <span className="skeleton skeleton-mark" aria-hidden="true" />
        <span className="skeleton" style={{ width: 92, height: 9 }} aria-hidden="true" />
        <span className="skeleton" style={{ width: 190, height: 22 }} aria-hidden="true" />
        <span className="skeleton" style={{ width: "88%" }} aria-hidden="true" />
        <span className="skeleton" style={{ width: "64%" }} aria-hidden="true" />
        <span className="skeleton skeleton-button" aria-hidden="true" />
      </div>
    </div>
  );
}

export function Pager({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  return (
    <div className="pager" role="group" aria-label="Pagination">
      <button
        type="button"
        className="pager-btn"
        aria-label="Previous page"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        <Icon name="chevronLeft" />
      </button>
      <span className="pager-label" aria-live="polite">
        {page} of {totalPages}
      </span>
      <button
        type="button"
        className="pager-btn"
        aria-label="Next page"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        <Icon name="chevronRight" />
      </button>
    </div>
  );
}

export function SkeletonRows({ cols, rows = 6 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <tr key={row} className="skeleton-row" aria-hidden="true">
          {Array.from({ length: cols }, (_, col) => (
            <td key={col}>
              <span className="skeleton" style={{ width: `${[68, 42, 58, 36, 52, 46, 62, 40][col % 8]}%` }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function PageSkeleton({
  rows = 6,
  cols = 5,
  label = "Loading",
}: {
  rows?: number;
  cols?: number;
  label?: string;
}) {
  return (
    <div className="stack-lg" role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="skeleton-head" aria-hidden="true">
        <span className="skeleton" style={{ width: 78, height: 9 }} />
        <span className="skeleton" style={{ width: 196, height: 24 }} />
        <span className="skeleton" style={{ width: 300, height: 10 }} />
      </div>
      <div className="list-panel" aria-hidden="true">
        <div className="toolbar">
          <span className="skeleton" style={{ width: 210 }} />
          <span className="skeleton" style={{ width: 140 }} />
          <span className="skeleton" style={{ width: 140 }} />
        </div>
        <div className="table-wrap">
          <table>
            <tbody>
              <SkeletonRows cols={cols} rows={rows} />
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function DetailSkeleton({ label = "Loading" }: { label?: string }) {
  return (
    <div className="stack-lg" role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="skeleton-head" aria-hidden="true">
        <span className="skeleton" style={{ width: 92, height: 9 }} />
        <span className="skeleton" style={{ width: 320, height: 24 }} />
        <span className="skeleton" style={{ width: 230, height: 10 }} />
      </div>
      <div className="detail-grid" aria-hidden="true">
        <div className="skeleton-panel">
          <div className="skeleton-stack">
            <span className="skeleton" style={{ width: "42%" }} />
            <span className="skeleton" style={{ width: "88%" }} />
            <span className="skeleton" style={{ width: "76%" }} />
            <span className="skeleton" style={{ width: "64%" }} />
            <span className="skeleton" style={{ width: "82%" }} />
          </div>
        </div>
        <div className="skeleton-panel">
          <div className="skeleton-stack">
            <span className="skeleton" style={{ width: "55%" }} />
            <span className="skeleton" style={{ width: "80%" }} />
            <span className="skeleton" style={{ width: "70%" }} />
            <span className="skeleton" style={{ width: "46%" }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function formatChartDay(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

export function TrendChart({ points }: { points: ReportTrendPoint[] }) {
  if (points.length === 0) return <EmptyState title="No activity in this period" />;
  const max = Math.max(1, ...points.map((point) => Math.max(point.created, point.resolved)));
  const x = (index: number) => (points.length === 1 ? 50 : (index / (points.length - 1)) * 100);
  const y = (value: number) => 40 - (value / max) * 36;
  const line = (key: "created" | "resolved") =>
    points.map((point, index) => `${x(index)},${y(point[key])}`).join(" ");

  return (
    <div className="trend-chart">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Tickets created and resolved over time">
        {[4, 13, 22, 31].map((gridY) => (
          <line key={gridY} x1="0" y1={gridY} x2="100" y2={gridY} className="chart-grid" />
        ))}
        <line x1="0" y1="40" x2="100" y2="40" className="chart-axis" />
        <polyline points={line("created")} className="chart-line created" />
        <polyline points={line("resolved")} className="chart-line resolved" />
      </svg>
      <div className="chart-legend">
        <span><i className="chart-dot created" /> Created</span>
        <span><i className="chart-dot resolved" /> Resolved</span>
        <span className="muted">{formatChartDay(points[0]?.day ?? "")} to {formatChartDay(points[points.length - 1]?.day ?? "")}</span>
      </div>
    </div>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("Unhandled UI error caught by ErrorBoundary:", error, errorInfo);
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  override render() {
    if (this.state.hasError) {
      return (
        <div className="card" style={{ maxWidth: 540, margin: "40px auto", padding: 24, textAlign: "center" }}>
          <h2 style={{ fontSize: "1.15rem", marginBottom: 8 }}>
            {this.props.fallbackTitle ?? "Something went wrong"}
          </h2>
          <p className="muted" style={{ fontSize: "0.9rem", marginBottom: 20 }}>
            An unexpected error occurred in this view. Your session and workspace data are safe.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", marginBottom: 16 }}>
            <button type="button" className="btn primary" onClick={this.reset}>
              Try again
            </button>
            <button
              type="button"
              className="btn secondary"
              onClick={() => window.location.reload()}
            >
              Reload application
            </button>
          </div>
          {this.state.error && (
            <details style={{ textAlign: "left", fontSize: "0.8rem", marginTop: 12 }}>
              <summary style={{ cursor: "pointer", color: "var(--muted)" }}>Diagnostic information</summary>
              <pre
                style={{
                  marginTop: 8,
                  padding: 12,
                  background: "var(--subtle-bg, rgba(0, 0, 0, 0.04))",
                  borderRadius: 6,
                  overflowX: "auto",
                  fontFamily: "monospace",
                }}
              >
                {this.state.error.message}
                {"\n"}
                {this.state.error.stack}
              </pre>
            </details>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

