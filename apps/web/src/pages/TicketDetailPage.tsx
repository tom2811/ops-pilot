import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { formatTicketNumber } from "@opspilot/core";
import { ApiError, api, del, errorMessage, formatDate, humanize, patch, post } from "../api.js";
import { useAuth } from "../auth.js";
import { EmptyState, ErrorAlert, PriorityBadge, SlaBadge, Spinner, StatusBadge } from "../components.js";
import { Select, useConfirm, useToast } from "../ui.js";
import type { Config, CustomField, TicketDetail } from "../types.js";
import { CustomFieldInput } from "./TicketsPage.js";

function slaState(
  due: string | null,
  breached: string | null,
  met: string | null,
  paused: string | null,
): "breached" | "met" | "paused" | "overdue" | "active" | null {
  if (!due) return null;
  if (breached) return "breached";
  if (met) return "met";
  if (paused) return "paused";
  return new Date(due).getTime() < Date.now() ? "overdue" : "active";
}

type TimelineEvent = {
  time: string;
  title: string;
  detail?: string;
  actor?: string;
  kind: "status" | "assignment" | "audit";
};

export function TicketDetailPage() {
  const { tenantSlug = "", ticketId = "" } = useParams();
  const { user, memberships } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const role = memberships.find((item) => item.slug === tenantSlug)?.role ?? "employee";
  const canAgent = role === "agent" || role === "tenant_admin";

  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const keepConflictError = useRef(false);

  const [transitionId, setTransitionId] = useState("");
  const [reason, setReason] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);

  const [commentBody, setCommentBody] = useState("");
  const [internal, setInternal] = useState(false);

  const [teamId, setTeamId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");

  const [editing, setEditing] = useState(false);
  const [editSubject, setEditSubject] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editCategoryId, setEditCategoryId] = useState("");
  const [editPriorityId, setEditPriorityId] = useState("");
  const [editCustomFields, setEditCustomFields] = useState<Record<string, unknown>>({});
  const [editBusy, setEditBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api<TicketDetail>(`/t/${tenantSlug}/tickets/${ticketId}`), api<Config>(`/t/${tenantSlug}/config`)])
      .then(([nextDetail, nextConfig]) => {
        if (cancelled) return;
        setDetail(nextDetail);
        setConfig(nextConfig);
        if (!keepConflictError.current) setError(null);
        keepConflictError.current = false;
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
  const responseSla = slaState(
    detail.sla_response_due_at,
    detail.sla_response_breached_at,
    detail.first_responded_at,
    detail.sla_paused_at,
  );
  const resolutionSla = slaState(
    detail.sla_resolution_due_at,
    detail.sla_resolution_breached_at,
    detail.resolved_at,
    detail.sla_paused_at,
  );

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
    ...detail.updates.map((event) => ({
      time: event.created_at,
      title: "Ticket details updated",
      actor: event.actor_name ?? humanize(event.actor_role),
      kind: "audit" as const,
    })),
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  async function reload(message?: string): Promise<void> {
    setRefresh((value) => value + 1);
    if (message) toast.success(message);
  }

  function handleError(caught: unknown): void {
    setError(errorMessage(caught));
    if (caught instanceof ApiError && caught.status === 409) {
      keepConflictError.current = true;
      setRefresh((value) => value + 1);
    }
  }

  async function submitTransition(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!transition) return;
    if (transition.requiresAssignee && !detail?.assignee_id) {
      setError("Assign the ticket first");
      return;
    }
    if (needsSummary && !summary.trim()) {
      setError("Resolution summary is required");
      return;
    }
    if (needsReason && !reason.trim()) {
      setError("Reason is required");
      return;
    }
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
      handleError(caught);
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
      handleError(caught);
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
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }

  function startEditing(): void {
    if (!detail) return;
    setEditSubject(detail.subject);
    setEditDescription(detail.description);
    setEditCategoryId(detail.category_id);
    setEditPriorityId(detail.priority_id);
    setEditCustomFields(detail.custom_fields);
    setEditing(true);
  }

  async function submitEdit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!detail) return;
    setEditBusy(true);
    setError(null);
    try {
      await patch(`/t/${tenantSlug}/tickets/${ticketId}`, {
        subject: editSubject,
        description: editDescription,
        categoryId: editCategoryId,
        priorityId: editPriorityId,
        customFields: editCustomFields,
        expectedVersion: detail.version,
      });
      setEditing(false);
      await reload("Ticket updated.");
    } catch (caught) {
      handleError(caught);
    } finally {
      setEditBusy(false);
    }
  }

  async function removeTicket(): Promise<void> {
    if (!detail) return;
    const ticketLabel = formatTicketNumber(prefix, detail.number);
    const confirmed = await confirm({
      title: `Delete ticket ${ticketLabel}?`,
      body: "The ticket, its conversation, attachments, and history will be removed. This cannot be undone.",
      confirmLabel: "Delete ticket",
      tone: "danger",
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await del(`/t/${tenantSlug}/tickets/${ticketId}`);
      toast.success("Ticket deleted", ticketLabel);
      navigate(`/t/${tenantSlug}/tickets`, { replace: true });
    } catch (caught) {
      handleError(caught);
      setBusy(false);
    }
  }

  async function uploadAttachment(): Promise<void> {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch(`/api/t/${tenantSlug}/tickets/${ticketId}/attachments`, {
        method: "POST",
        body,
        credentials: "include",
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `Upload failed (${response.status})`);
      }
      setFile(null);
      setFileKey((value) => value + 1);
      await reload("Attachment uploaded.");
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function removeAttachment(id: string): Promise<void> {
    const confirmed = await confirm({
      title: "Delete this attachment?",
      body: "The file will be removed from the ticket permanently.",
      confirmLabel: "Delete attachment",
      tone: "danger",
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await del(`/t/${tenantSlug}/attachments/${id}`);
      await reload("Attachment deleted.");
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }

  function formatSize(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  const canEdit =
    role === "tenant_admin" ||
    role === "agent" ||
    (role === "employee" &&
      user?.id === detail.requester_id &&
      detail.status_stage !== "resolved" &&
      detail.status_stage !== "closed");
  const editFields =
    config?.custom_fields.filter(
      (field) => field.applies_to_category_id === null || field.applies_to_category_id === editCategoryId,
    ) ?? [];

  return (
    <div className="stack-lg">
      <div className="detail-top">
        <Link className="back-link" to={`/t/${tenantSlug}/tickets`}>
          ← Tickets
        </Link>
        <div className="detail-title">
          <span className="mono muted">{formatTicketNumber(prefix, detail.number)}</span>
          <h1>{detail.subject}</h1>
          {canEdit && (
            <div className="page-actions detail-actions">
              <button className="button secondary" onClick={startEditing}>
                Edit ticket
              </button>
              {role === "tenant_admin" && (
                <button className="button ghost danger" onClick={() => void removeTicket()} disabled={busy}>
                  Delete
                </button>
              )}
            </div>
          )}
          <div className="badge-row">
            <StatusBadge label={detail.status_label} stage={detail.status_stage} />
            <PriorityBadge label={priorityMeta?.label ?? detail.priority_label} color={priorityMeta?.color} />
            <span className="badge subtle">{detail.category_name}</span>
            {detail.reopened_count > 0 && <span className="badge subtle">Reopened {detail.reopened_count}×</span>}
            {resolutionSla === "breached" && <SlaBadge label="SLA breached" state="breached" />}
            {resolutionSla === "paused" && <SlaBadge label="SLA paused" state="paused" />}
          </div>
        </div>
      </div>

      <ErrorAlert message={error} />

      <div className="detail-grid">
        <div className="stack">
          {editing && (
            <section className="card">
              <div className="section-heading">
                <h2>Edit ticket</h2>
                <button className="button ghost small" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
              <form className="stack" onSubmit={(event) => void submitEdit(event)}>
                <label>
                  Subject
                  <input value={editSubject} onChange={(event) => setEditSubject(event.target.value)} maxLength={200} required />
                </label>
                <label>
                  Description
                  <textarea
                    value={editDescription}
                    onChange={(event) => setEditDescription(event.target.value)}
                    rows={7}
                    maxLength={20000}
                    required
                  />
                </label>
                <div className="inline-fields">
                  <label>
                    Category
                    <Select
                      ariaLabel="Category"
                      value={editCategoryId}
                      onChange={setEditCategoryId}
                      disabled={role === "employee"}
                      options={config?.categories.map((category) => ({ value: category.id, label: category.name })) ?? []}
                    />
                  </label>
                  <label>
                    Priority
                    <Select
                      ariaLabel="Priority"
                      value={editPriorityId}
                      onChange={setEditPriorityId}
                      disabled={role === "employee"}
                      options={config?.priorities.map((priority) => ({ value: priority.id, label: priority.label })) ?? []}
                    />
                  </label>
                </div>
                {editFields.map((field: CustomField) => (
                  <CustomFieldInput
                    key={field.id}
                    field={field}
                    value={editCustomFields[field.key]}
                    onChange={(value) =>
                      setEditCustomFields((current) => ({ ...current, [field.key]: value }))
                    }
                  />
                ))}
                <div className="form-footer">
                  <button className="button" disabled={editBusy}>
                    {editBusy ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </form>
            </section>
          )}

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
              <h2>Attachments</h2>
              <span className="muted small">{detail.attachments.length} {detail.attachments.length === 1 ? "file" : "files"}</span>
            </div>
            {detail.attachments.length === 0 ? (
              <EmptyState title="No attachments">Files shared on this ticket appear here.</EmptyState>
            ) : (
              <ul className="attachment-list">
                {detail.attachments.map((attachment) => (
                  <li key={attachment.id}>
                    <div>
                      <a href={`/api/t/${tenantSlug}/attachments/${attachment.id}/download`}>
                        {attachment.filename}
                      </a>
                      <span className="muted small">
                        {formatSize(attachment.size)} · {attachment.uploader_name} · {formatDate(attachment.created_at)}
                      </span>
                    </div>
                    {(role === "tenant_admin" || attachment.uploader_id === user?.id) && (
                      <button
                        className="button ghost small"
                        disabled={busy}
                        onClick={() => void removeAttachment(attachment.id)}
                      >
                        Delete
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <form
                className="attachment-upload"
                onSubmit={(event) => {
                  event.preventDefault();
                  void uploadAttachment();
                }}
              >
                <input
                  key={fileKey}
                  type="file"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
                <button className="button secondary" disabled={!file || busy}>
                  {busy ? "Uploading…" : "Upload"}
                </button>
              </form>
            )}
          </section>

          <section className="card">
            <div className="section-heading">
              <h2>Conversation</h2>
              <span className="muted small">{detail.comments.length} {detail.comments.length === 1 ? "message" : "messages"}</span>
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
              {detail.sla_response_due_at && (
                <div>
                  <dt>Response SLA</dt>
                  <dd>
                    {formatDate(detail.sla_response_due_at)}{" "}
                    {responseSla && <SlaBadge label={responseSla} state={responseSla} />}
                  </dd>
                </div>
              )}
              {detail.sla_resolution_due_at && (
                <div>
                  <dt>Resolution SLA</dt>
                  <dd>
                    {formatDate(detail.sla_resolution_due_at)}{" "}
                    {resolutionSla && <SlaBadge label={resolutionSla} state={resolutionSla} />}
                  </dd>
                </div>
              )}
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
                  <Select
                    ariaLabel="Team"
                    value={teamId}
                    onChange={(next) => {
                      setTeamId(next);
                      setAssigneeId("");
                    }}
                    options={config?.teams.map((team) => ({ value: team.id, label: team.name })) ?? []}
                  />
                </label>
                <label>
                  Assignee
                  <Select
                    ariaLabel="Assignee"
                    value={assigneeId}
                    onChange={setAssigneeId}
                    options={[
                      { value: "", label: "Unassigned" },
                      ...teamAgents.map((agent) => ({ value: agent.id, label: agent.name })),
                    ]}
                  />
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
                  <Select
                    ariaLabel="Next status"
                    value={transitionId}
                    onChange={setTransitionId}
                    placeholder="Choose…"
                    options={[
                      { value: "", label: "Choose…" },
                      ...detail.allowed_transitions.map((item) => ({
                        value: item.toStatusId,
                        label: item.label,
                      })),
                    ]}
                  />
                </label>
                {needsReason && (
                  <label>
                    Reason
                    <textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
                  </label>
                )}
                {needsSummary && (
                  <label>
                    Resolution summary
                    <textarea rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} />
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
