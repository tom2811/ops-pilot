import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { formatTicketNumber, renderTemplate } from "@opspilot/core";
import { ApiError, api, apiUrl, del, errorMessage, formatDate, humanize, patch, post } from "../api.js";
import { useAuth } from "../auth.js";
import { DetailSkeleton, EmptyState, ErrorAlert, PriorityBadge, SlaBadge, StatusBadge } from "../components.js";
import { Select, useConfirm, useToast } from "../ui.js";
import type { Config, CustomField, TicketDetail, TicketLink, TicketLinkType } from "../types.js";
import { CustomFieldInput } from "./TicketsPage.js";

function linkTypeLabel(type: TicketLinkType): string {
  switch (type) {
    case "relates_to":
      return "Relates to";
    case "duplicates":
      return "Duplicates";
    case "duplicated_by":
      return "Duplicated by";
    case "blocks":
      return "Blocks";
    case "blocked_by":
      return "Blocked by";
    case "causes":
      return "Causes";
    case "caused_by":
      return "Caused by";
    case "merged_into":
      return "Merged into";
    case "merged_from":
      return "Merged from";
    default:
      return type;
  }
}

function slaState(
  due: string | null,
  breached: string | null,
  met: string | null,
  paused: string | null,
  warningAt?: string | null,
  createdAt?: string | null,
  stoppedAt?: string | null,
): "breached" | "met" | "paused" | "warning" | "overdue" | "active" | null {
  if (!due) return null;
  if (breached) return "breached";
  if (stoppedAt) {
    return new Date(stoppedAt).getTime() > new Date(due).getTime() ? "breached" : "met";
  }
  if (met) return "met";
  if (paused) return "paused";
  const now = Date.now();
  const dueTime = new Date(due).getTime();
  if (dueTime < now) return "overdue";
  if (warningAt) return "warning";
  if (createdAt) {
    const createdTime = new Date(createdAt).getTime();
    const total = dueTime - createdTime;
    if (total > 0 && (now - createdTime) / total >= 0.8) {
      return "warning";
    }
  }
  return "active";
}

function slaLabel(state: string, closed: boolean): string {
  if (state === "warning") return "At risk";
  if (state === "breached") return closed ? "Breached (historical)" : "Breached";
  if (state === "overdue") return "Overdue";
  if (state === "paused") return "Paused";
  if (state === "met") return "Met";
  if (state === "active") return "Active";
  return state;
}

