import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { formatTicketNumber, isSlaAtRisk } from "@opspilot/core";
import { api, downloadFile, errorMessage, formatDate, post, triggerDownload } from "../api.js";
import { useAuth } from "../auth.js";
import { EmptyState, ErrorAlert, PageHeader, Pager, PriorityBadge, SkeletonRows, SlaBadge, StatusBadge } from "../components.js";
import { Icon, Sheet, Select, useToast } from "../ui.js";
import type { Config, CustomField, Ticket, TicketList } from "../types.js";

type RoutePreview = { teamName: string; explanation: string };

function clockAtRisk(
  warnDue: string | null | undefined,
  due: string | null | undefined,
  createdAt: string,
): boolean {
  if (!due) return false;
  const end = new Date(due).getTime();
  const now = Date.now();
  if (!Number.isFinite(end) || now >= end) return false;
  if (warnDue) {
    const warn = new Date(warnDue).getTime();
    return Number.isFinite(warn) && now >= warn;
  }
  return isSlaAtRisk(createdAt, due);
}

export function CustomFieldInput({
  field,
  value,
  onChange,
}: {
  field: CustomField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `field-${field.key}`;

  if (field.type === "checkbox") {
    return (
      <label className="check-row" htmlFor={id}>
        <input id={id} type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
        <span className="field-label">
          {field.label}
          {field.required && <span className="required"> *</span>}
          {field.visibility === "internal" && <span className="internal-tag">internal</span>}
        </span>
      </label>
    );
  }

  if (field.type === "multiselect") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset className="field-group">
        <legend>
          <span className="field-label">
            {field.label}
            {field.required && <span className="required"> *</span>}
            {field.visibility === "internal" && <span className="internal-tag">internal</span>}
          </span>
        </legend>
        {field.options.map((option) => (
          <label key={option} className="check-row">
            <input
              type="checkbox"
              checked={selected.includes(option)}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...selected, option]
                  : selected.filter((item) => item !== option);
                onChange(next);
              }}
            />
            {option}
          </label>
        ))}
      </fieldset>
    );
  }

  return (
    <label htmlFor={id}>
      <span className="field-label">
        {field.label}
        {field.required && <span className="required"> *</span>}
        {field.visibility === "internal" && <span className="internal-tag">internal</span>}
      </span>
      {field.type === "textarea" ? (
        <textarea id={id} rows={3} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />
      ) : field.type === "select" ? (
        <Select
          ariaLabel={field.label}
          value={String(value ?? "")}
          onChange={onChange}
          placeholder="Select…"
          options={[
            { value: "", label: "Select…" },
            ...field.options.map((option) => ({ value: option, label: option })),
          ]}
        />
      ) : (
        <input
          id={id}
          type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(event) => {
            if (field.type === "number") {
              onChange(event.target.value === "" ? "" : Number(event.target.value));
            } else {
              onChange(event.target.value);
            }
          }}
        />
      )}
    </label>
  );
}

