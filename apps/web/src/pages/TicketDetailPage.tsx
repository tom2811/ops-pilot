import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { formatTicketNumber } from "@opspilot/core";
import { api, errorMessage, formatDate, humanize, post } from "../api.js";
import { useAuth } from "../auth.js";
import { EmptyState, ErrorAlert, PriorityBadge, Spinner, StatusBadge } from "../components.js";
import type { Config, TicketDetail } from "../types.js";

type TimelineEvent = {
  time: string;
  title: string;
  detail?: string;
  actor?: string;
  kind: "status" | "assignment";
};

export function TicketDetailPage() {
  const { tenantSlug = "", ticketId = "" } = useParams();
  const { memberships } = useAuth();
  const role = memberships.find((item) => item.slug === tenantSlug)?.role ?? "employee";
  const canAgent = role === "agent" || role === "tenant_admin";

  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);

  const [transitionId, setTransitionId] = useState("");
  const [reason, setReason] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);

  const [commentBody, setCommentBody] = useState("");
  const [internal, setInternal] = useState(false);

  const [teamId, setTeamId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api<TicketDetail>(`/t/${tenantSlug}/tickets/${ticketId}`), api<Config>(`/t/${tenantSlug}/config`)])
      .then(([nextDetail, nextConfig]) => {
        if (cancelled) return;
        setDetail(nextDetail);
        setConfig(nextConfig);
        setError(null);
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
  }, [tenantSlug, ticketId, refresh]);

  useEffect(() => {
    if (!detail || !config) return;
    setTeamId(detail.team_id ?? config.teams[0]?.id ?? "");
    setAssigneeId(detail.assignee_id ?? "");
  }, [detail, config]);

  if (loading && !detail) return <Spinner label="Loading ticket…" />;
  if (!detail) {
    return (
      <div className="stack">
        <Link to={`/t/${tenantSlug}/tickets`}>← Back to tickets</Link>
        <ErrorAlert message={error ?? "Ticket not found"} />
      </div>
    );
  }

  const prefix = config?.settings?.ticket_prefix ?? "OPS";
  const priorityMeta = config?.priorities.find((item) => item.key === detail.priority_key);
  const transition = detail.allowed_transitions.find((item) => item.toStatusId === transitionId);
  const reopening = transition?.stage === "open" && ["resolved", "closed"].includes(detail.status_stage);
  const needsSummary = Boolean(transition && (transition.requiresSummary || transition.stage === "resolved"));
  const needsReason = Boolean(transition && (transition.requiresReason || transition.stage === "pending" || reopening));
  const teamAgents = config?.agents.filter((agent) => agent.team_ids.includes(teamId)) ?? [];

  const timeline: TimelineEvent[] = [
    ...detail.history.map((event) => ({
      time: event.created_at,
      title: event.from_label ? `${event.from_label} → ${event.to_label}` : `Opened as ${event.to_label}`,
      detail: event.reason ?? undefined,
      actor: event.actor_name ?? humanize(event.actor_role),
      kind: "status" as const,
    })),
    ...detail.assignments.map((event) => ({
      time: event.created_at,
      title: event.to_assignee_name
        ? `Assigned to ${event.to_assignee_name}`
        : `Assigned to ${event.to_team_name ?? "a team"}`,
      detail: event.to_team_name ? `Team: ${event.to_team_name}` : undefined,
      actor: event.actor_name ?? humanize(event.actor_role),
      kind: "assignment" as const,
    })),
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  async function reload(message?: string): Promise<void> {
    setRefresh((value) => value + 1);
    if (message) setNotice(message);
  }

  async function submitTransition(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!transition) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/t/${tenantSlug}/tickets/${ticketId}/transitions`, {
        toStatusId: transition.toStatusId,
        expectedVersion: detail?.version,
        reason: needsReason ? reason : undefined,
        resolutionSummary: needsSummary ? summary : undefined,
      });
      setTransitionId("");
      setReason("");
      setSummary("");
      await reload("Status updated.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitComment(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post(`/t/${tenantSlug}/tickets/${ticketId}/comments`, {
        body: commentBody,
        visibility: internal ? "internal" : "public",
      });
      setCommentBody("");
      await reload("Comment added.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitAssignment(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post(`/t/${tenantSlug}/tickets/${ticketId}/assign`, {
        teamId,
        assigneeId: assigneeId || null,
        expectedVersion: detail?.version,
      });
      await reload("Assignment updated.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-lg">
      <div className="detail-top">
        <Link className="back-link" to={`/t/${tenantSlug}/tickets`}>
          ← Tickets
        </Link>
        <div className="detail-title">
          <span className="mono muted">{formatTicketNumber(prefix, detail.number)}</span>
          <h1>{detail.subject}</h1>
          <div className="badge-row">
            <StatusBadge label={detail.status_label} stage={detail.status_stage} />
            <PriorityBadge label={priorityMeta?.label ?? detail.priority_label} color={priorityMeta?.color} />
            <span className="badge subtle">{detail.category_name}</span>
            {detail.reopened_count > 0 && <span className="badge subtle">Reopened {detail.reopened_count}×</span>}
          </div>
        </div>
      </div>

      <ErrorAlert message={error} />
      {notice && <div className="alert success">{notice}</div>}

      <div className="detail-grid">
        <div className="stack">
          <section className="card">
            <div className="section-heading">
              <h2>Request</h2>
              <span className="muted small">Updated {formatDate(detail.updated_at)}</span>
            </div>
            <p className="prose">{detail.description}</p>
            {Object.keys(detail.custom_fields).length > 0 && (
              <dl className="field-list">
                {Object.entries(detail.custom_fields).map(([key, value]) => {
                  const definition = config?.custom_fields.find((field) => field.key === key);
                  let display = String(value);
                  if (typeof value === "boolean") display = value ? "Yes" : "No";
                  if (Array.isArray(value)) display = value.join(", ");
                  return (
                    <div key={key}>
                      <dt>{definition?.label ?? humanize(key)}</dt>
                      <dd>{display}</dd>
                    </div>
                  );
                })}
              </dl>
            )}
            {detail.resolution_summary && (
              <div className="callout success">
                <strong>Resolution</strong>
                <p>{detail.resolution_summary}</p>
              </div>
            )}
            {detail.pending_reason && (
              <div className="callout warning">
                <strong>Waiting on</strong>
                <p>{detail.pending_reason}</p>
              </div>
            )}
          </section>

          <section className="card">
            <div className="section-heading">
              <h2>Conversation</h2>
              <span className="muted small">{detail.comments.length} messages</span>
            </div>
            {detail.comments.length === 0 ? (
              <EmptyState title="No comments yet">Start the conversation below.</EmptyState>
            ) : (
              <div className="comments">
                {detail.comments.map((comment) => (
                  <article key={comment.id} className={`comment ${comment.visibility}`}>
                    <header>
                      <strong>{comment.author_name}</strong>
                      {comment.visibility === "internal" && <span className="internal-tag">internal</span>}
                      <span className="muted small">{formatDate(comment.created_at)}</span>
                    </header>
                    <p>{comment.body}</p>
                  </article>
                ))}
              </div>
            )}

            <form className="comment-form" onSubmit={(event) => void submitComment(event)}>
              <textarea
                rows={4}
                placeholder="Write a reply…"
                value={commentBody}
                onChange={(event) => setCommentBody(event.target.value)}
                required
              />
              <div className="form-footer">
                {canAgent && (
                  <label className="check-row">
                    <input type="checkbox" checked={internal} onChange={(event) => setInternal(event.target.checked)} />
                    Internal note
                  </label>
                )}
                <button className="button" disabled={busy} type="submit">
                  {busy ? "Sending…" : "Send"}
                </button>
              </div>
            </form>
          </section>

          <section className="card">
            <div className="section-heading">
              <h2>Activity</h2>
            </div>
            {timeline.length === 0 ? (
              <EmptyState title="No activity yet" />
            ) : (
              <ol className="timeline">
                {timeline.map((event, index) => (
                  <li key={`${event.time}-${index}`}>
                    <span className={`timeline-dot ${event.kind}`} />
                    <div>
                      <strong>{event.title}</strong>
                      {event.detail && <p>{event.detail}</p>}
                      <span className="muted small">
                        {event.actor} · {formatDate(event.time)}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="stack">
          <section className="card">
            <h2>Details</h2>
            <dl className="meta-list">
              <div>
                <dt>Requester</dt>
                <dd>{detail.requester_name}</dd>
              </div>
              <div>
                <dt>Assignee</dt>
                <dd>{detail.assignee_name ?? "Unassigned"}</dd>
              </div>
              <div>
                <dt>Team</dt>
                <dd>{detail.team_name ?? "No team"}</dd>
              </div>
              <div>
                <dt>Priority</dt>
                <dd>{priorityMeta?.label ?? detail.priority_label}</dd>
              </div>
              <div>
                <dt>First response</dt>
                <dd>{formatDate(detail.first_responded_at)}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatDate(detail.created_at)}</dd>
              </div>
            </dl>
          </section>

          {canAgent && (
            <section className="card">
              <h2>Assignment</h2>
              <form className="stack" onSubmit={(event) => void submitAssignment(event)}>
                <label>
                  Team
                  <select
                    value={teamId}
                    onChange={(event) => {
                      setTeamId(event.target.value);
                      setAssigneeId("");
                    }}
                  >
                    {config?.teams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Assignee
                  <select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
                    <option value="">Unassigned</option>
                    {teamAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="button secondary" disabled={busy || !teamId} type="submit">
                  Update assignment
                </button>
              </form>
            </section>
          )}

          <section className="card">
            <h2>Move ticket</h2>
            {detail.allowed_transitions.length === 0 ? (
              <p className="muted">
                {role === "employee"
                  ? "No action is available to you right now."
                  : "No transitions are configured for your role."}
              </p>
            ) : (
              <form className="stack" onSubmit={(event) => void submitTransition(event)}>
                <label>
                  Next status
                  <select value={transitionId} onChange={(event) => setTransitionId(event.target.value)}>
                    <option value="">Choose…</option>
                    {detail.allowed_transitions.map((item) => (
                      <option key={item.toStatusId} value={item.toStatusId}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                {needsReason && (
                  <label>
                    Reason
                    <textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} required />
                  </label>
                )}
                {needsSummary && (
                  <label>
                    Resolution summary
                    <textarea rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} required />
                  </label>
                )}
                {transition && transition.requiresAssignee && !detail.assignee_id && (
                  <p className="muted small">Assign this ticket before moving it.</p>
                )}
                <button className="button" disabled={busy || !transition} type="submit">
                  {busy ? "Updating…" : "Apply transition"}
                </button>
              </form>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
