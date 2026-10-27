import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { formatTicketNumber } from "@opspilot/core";
import { api, errorMessage, formatDate, post } from "../api.js";
import { useAuth } from "../auth.js";
import { EmptyState, ErrorAlert, PageHeader, PriorityBadge, SlaBadge, StatusBadge } from "../components.js";
import { Select, useToast } from "../ui.js";
import type { Config, CustomField, Ticket, TicketList } from "../types.js";

type RoutePreview = { teamName: string; explanation: string };

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

function CreateTicketForm({
  tenantSlug,
  config,
  onCreated,
}: {
  tenantSlug: string;
  config: Config;
  onCreated: (ticket: Ticket) => void;
}) {
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState(config.categories[0]?.id ?? "");
  const [priorityId, setPriorityId] = useState(config.priorities[0]?.id ?? "");
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
      const result = await post<RoutePreview>(`/t/${tenantSlug}/routing/preview`, {
        categoryId,
        priorityId,
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
        priorityId,
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
    <form className="card form-card" onSubmit={(event) => void submit(event)}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">New request</p>
          <h2>Open a ticket</h2>
        </div>
      </div>
      <ErrorAlert message={error} />
      <div className="form-grid">
        <label className="span-2">
          Subject
          <input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} required />
        </label>
        <label className="span-2">
          Description
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={5}
            maxLength={20000}
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
        <label>
          Priority
          <Select
            ariaLabel="Priority"
            value={priorityId}
            onChange={(next) => {
              setPriorityId(next);
              setRoute(null);
            }}
            options={config.priorities.map((priority) => ({ value: priority.id, label: priority.label }))}
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

      <div className="form-footer">
        <button type="button" className="button secondary" onClick={() => void preview()}>
          Preview routing
        </button>
        <button type="submit" className="button" disabled={busy}>
          {busy ? "Creating…" : "Create ticket"}
        </button>
      </div>
      {route && (
        <div className="route-preview">
          <strong>{route.teamName}</strong>
          <span>{route.explanation}</span>
        </div>
      )}
    </form>
  );
}

export function TicketsPage() {
  const { tenantSlug = "" } = useParams();
  const { memberships } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const role = memberships.find((item) => item.slug === tenantSlug)?.role ?? "employee";

  const [config, setConfig] = useState<Config | null>(null);
  const [data, setData] = useState<TicketList | null>(null);
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

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

  return (
    <div className="stack-lg">
      <PageHeader
        eyebrow={config?.settings ? `${config.settings.ticket_prefix} workspace` : "Workspace"}
        title="Tickets"
        actions={
          <button className="button" onClick={() => setShowCreate((current) => !current)}>
            {showCreate ? "Close form" : "New ticket"}
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
        <CreateTicketForm
          tenantSlug={tenantSlug}
          config={config}
          onCreated={(ticket) => {
            toast.success("Ticket opened", formatTicketNumber(prefix, ticket.number));
            navigate(`/t/${tenantSlug}/tickets/${ticket.id}`);
          }}
        />
      )}

      <section className="card">
        <div className="filter-bar">
          <input
            placeholder="Search tickets"
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
          {(status || priority || q) && (
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
        </div>

        {loading && !data ? (
          <EmptyState title="Loading tickets…" />
        ) : data && data.items.length === 0 ? (
          <EmptyState title="No tickets match">
            {role === "employee" ? "Open a ticket when you need help." : "Try clearing the filters."}
          </EmptyState>
        ) : (
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
                {data?.items.map((ticket) => {
                  const priorityMeta = priorities.get(ticket.priority_key);
                  const slaBreached = Boolean(ticket.sla_resolution_breached_at || ticket.sla_response_breached_at);
                  const slaPaused = Boolean(ticket.sla_paused_at);
                  const slaDue = ticket.sla_resolution_due_at;
                  return (
                    <tr key={ticket.id}>
                      <td className="mono nowrap">
                        <Link to={`/t/${tenantSlug}/tickets/${ticket.id}`}>
                          {formatTicketNumber(prefix, ticket.number)}
                        </Link>
                      </td>
                      <td>
                        <Link className="subject-link" to={`/t/${tenantSlug}/tickets/${ticket.id}`}>
                          {ticket.subject}
                        </Link>
                        <div className="muted small">
                          {ticket.category_name}
                          {ticket.team_name ? ` · ${ticket.team_name}` : ""}
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
                        {slaBreached ? (
                          <SlaBadge label="Breached" state="breached" />
                        ) : slaPaused ? (
                          <SlaBadge label="Paused" state="paused" />
                        ) : slaDue ? (
                          <SlaBadge
                            label={formatDate(slaDue)}
                            state={new Date(slaDue).getTime() < Date.now() ? "overdue" : "active"}
                          />
                        ) : (
                          <span className="muted small">–</span>
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
          <div className="pagination">
            <span className="muted small">
              {data.total} ticket{data.total === 1 ? "" : "s"}
            </span>
            <div className="pagination-actions">
              <button
                className="button ghost small"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </button>
              <span className="muted small">
                Page {page} of {totalPages}
              </span>
              <button
                className="button ghost small"
                disabled={page >= totalPages}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </button>
              <button className="button ghost small" onClick={() => setRefresh((value) => value + 1)}>
                Refresh
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