function NewTicketSheet({
  tenantSlug,
  config,
  onClose,
  onCreated,
}: {
  tenantSlug: string;
  config: Config;
  onClose: () => void;
  onCreated: (ticket: Ticket) => void;
}) {
  const formId = useId();
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState(config.categories[0]?.id ?? "");
  const [customFields, setCustomFields] = useState<Record<string, unknown>>({});
  const [route, setRoute] = useState<RoutePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fields = config.custom_fields.filter(
    (field) => field.applies_to_category_id === null || field.applies_to_category_id === categoryId,
  );

  function setField(key: string, value: unknown): void {
    setCustomFields((current) => ({ ...current, [key]: value }));
    setRoute(null);
  }

  async function preview(): Promise<void> {
    setError(null);
    try {
      const selected = config.categories.find((category) => category.id === categoryId);
      const result = await post<RoutePreview>(`/t/${tenantSlug}/routing/preview`, {
        categoryId,
        priorityId:
          selected?.default_priority_id ??
          config.priorities[config.priorities.length - 1]?.id ??
          config.priorities[0]?.id,
        customFields,
      });
      setRoute(result);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const cleanFields: Record<string, unknown> = {};
    for (const field of fields) {
      const value = customFields[field.key];
      if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
      cleanFields[field.key] = value;
    }
    try {
      const ticket = await post<Ticket>(`/t/${tenantSlug}/tickets`, {
        subject,
        description,
        categoryId,
        customFields: cleanFields,
      });
      onCreated(ticket);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      eyebrow="New request"
      title="Open a ticket"
      description="Routing is picked from the category and details, so you land with the right team."
      footer={
        <>
          <button type="button" className="button ghost" onClick={() => void preview()} disabled={busy}>
            Preview routing
          </button>
          <span className="toolbar-spacer" />
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={formId} className="button" disabled={busy}>
            {busy ? "Creating…" : "Create ticket"}
          </button>
        </>
      }
    >
      <form id={formId} className="form-stack" onSubmit={(event) => void submit(event)}>
        <ErrorAlert message={error} />
        <div className="form-grid">
          <label className="span-2">
            Subject
            <input
              data-autofocus
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              maxLength={200}
              placeholder="Short summary of the problem"
              required
            />
          </label>
          <label className="span-2">
            Description
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={5}
              maxLength={20000}
              placeholder="What happened, and what have you already tried?"
              required
            />
          </label>
          <label>
            Category
            <Select
              ariaLabel="Category"
              value={categoryId}
              onChange={(next) => {
                setCategoryId(next);
                setRoute(null);
              }}
              options={config.categories.map((category) => ({ value: category.id, label: category.name }))}
            />
          </label>
          {fields.map((field) => (
            <CustomFieldInput
              key={field.id}
              field={field}
              value={customFields[field.key]}
              onChange={(value) => setField(field.key, value)}
            />
          ))}
        </div>
        {route && (
          <div className="route-preview">
            <strong>{route.teamName}</strong>
            <span>{route.explanation}</span>
          </div>
        )}
      </form>
    </Sheet>
  );
}

export function TicketsPage() {
  const { tenantSlug = "" } = useParams();
  const { memberships } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const role = memberships.find((item) => item.slug === tenantSlug)?.role ?? "employee";

  const [config, setConfig] = useState<Config | null>(null);
  const [data, setData] = useState<TicketList | null>(null);
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [q, setQ] = useState(() => searchParams.get("q")?.trim() ?? "");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(() => searchParams.get("new") === "1");
  const lastUrlQ = useRef(searchParams.get("q")?.trim() ?? "");
  const urlQ = searchParams.get("q")?.trim() ?? "";

  useEffect(() => {
    if (urlQ === lastUrlQ.current) return;
    lastUrlQ.current = urlQ;
    setSearch(urlQ);
    setQ(urlQ);
    setPage(1);
  }, [urlQ]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const nextSearch = search.trim();
      setQ(nextSearch);
      setPage(1);
      const next = new URLSearchParams(searchParams);
      if (nextSearch) next.set("q", nextSearch);
      else next.delete("q");
      if (next.toString() !== searchParams.toString()) {
        lastUrlQ.current = nextSearch;
        setSearchParams(next, { replace: true });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [search, searchParams, setSearchParams]);

  useEffect(() => {
    if (searchParams.get("new") !== "1") return;
    setShowCreate(true);
    const next = new URLSearchParams(searchParams);
    next.delete("new");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    setConfig(null);
    api<Config>(`/t/${tenantSlug}/config`)
      .then(setConfig)
      .catch((caught) => setError(errorMessage(caught)));
  }, [tenantSlug]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: "25" });
    if (status) params.set("status", status);
    if (priority) params.set("priority", priority);
    if (q) params.set("q", q);
    api<TicketList>(`/t/${tenantSlug}/tickets?${params.toString()}`)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
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
  }, [tenantSlug, status, priority, q, page, refresh]);

  const prefix = config?.settings?.ticket_prefix ?? "OPS";
  const priorities = new Map(config?.priorities.map((item) => [item.key, item]) ?? []);
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 25)));

  async function handleExport(): Promise<void> {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (priority) params.set("priority", priority);
      if (q) params.set("q", q);
      const queryStr = params.toString() ? `?${params.toString()}` : "";

      try {
        await downloadFile(`/t/${tenantSlug}/tickets/export${queryStr}`, `tickets-${tenantSlug}.csv`);
      } catch (apiErr) {
        // Fallback: If backend endpoint is unavailable (e.g. before API rebuild),
        // export currently loaded tickets directly so the user is never blocked.
        if (data && data.items.length > 0) {
          const headers = [
            "Ticket Number",
            "Subject",
            "Status",
            "Priority",
            "Category",
            "Requester",
            "Assignee",
            "Team",
            "Updated At",
          ];
          const rows = [headers.join(",")];
          for (const t of data.items) {
            rows.push(
              [
                `"${formatTicketNumber(prefix, t.number)}"`,
                `"${(t.subject || "").replaceAll('"', '""')}"`,
                `"${(t.status_label || "").replaceAll('"', '""')}"`,
                `"${(t.priority_label || "").replaceAll('"', '""')}"`,
                `"${(t.category_name || "").replaceAll('"', '""')}"`,
                `"${(t.requester_name || "").replaceAll('"', '""')}"`,
                `"${(t.assignee_name || "Unassigned").replaceAll('"', '""')}"`,
                `"${(t.team_name || "None").replaceAll('"', '""')}"`,
                `"${formatDate(t.updated_at)}"`,
              ].join(","),
            );
          }
          const dateStr = new Date().toISOString().slice(0, 10);
          triggerDownload(rows.join("\r\n"), `tickets-${tenantSlug}-${dateStr}.csv`);
        } else {
          throw apiErr;
        }
      }
      toast.success("Export prepared", "Preparing ticket CSV for download.");
    } catch (caught) {
      toast.error("Export failed", errorMessage(caught));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="stack-lg">
      <PageHeader
        eyebrow={config?.settings ? `${config.settings.ticket_prefix} workspace` : "Workspace"}
        title="Tickets"
        actions={
          <button className="button" onClick={() => setShowCreate(true)}>
            <Icon name="plus" className="icon-sm" />
            New ticket
          </button>
        }
      >
        <p className="muted">
          {role === "employee"
            ? "Your requests and their progress."
            : "The queue you and your teams are responsible for."}
        </p>
      </PageHeader>

      <ErrorAlert message={error} />

      {showCreate && config && (
        <NewTicketSheet
          tenantSlug={tenantSlug}
          config={config}
          onClose={() => setShowCreate(false)}
          onCreated={(ticket) => {
            setShowCreate(false);
            toast.success("Ticket opened", formatTicketNumber(prefix, ticket.number));
            navigate(`/t/${tenantSlug}/tickets/${ticket.id}`);
          }}
        />
      )}

      <section className="list-panel">
        <div className="toolbar">
          <input
            placeholder="Search tickets"
            aria-label="Search tickets"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                setPage(1);
                setQ(search.trim());
              }
            }}
          />
          <Select
            ariaLabel="Filter by status"
            value={status}
            onChange={(next) => {
              setStatus(next);
              setPage(1);
            }}
            options={[
              { value: "", label: "All statuses" },
              ...(config?.statuses.map((item) => ({ value: item.key, label: item.label })) ?? []),
            ]}
          />
          <Select
            ariaLabel="Filter by priority"
            value={priority}
            onChange={(next) => {
              setPriority(next);
              setPage(1);
            }}
            options={[
              { value: "", label: "All priorities" },
              ...(config?.priorities.map((item) => ({ value: item.key, label: item.label })) ?? []),
            ]}
          />
          <button
            className="button secondary"
            onClick={() => {
              setPage(1);
              setQ(search.trim());
            }}
          >
            Search
          </button>
          {(status || priority || q || search) && (
            <button
              className="button ghost"
              onClick={() => {
                setStatus("");
                setPriority("");
                setSearch("");
                setQ("");
                setPage(1);
              }}
            >
              Clear
            </button>
          )}
          <span className="toolbar-spacer" />
          {role !== "employee" && (
            <button
              type="button"
              className="button secondary"
              onClick={() => void handleExport()}
              disabled={exporting}
              aria-label="Export tickets to CSV"
              title="Export filtered tickets to CSV"
            >
              <Icon name="download" className="icon-sm" />
              {exporting ? "Exporting…" : "Export CSV"}
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="Refresh tickets"
            title="Refresh"
            onClick={() => setRefresh((value) => value + 1)}
          >
            <Icon name="refresh" />
          </button>
        </div>

        {loading && !data ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Subject</th>
                  <th className="col-status">Status</th>
                  <th className="col-priority">Priority</th>
                  <th className="col-requester">Requester</th>
                  <th className="col-owner">Owner</th>
                  <th className="col-sla">SLA</th>
                  <th className="col-updated">Updated</th>
                </tr>
              </thead>
              <tbody>
                <SkeletonRows cols={8} />
              </tbody>
            </table>
          </div>
        ) : data && data.items.length === 0 ? (
          <EmptyState title="No tickets match">
            {role === "employee" ? "Open a ticket when you need help." : "Try clearing the filters."}
          </EmptyState>
        ) : (
          <div className={`table-wrap${loading ? " is-refreshing" : ""}`.trim()}>
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Subject</th>
                  <th className="col-status">Status</th>
                  <th className="col-priority">Priority</th>
                  <th className="col-requester">Requester</th>
                  <th className="col-owner">Owner</th>
                  <th className="col-sla">SLA</th>
                  <th className="col-updated">Updated</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((ticket) => {
                  const priorityMeta = priorities.get(ticket.priority_key);
                  const isMerged = Boolean(ticket.merged_into_ticket_id);
                  const isClosed = ticket.status_stage === "closed" || isMerged;
                  const slaBreached = Boolean(ticket.sla_resolution_breached_at || ticket.sla_response_breached_at);
                  const slaPaused = Boolean(ticket.sla_paused_at);
                  const slaWarning = Boolean(
                    ticket.sla_response_warning_at ||
                    ticket.sla_resolution_warning_at ||
                    clockAtRisk(ticket.sla_response_warn_due_at, ticket.sla_response_due_at, ticket.created_at) ||
                    clockAtRisk(ticket.sla_resolution_warn_due_at, ticket.sla_resolution_due_at, ticket.created_at),
                  );
                  const slaDue = ticket.sla_resolution_due_at;
                  const slaStopped = ticket.resolved_at ?? ticket.closed_at;
                  return (
                    <tr key={ticket.id}>
                      <td className="mono nowrap">
                        <Link to={`/t/${tenantSlug}/tickets/${ticket.id}`}>
                          {formatTicketNumber(prefix, ticket.number)}
                        </Link>
                      </td>
                      <td className="col-subject">
                        <Link className="subject-link" to={`/t/${tenantSlug}/tickets/${ticket.id}`}>
                          {ticket.subject}
                        </Link>
                        <div className="muted small">
                          {ticket.category_name}
                          {ticket.team_name ? ` · ${ticket.team_name}` : ""}
                        </div>
                        <div className="ticket-mobile-meta">
                          <StatusBadge label={ticket.status_label} stage={ticket.status_stage} />
                          <PriorityBadge
                            label={priorityMeta?.label ?? ticket.priority_label}
                            color={priorityMeta?.color}
                          />
                        </div>
                      </td>
                      <td className="col-status">
                        <StatusBadge label={ticket.status_label} stage={ticket.status_stage} />
                      </td>
                      <td className="col-priority">
                        <PriorityBadge label={priorityMeta?.label ?? ticket.priority_label} color={priorityMeta?.color} />
                      </td>
                      <td className="col-requester">{ticket.requester_name}</td>
                      <td className="col-owner">{ticket.assignee_name ?? "Unassigned"}</td>
                      <td className="col-sla nowrap">
                        {isClosed ? (
                          slaBreached ? (
                            <SlaBadge label="Breached" state="historical" />
                          ) : isMerged ? (
                            <SlaBadge label="Merged" state="historical" />
                          ) : slaDue ? (
                            <SlaBadge label="Met" state="met" />
                          ) : (
                            <span className="muted small">-</span>
                          )
                        ) : slaStopped ? (
                          slaBreached ? (
                            <SlaBadge label="Breached" state="breached" />
                          ) : slaDue ? (
                            <SlaBadge label="Met" state="met" />
                          ) : (
                            <span className="muted small">-</span>
                          )
                        ) : slaBreached ? (
                          <SlaBadge label="Breached" state="breached" />
                        ) : slaPaused ? (
                          <SlaBadge label="Paused" state="paused" />
                        ) : slaWarning ? (
                          <SlaBadge label="At risk" state="warning" />
                        ) : slaDue ? (
                          <SlaBadge
                            label={formatDate(slaDue)}
                            state={new Date(slaDue).getTime() < Date.now() ? "overdue" : "active"}
                          />
                        ) : (
                          <span className="muted small">-</span>
                        )}
                      </td>
                      <td className="col-updated nowrap muted">{formatDate(ticket.updated_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {data && (
          <div className="list-foot">
            <span className="muted small">
              {data.total} ticket{data.total === 1 ? "" : "s"}
            </span>
            <Pager page={page} totalPages={totalPages} onChange={setPage} />
          </div>
        )}
      </section>
    </div>
  );
}