type TimelineEvent = {
  time: string;
  title: string;
  detail?: string;
  actor?: string;
  kind: "status" | "assignment" | "audit" | "danger" | "warning";
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

  const [linkType, setLinkType] = useState<TicketLinkType>("relates_to");
  const [targetTicketNum, setTargetTicketNum] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [showAddLink, setShowAddLink] = useState(false);

  const [showMergeModal, setShowMergeModal] = useState(false);
  const [mergeTargetNum, setMergeTargetNum] = useState("");
  const [mergeDirection, setMergeDirection] = useState<"merge_into_this" | "merge_this_into">("merge_into_this");
  const [mergeReason, setMergeReason] = useState("");
  const [mergeBusy, setMergeBusy] = useState(false);

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

  if (loading && !detail) return <DetailSkeleton label="Loading ticket" />;
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
  const isClosed = detail.status_stage === "closed" || Boolean(detail.merged_into);
  const responseSla = slaState(
    detail.sla_response_due_at,
    detail.sla_response_breached_at,
    detail.first_responded_at,
    detail.sla_paused_at,
    detail.sla_response_warning_at,
    detail.created_at,
    isClosed ? (detail.first_responded_at ?? detail.resolved_at ?? detail.closed_at) : null,
  );
  const resolutionSla = slaState(
    detail.sla_resolution_due_at,
    detail.sla_resolution_breached_at,
    detail.resolved_at,
    detail.sla_paused_at,
    detail.sla_resolution_warning_at,
    detail.created_at,
    isClosed ? (detail.resolved_at ?? detail.closed_at) : null,
  );

  const timeline: TimelineEvent[] = [
    ...detail.history.map((event) => ({
      time: event.created_at,
      title: event.from_label ? `${event.from_label} → ${event.to_label}` : `Opened as ${event.to_label}`,
      detail: event.reason === "assigned" ? "Assigned to team" : (event.reason ?? undefined),
      actor: event.actor_name ?? humanize(event.actor_role),
      kind: "status" as const,
    })),
    ...detail.assignments.map((event) => ({
      time: event.created_at,
      title: event.to_assignee_name
        ? `Assigned to ${event.to_assignee_name}`
        : `Assigned to ${event.to_team_name ?? "a team"}`,
      detail: event.to_assignee_name && event.to_team_name ? `Team: ${event.to_team_name}` : undefined,
      actor: event.actor_name ?? humanize(event.actor_role),
      kind: "assignment" as const,
    })),
    ...detail.updates
      .filter((event) => {
        if (event.action === "ticket.merged") {
          const after = event.after as {
            secondaryTicketNumber?: number;
            mergedIntoTicketNumber?: number;
            mergedTicketNumber?: number;
          } | undefined;
          return Boolean(after?.secondaryTicketNumber || after?.mergedIntoTicketNumber || after?.mergedTicketNumber);
        }
        return true;
      })
      .map((event) => {
        let title = "Ticket details updated";
        let detailText: string | undefined;
        let kind: TimelineEvent["kind"] = "audit";

        if (event.action === "ticket.sla_response_breached") {
          title = "Response SLA breached";
          kind = "danger";
        } else if (event.action === "ticket.sla_resolution_breached") {
          title = "Resolution SLA breached";
          kind = "danger";
        } else if (event.action === "ticket.sla_response_warning") {
          title = "Response SLA warning";
          detailText = "Approaching breach threshold (80% time elapsed)";
          kind = "warning";
        } else if (event.action === "ticket.sla_resolution_warning") {
          title = "Resolution SLA warning";
          detailText = "Approaching breach threshold (80% time elapsed)";
          kind = "warning";
        } else if (event.action === "ticket.sla_escalated") {
          const after = event.after as { kind?: string; threshold?: number } | undefined;
          title = `SLA escalation triggered (${after?.kind ?? "resolution"} at ${after?.threshold ?? 100}%)`;
          detailText = "Escalation notification dispatched";
          kind = "warning";
        } else if (event.action === "ticket.merged") {
          const after = event.after as {
            secondaryTicketNumber?: number;
            mergedIntoTicketNumber?: number;
            mergedTicketNumber?: number;
            reason?: string;
          } | undefined;
          if (after?.secondaryTicketNumber) {
            title = `Merged ticket #${after.secondaryTicketNumber} into this ticket`;
          } else if (after?.mergedIntoTicketNumber) {
            title = `Merged into ticket #${after.mergedIntoTicketNumber}`;
          } else if (after?.mergedTicketNumber) {
            title = `Merged ticket #${after.mergedTicketNumber} into this ticket`;
          } else {
            title = "Ticket merged";
          }
          if (after?.reason) {
            detailText = `Reason: ${after.reason}`;
          }
        } else if (event.action === "ticket.link_created") {
          const after = event.after as { targetTicketNumber?: number; linkType?: TicketLinkType } | undefined;
          title = after?.targetTicketNumber
            ? `Linked to #${after.targetTicketNumber} (${linkTypeLabel(after.linkType ?? "relates_to")})`
            : "Ticket link added";
        } else if (event.action === "ticket.link_deleted") {
          const before = event.before as { targetTicketNumber?: number } | undefined;
          title = before?.targetTicketNumber
            ? `Removed link to #${before.targetTicketNumber}`
            : "Ticket link removed";
        } else if (event.action === "ticket.updated") {
          const after = event.after as Record<string, unknown> | undefined;
          if (after) {
            const changed: string[] = [];
            if (after.subject) changed.push("subject");
            if (after.priorityId) changed.push("priority");
            if (after.categoryId) changed.push("category");
            if (
              after.customFields &&
              typeof after.customFields === "object" &&
              Object.keys(after.customFields).length > 0
            ) {
              changed.push("custom fields");
            }
            if (changed.length > 0) {
              detailText = `Updated ${changed.join(", ")}`;
            }
          }
        }

        return {
          time: event.created_at,
          title,
          detail: detailText,
          actor: event.actor_name ?? humanize(event.actor_role),
          kind,
        };
      }),
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

  function handleInsertCanned(cannedId: string): void {
    if (!cannedId || !detail) return;
    const canned = config?.canned_responses?.find((item) => item.id === cannedId);
    if (!canned) return;
    const formattedNum = formatTicketNumber(prefix, detail.number);
    const text = renderTemplate(canned.body, {
      ticket: {
        number: formattedNum,
        subject: detail.subject,
      },
      number: formattedNum,
      subject: detail.subject,
      requester: {
        name: detail.requester_name,
      },
      requesterName: detail.requester_name,
      agent: {
        name: user?.displayName ?? "",
      },
      agentName: user?.displayName ?? "",
      "ticket.number": formattedNum,
      "ticket.subject": detail.subject,
      "requester.name": detail.requester_name,
      "agent.name": user?.displayName ?? "",
    });
    setCommentBody((current) => (current ? `${current}\n\n${text}` : text));
  }

  async function submitComment(countsAsFirstResponse = false): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await post(`/t/${tenantSlug}/tickets/${ticketId}/comments`, {
        body: commentBody,
        visibility: internal ? "internal" : "public",
        countsAsFirstResponse: !internal && countsAsFirstResponse,
      });
      setCommentBody("");
      await reload("Comment added.");
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function claim(): Promise<void> {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/t/${tenantSlug}/tickets/${ticketId}/claim`, { expectedVersion: detail.version });
      await reload("Ticket claimed.");
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
      const response = await fetch(apiUrl(`/t/${tenantSlug}/tickets/${ticketId}/attachments`), {
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

  async function submitCreateLink(event: FormEvent): Promise<void> {
    event.preventDefault();
    const num = parseInt(targetTicketNum.trim(), 10);
    if (isNaN(num) || num <= 0) {
      setError("Valid ticket number is required");
      return;
    }
    setLinkBusy(true);
    setError(null);
    try {
      await post(`/t/${tenantSlug}/tickets/${ticketId}/links`, {
        targetTicketNumber: num,
        linkType,
      });
      setTargetTicketNum("");
      setShowAddLink(false);
      await reload("Ticket linked.");
    } catch (caught) {
      handleError(caught);
    } finally {
      setLinkBusy(false);
    }
  }

  async function removeLink(linkId: string): Promise<void> {
    const confirmed = await confirm({
      title: "Remove ticket link?",
      body: "Are you sure you want to remove this relationship?",
      confirmLabel: "Unlink",
      tone: "danger",
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await del(`/t/${tenantSlug}/tickets/${ticketId}/links/${linkId}`);
      await reload("Link removed.");
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }

  function closeMergeModal(): void {
    setShowMergeModal(false);
    setMergeTargetNum("");
    setMergeReason("");
  }

  async function submitMerge(event: FormEvent): Promise<void> {
    event.preventDefault();
    const num = parseInt(mergeTargetNum.trim(), 10);
    if (isNaN(num) || num <= 0) {
      setError("Valid ticket number is required");
      return;
    }
    setMergeBusy(true);
    setError(null);
    try {
      const res = await post<{
        primaryTicketId: string;
        secondaryTicketId: string;
        primaryNumber: number;
        secondaryNumber: number;
        redirectedFromPrimaryNumber?: number | null;
      }>(`/t/${tenantSlug}/tickets/${ticketId}/merge`, {
        targetTicketNumber: num,
        direction: mergeDirection,
        reason: mergeReason.trim() || undefined,
      });
      setShowMergeModal(false);
      setMergeTargetNum("");
      setMergeReason("");
      const autoRedirectMsg = res.redirectedFromPrimaryNumber
        ? ` (target #${res.redirectedFromPrimaryNumber} was previously merged into #${res.primaryNumber})`
        : "";
      if (mergeDirection === "merge_this_into") {
        toast.success(`Ticket merged into #${res.primaryNumber}${autoRedirectMsg}.`);
        navigate(`/t/${tenantSlug}/tickets/${res.primaryTicketId}`);
      } else {
        await reload(`Merged ticket #${res.secondaryNumber} into this ticket${autoRedirectMsg}.`);
      }
    } catch (caught) {
      handleError(caught);
    } finally {
      setMergeBusy(false);
    }
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
        <div className="detail-header-row">
          <div className="detail-title">
            <span className="mono muted">{formatTicketNumber(prefix, detail.number)}</span>
            <h1>{detail.subject}</h1>
            <div className="badge-row">
              <StatusBadge label={detail.status_label} stage={detail.status_stage} />
              <PriorityBadge label={priorityMeta?.label ?? detail.priority_label} color={priorityMeta?.color} />
              <span className="badge subtle">{detail.category_name}</span>
              {detail.reopened_count > 0 && <span className="badge subtle">Reopened {detail.reopened_count}×</span>}
              {resolutionSla === "breached" && (
                <SlaBadge
                  label={isClosed ? "SLA breached before closure" : "SLA breached"}
                  state={isClosed ? "historical" : "breached"}
                />
              )}
              {!isClosed && resolutionSla === "warning" && <SlaBadge label="SLA at risk" state="warning" />}
              {!isClosed && resolutionSla === "paused" && <SlaBadge label="SLA paused" state="paused" />}
              {isClosed && resolutionSla === "met" && <SlaBadge label="SLA met" state="met" />}
              {detail.pending_chaser_sent_at && <span className="badge subtle">Pending reminder sent</span>}
            </div>
          </div>
          {canEdit && (
            <div className="page-actions detail-actions">
              <button className="button secondary" onClick={startEditing}>
                Edit ticket
              </button>
              {canAgent && !detail.merged_into && (
                <button className="button secondary" onClick={() => setShowMergeModal(true)}>
                  Merge ticket
                </button>
              )}
              {role === "tenant_admin" && (
                <button className="button ghost danger" onClick={() => void removeTicket()} disabled={busy}>
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
        {detail.merged_into && (
          <div className="callout warning" style={{ marginTop: "0.75rem" }}>
            <strong>Ticket merged</strong>
            <p>
              This ticket was merged into{" "}
              <Link to={`/t/${tenantSlug}/tickets/${detail.merged_into.id}`}>
                {formatTicketNumber(prefix, detail.merged_into.number)}: {detail.merged_into.subject}
              </Link>
              . It is closed and incoming replies are redirected.
            </p>
          </div>
        )}
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
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <h2>Request</h2>
                <span className="badge subtle" style={{ fontSize: "0.75rem", padding: "2px 8px" }}>
                  Intake: {detail.source === "email" ? "via Email" : "via Web"}
                </span>
              </div>
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
                <strong>{detail.status_label === "Waiting on vendor" ? "Waiting on vendor" : "Waiting on"}</strong>
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
                      <a href={apiUrl(`/t/${tenantSlug}/attachments/${attachment.id}/download`)}>
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

          {canAgent && (
            <section className="card">
              <div className="section-heading">
                <h2>Linked tickets</h2>
                <span className="muted small">
                  {detail.links?.length ?? 0} {detail.links?.length === 1 ? "link" : "links"}
                </span>
              </div>

              {(!detail.links || detail.links.length === 0) && !showAddLink ? (
                <EmptyState title="No linked tickets">
                  Link related tickets, blockers, duplicates, or incident causes.
                </EmptyState>
              ) : null}

              {detail.links && detail.links.length > 0 && (
                <ul className="attachment-list">
                  {detail.links.map((link) => (
                    <li key={link.id}>
                      <div>
                        <span className="badge subtle" style={{ marginRight: "0.5rem" }}>
                          {linkTypeLabel(link.link_type)}
                        </span>
                        <Link to={`/t/${tenantSlug}/tickets/${link.linked_ticket_id}`}>
                          {formatTicketNumber(prefix, link.linked_ticket_number)}: {link.linked_ticket_subject}
                        </Link>
                        <span className="muted small" style={{ marginLeft: "0.5rem" }}>
                          ({link.linked_ticket_status})
                        </span>
                      </div>
                      {link.link_type !== "merged_into" && link.link_type !== "merged_from" && (
                        <button
                          type="button"
                          className="button ghost small"
                          disabled={busy}
                          onClick={() => void removeLink(link.id)}
                        >
                          Unlink
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {!showAddLink && (
                <div style={{ marginTop: "1rem" }}>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => setShowAddLink(true)}
                  >
                    Link ticket
                  </button>
                </div>
              )}

              {showAddLink && (
                <form
                  className="stack"
                  style={{ marginTop: "1rem", borderTop: "1px solid var(--hairline)", paddingTop: "1rem" }}
                  onSubmit={(event) => void submitCreateLink(event)}
                >
                  <div className="inline-fields">
                    <label>
                      Relationship
                      <Select
                        ariaLabel="Relationship"
                        value={linkType}
                        onChange={(val) => setLinkType(val as TicketLinkType)}
                        options={[
                          { value: "relates_to", label: "Relates to" },
                          { value: "blocks", label: "Blocks" },
                          { value: "blocked_by", label: "Blocked by" },
                          { value: "duplicates", label: "Duplicates" },
                          { value: "duplicated_by", label: "Duplicated by" },
                          { value: "causes", label: "Causes" },
                          { value: "caused_by", label: "Caused by" },
                        ]}
                      />
                    </label>
                    <label>
                      Target ticket number
                      <input
                        type="number"
                        placeholder="e.g. 102"
                        value={targetTicketNum}
                        onChange={(e) => setTargetTicketNum(e.target.value)}
                        required
                        min={1}
                      />
                    </label>
                  </div>
                  <div className="form-footer" style={{ display: "flex", gap: "0.5rem" }}>
                    <button className="button small" disabled={linkBusy || !targetTicketNum}>
                      {linkBusy ? "Linking..." : "Create link"}
                    </button>
                    <button
                      type="button"
                      className="button ghost small"
                      onClick={() => {
                        setShowAddLink(false);
                        setTargetTicketNum("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}

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
                      {comment.visibility === "internal" ? (
                        <span className="internal-tag">internal</span>
                      ) : (
                        <span className="badge subtle" style={{ fontSize: "0.72rem", padding: "1px 6px" }}>
                          {comment.channel === "email" ? "via Email" : "via Web"}
                        </span>
                      )}
                      <span className="muted small">{formatDate(comment.created_at)}</span>
                    </header>
                    <p>{comment.body}</p>
                  </article>
                ))}
              </div>
            )}

            <form
              className="comment-form"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void submitComment(false);
              }}
            >
              {canAgent && (config?.canned_responses?.length ?? 0) > 0 && (
                <div className="canned-response-picker">
                  <Select
                    ariaLabel="Insert canned response"
                    value=""
                    placeholder="Insert canned response..."
                    onChange={handleInsertCanned}
                    options={(config?.canned_responses ?? []).map((c) => ({
                      value: c.id,
                      label: `${c.title} (/${c.shortcut})`,
                    }))}
                  />
                </div>
              )}
              <textarea
                rows={4}
                placeholder="Write a reply..."
                value={commentBody}
                onChange={(event) => setCommentBody(event.target.value)}
                required
              />
              <div className="form-footer" style={{ flexDirection: "column", alignItems: "stretch", gap: "8px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  {canAgent ? (
                    <label className="check-row">
                      <input type="checkbox" checked={internal} onChange={(event) => setInternal(event.target.checked)} />
                      Internal note
                    </label>
                  ) : <span />}
                  {canAgent && !internal && !detail.first_responded_at ? (
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button className="button ghost" disabled={busy} type="submit">
                        {busy ? "Sending…" : "Send acknowledgement"}
                      </button>
                      <button
                        className="button"
                        disabled={busy}
                        type="button"
                        onClick={() => void submitComment(true)}
                      >
                        Send first response
                      </button>
                    </div>
                  ) : (
                    <button className="button" disabled={busy} type="submit">
                      {busy ? "Sending…" : internal ? "Add internal note" : "Submit public reply"}
                    </button>
                  )}
                </div>
                <div className="muted small" style={{ fontSize: "0.78rem" }}>
                  {internal
                    ? "Private note: Visible only to agents and staff. No email notification sent."
                    : canAgent && !detail.first_responded_at
                      ? `Acknowledgement does not stop the response SLA. First response emails ${detail.requester_name} and stops the clock.`
                      : `Public reply: Will be dispatched via SMTP to ${detail.requester_name}.`}
                </div>
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
              {detail.participants && detail.participants.length > 0 && (
                <div>
                  <dt>Participants</dt>
                  <dd>
                    {detail.participants.map((p) => p.display_name).join(", ")}
                  </dd>
                </div>
              )}
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
                    {responseSla && (
                      <SlaBadge
                        label={slaLabel(responseSla, isClosed)}
                        state={isClosed && responseSla === "breached" ? "historical" : responseSla}
                      />
                    )}
                  </dd>
                </div>
              )}
              {detail.sla_resolution_due_at && (
                <div>
                  <dt>Resolution SLA</dt>
                  <dd>
                    {formatDate(detail.sla_resolution_due_at)}{" "}
                    {resolutionSla && (
                      <SlaBadge
                        label={slaLabel(resolutionSla, isClosed)}
                        state={isClosed && resolutionSla === "breached" ? "historical" : resolutionSla}
                      />
                    )}
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
              {!detail.assignee_id && detail.team_id && (
                <button className="button" disabled={busy} type="button" onClick={() => void claim()}>
                  Claim
                </button>
              )}
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

      {showMergeModal && (
        <div className="dialog-backdrop" onClick={closeMergeModal}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="section-heading">
              <h2>Merge ticket</h2>
              <button
                type="button"
                className="button ghost small"
                onClick={closeMergeModal}
              >
                Close
              </button>
            </div>
            <p className="prose muted small">
              Combine two tickets. The secondary ticket will be closed and conversation history combined.
            </p>
            <form className="stack" onSubmit={(e) => void submitMerge(e)}>
              <label>
                Target ticket number
                <input
                  type="number"
                  placeholder="e.g. 102"
                  value={mergeTargetNum}
                  onChange={(e) => setMergeTargetNum(e.target.value)}
                  required
                  min={1}
                />
              </label>
              <label>
                Direction
                <Select
                  ariaLabel="Merge direction"
                  value={mergeDirection}
                  onChange={(val) => setMergeDirection(val as "merge_into_this" | "merge_this_into")}
                  options={[
                    {
                      value: "merge_into_this",
                      label: `Merge #${mergeTargetNum || "X"} into this ticket (${formatTicketNumber(prefix, detail.number)})`,
                    },
                    {
                      value: "merge_this_into",
                      label: `Merge this ticket into #${mergeTargetNum || "X"}`,
                    },
                  ]}
                />
              </label>
              <label>
                Reason (optional)
                <textarea
                  rows={2}
                  placeholder="e.g. Duplicate report from email intake"
                  value={mergeReason}
                  onChange={(e) => setMergeReason(e.target.value)}
                />
              </label>
              <div className="dialog-actions">
                <button
                  type="button"
                  className="button ghost"
                  onClick={closeMergeModal}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button danger"
                  disabled={mergeBusy || !mergeTargetNum}
                >
                  {mergeBusy ? "Merging..." : "Confirm merge"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
