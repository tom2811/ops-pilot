import type { ReactNode } from "react";
import { humanize } from "./api.js";

export function StatusBadge({ label, stage }: { label: string; stage: string }) {
  return <span className={`badge status-${stage}`}>{label}</span>;
}

export function PriorityBadge({ label, color }: { label: string; color?: string }) {
  return <span className={`badge priority-${color ?? "gray"}`}>{label}</span>;
}

export function RoleBadge({ role }: { role: string }) {
  return <span className="badge subtle">{humanize(role)}</span>;
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

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spinner" />
      {label}
    </div>
  );
}
