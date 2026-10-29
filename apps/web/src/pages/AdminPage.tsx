import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { api, del, errorMessage, humanize, patch, post, put } from "../api.js";
import { useAuth } from "../auth.js";
import { EmptyState, ErrorAlert, PageHeader, PageSkeleton } from "../components.js";
import { Select, useConfirm, useToast } from "../ui.js";
import type {
  Category,
  Config,
  CustomField,
  NotificationTemplate,
  Priority,
  RoutingRule,
  SlaPolicy,
  Team,
} from "../types.js";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

function fieldKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
}

export function AdminPage() {
  const { tenantSlug = "" } = useParams();
  const { memberships } = useAuth();
  const membership = memberships.find((item) => item.slug === tenantSlug);
  const canManage = membership?.permissions.includes("config.manage") ?? false;
  const confirm = useConfirm();
  const toast = useToast();
  const [config, setConfig] = useState<Config | null>(null);
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const [teamName, setTeamName] = useState("");
  const [teamSlug, setTeamSlug] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [categorySlug, setCategorySlug] = useState("");
  const [categoryTeam, setCategoryTeam] = useState("");
  const [priorityLabel, setPriorityLabel] = useState("");
  const [priorityKey, setPriorityKey] = useState("");
  const [priorityRank, setPriorityRank] = useState("5");
  const [priorityColor, setPriorityColor] = useState("gray");
  const [slaName, setSlaName] = useState("");
  const [slaPriority, setSlaPriority] = useState("");
  const [slaCategory, setSlaCategory] = useState("");
  const [slaResponse, setSlaResponse] = useState("60");
  const [slaResolution, setSlaResolution] = useState("480");

  const [fieldLabel, setFieldLabel] = useState("");
  const [fieldKeyValue, setFieldKeyValue] = useState("");
  const [fieldType, setFieldType] = useState("text");
  const [fieldVisibility, setFieldVisibility] = useState("internal");
  const [fieldRequired, setFieldRequired] = useState(false);
  const [fieldOptions, setFieldOptions] = useState("");
  const [fieldCategory, setFieldCategory] = useState("");

  const [ruleName, setRuleName] = useState("");
  const [ruleCategory, setRuleCategory] = useState("");
  const [ruleTeam, setRuleTeam] = useState("");

  const [editingTeamId, setEditingTeamId] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState("");
  const [editingPriorityId, setEditingPriorityId] = useState("");
  const [editingFieldId, setEditingFieldId] = useState("");
  const [editingRuleId, setEditingRuleId] = useState("");
  const [editingSlaId, setEditingSlaId] = useState("");

  const [settingsTimezone, setSettingsTimezone] = useState("UTC");
  const [settingsPrefix, setSettingsPrefix] = useState("OPS");
  const [settingsReopenDays, setSettingsReopenDays] = useState("14");
  const [settingsAutoCloseDays, setSettingsAutoCloseDays] = useState("7");

  useEffect(() => {
    let cancelled = false;
    api<Config>(`/t/${tenantSlug}/config`)
      .then((next) => {
        if (cancelled) return;
        setConfig(next);
        setCategoryTeam(next.teams.find((team) => team.slug === "service-desk")?.id ?? next.teams[0]?.id ?? "");
        setRuleCategory(next.categories[0]?.id ?? "");
        setRuleTeam(next.teams[0]?.id ?? "");
        setSlaPriority(next.priorities[0]?.id ?? "");
        setSettingsTimezone(next.settings?.timezone ?? "UTC");
        setSettingsPrefix(next.settings?.ticket_prefix ?? "OPS");
        setSettingsReopenDays(String(next.settings?.reopen_window_days ?? 14));
        setSettingsAutoCloseDays(String(next.settings?.auto_close_days ?? 7));
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [tenantSlug, refresh]);

  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    api<{ items: NotificationTemplate[] }>(`/t/${tenantSlug}/notification-templates`)
      .then((next) => {
        if (!cancelled) setTemplates(next.items);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [canManage, tenantSlug, refresh]);

  if (!canManage) {
    return (
      <div className="card narrow">
        <h1>Admins only</h1>
        <p className="muted">You do not have permission to configure this workspace.</p>
      </div>
    );
  }

  if (!config) return <PageSkeleton rows={5} cols={4} label="Loading configuration" />;

  async function run(action: () => Promise<unknown>, message: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      toast.success(message);
      setRefresh((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function submitTeam(event: FormEvent): void {
    event.preventDefault();
    const body = { name: teamName, slug: teamSlug || slugify(teamName) };
    void run(
      () => (editingTeamId ? patch(`/t/${tenantSlug}/teams/${editingTeamId}`, body) : post(`/t/${tenantSlug}/teams`, body)),
      editingTeamId ? "Team updated." : "Team created.",
    ).then(() => {
      setTeamName("");
      setTeamSlug("");
      setEditingTeamId("");
    });
  }

  function submitCategory(event: FormEvent): void {
    event.preventDefault();
    const body = {
      name: categoryName,
      slug: categorySlug || slugify(categoryName),
      defaultTeamId: categoryTeam || null,
    };
    void run(
      () =>
        editingCategoryId
          ? patch(`/t/${tenantSlug}/categories/${editingCategoryId}`, body)
          : post(`/t/${tenantSlug}/categories`, body),
      editingCategoryId ? "Category updated." : "Category created.",
    ).then(() => {
      setCategoryName("");
      setCategorySlug("");
      setEditingCategoryId("");
    });
  }

  function submitPriority(event: FormEvent): void {
    event.preventDefault();
    const body = {
      key: priorityKey || slugify(priorityLabel),
      label: priorityLabel,
      rank: Number(priorityRank),
      color: priorityColor,
    };
    void run(
      () =>
        editingPriorityId
          ? patch(`/t/${tenantSlug}/priorities/${editingPriorityId}`, body)
          : post(`/t/${tenantSlug}/priorities`, body),
      editingPriorityId ? "Priority updated." : "Priority created.",
    ).then(() => {
      setPriorityLabel("");
      setPriorityKey("");
      setEditingPriorityId("");
    });
  }

  function submitSla(event: FormEvent): void {
    event.preventDefault();
    const body = {
      name: slaName,
      priorityId: slaPriority || null,
      categoryId: slaCategory || null,
      responseMinutes: Number(slaResponse),
      resolutionMinutes: Number(slaResolution),
    };
    void run(
      () =>
        editingSlaId
          ? patch(`/t/${tenantSlug}/sla-policies/${editingSlaId}`, body)
          : post(`/t/${tenantSlug}/sla-policies`, body),
      editingSlaId ? "SLA policy updated." : "SLA policy created.",
    ).then(() => {
      setSlaName("");
      setEditingSlaId("");
    });
  }

  function submitField(event: FormEvent): void {
    event.preventDefault();
    const options = fieldOptions
      .split(",")
      .map((option) => option.trim())
      .filter(Boolean);
    const body = {
      label: fieldLabel,
      type: fieldType,
      required: fieldRequired,
      visibility: fieldVisibility,
      options,
      appliesToCategoryId: fieldCategory || null,
      sortOrder: 100,
    };
    void run(
      () =>
        editingFieldId
          ? patch(`/t/${tenantSlug}/custom-fields/${editingFieldId}`, body)
          : post(`/t/${tenantSlug}/custom-fields`, {
              ...body,
              key: fieldKeyValue || fieldKey(fieldLabel),
            }),
      editingFieldId ? "Custom field updated." : "Custom field created.",
    ).then(() => {
      setFieldLabel("");
      setFieldKeyValue("");
      setFieldOptions("");
      setFieldRequired(false);
      setEditingFieldId("");
    });
  }

  function submitRule(event: FormEvent): void {
    event.preventDefault();
    void run(
      () =>
        editingRuleId
          ? patch(`/t/${tenantSlug}/routing-rules/${editingRuleId}`, {
              name: ruleName,
              teamId: ruleTeam,
            })
          : post(`/t/${tenantSlug}/routing-rules`, {
              name: ruleName,
              teamId: ruleTeam,
              sortOrder: 0,
              conditions: {
                all: [{ field: "category_id", op: "eq", value: ruleCategory }],
              },
            }),
      editingRuleId ? "Routing rule updated." : "Routing rule created.",
    ).then(() => {
      setRuleName("");
      setEditingRuleId("");
    });
  }

  function submitSettings(event: FormEvent): void {
    event.preventDefault();
    void run(
      () =>
        patch(`/t/${tenantSlug}/settings`, {
          timezone: settingsTimezone,
          ticketPrefix: settingsPrefix,
          reopenWindowDays: Number(settingsReopenDays),
          autoCloseDays: Number(settingsAutoCloseDays),
        }),
      "Workspace settings updated.",
    );
  }

  function deactivate(path: string, label: string): void {
    void confirm({
      title: `Deactivate ${label}?`,
      body: "Existing tickets keep their history, but this option will no longer be offered on new work.",
      confirmLabel: "Deactivate",
      tone: "danger",
    }).then((confirmed) => {
      if (confirmed) void run(() => del(path), `${label} deactivated.`);
    });
  }

  function editTeam(team: Team): void {
    setEditingTeamId(team.id);
    setTeamName(team.name);
    setTeamSlug(team.slug);
  }

  function editCategory(category: Category): void {
    setEditingCategoryId(category.id);
    setCategoryName(category.name);
    setCategorySlug(category.slug);
    setCategoryTeam(category.default_team_id ?? "");
  }

  function editPriority(priority: Priority): void {
    setEditingPriorityId(priority.id);
    setPriorityLabel(priority.label);
    setPriorityKey(priority.key);
    setPriorityRank(String(priority.rank));
    setPriorityColor(priority.color);
  }

  function editField(field: CustomField): void {
    setEditingFieldId(field.id);
    setFieldLabel(field.label);
    setFieldKeyValue(field.key);
    setFieldType(field.type);
    setFieldVisibility(field.visibility);
    setFieldRequired(field.required);
    setFieldOptions(field.options.join(", "));
    setFieldCategory(field.applies_to_category_id ?? "");
  }

  function editRule(rule: RoutingRule): void {
    setEditingRuleId(rule.id);
    setRuleName(rule.name);
    setRuleTeam(rule.team_id);
  }

  function editSla(policy: SlaPolicy): void {
    setEditingSlaId(policy.id);
    setSlaName(policy.name);
    setSlaPriority(policy.priority_id ?? "");
    setSlaCategory(policy.category_id ?? "");
    setSlaResponse(String(policy.response_minutes));
    setSlaResolution(String(policy.resolution_minutes));
  }

  const teamNameById = new Map(config.teams.map((team) => [team.id, team.name]));
  const priorityNameById = new Map(config.priorities.map((priority) => [priority.id, priority.label]));
  const categoryNameById = new Map(config.categories.map((category) => [category.id, category.name]));

  return (
    <div className="stack-lg">
      <PageHeader eyebrow="Tenant administration" title="Workspace configuration">
        <p className="muted">
          Configuration version {config.settings?.config_version ?? 1}. Changes are audited and scoped to this tenant.
        </p>
      </PageHeader>

      <ErrorAlert message={error} />

      <section className="card">
        <h2>Workspace settings</h2>
        <form className="form-grid" onSubmit={submitSettings}>
          <label>
            Timezone
            <input value={settingsTimezone} onChange={(event) => setSettingsTimezone(event.target.value)} required />
          </label>
          <label>
            Ticket prefix
            <input
              value={settingsPrefix}
              onChange={(event) => setSettingsPrefix(event.target.value.toUpperCase())}
              maxLength={10}
              required
            />
          </label>
          <label>
            Reopen window (days)
            <input
              type="number"
              min={0}
              value={settingsReopenDays}
              onChange={(event) => setSettingsReopenDays(event.target.value)}
              required
            />
          </label>
          <label>
            Auto-close after (days)
            <input
              type="number"
              min={0}
              value={settingsAutoCloseDays}
              onChange={(event) => setSettingsAutoCloseDays(event.target.value)}
              required
            />
          </label>
          <div className="form-actions span-2">
            <button className="button secondary" disabled={busy}>
              Save settings
            </button>
          </div>
        </form>
      </section>

      <div className="admin-columns">
        <div className="admin-col">
          <section className="card">
            <h2>{editingTeamId ? "Edit team" : "Add a team"}</h2>
            <form className="form-grid" onSubmit={submitTeam}>
              <label>
                Name
                <input
                  value={teamName}
                  onChange={(event) => {
                    setTeamName(event.target.value);
                    setTeamSlug(slugify(event.target.value));
                  }}
                  required
                />
              </label>
              <label>
                Slug
                <input value={teamSlug} onChange={(event) => setTeamSlug(event.target.value)} required />
              </label>
              <div className="form-actions span-2">
                <button className="button secondary" disabled={busy}>
                  {editingTeamId ? "Update team" : "Create team"}
                </button>
                {editingTeamId && (
                  <button type="button" className="button ghost" onClick={() => { setEditingTeamId(""); setTeamName(""); setTeamSlug(""); }}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          </section>

          <section className="card">
            <h2>{editingPriorityId ? "Edit priority" : "Add a priority"}</h2>
            <form className="form-grid" onSubmit={submitPriority}>
              <label className="span-2">
                Label
                <input
                  value={priorityLabel}
                  onChange={(event) => {
                    setPriorityLabel(event.target.value);
                    setPriorityKey(slugify(event.target.value));
                  }}
                  required
                />
              </label>
              <div className="inline-fields span-2">
                <label>
                  Key
                  <input value={priorityKey} onChange={(event) => setPriorityKey(event.target.value)} required />
                </label>
                <label>
                  Rank
                  <input
                    type="number"
                    min={1}
                    value={priorityRank}
                    onChange={(event) => setPriorityRank(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Color
                  <Select
                    ariaLabel="Color"
                    value={priorityColor}
                    onChange={setPriorityColor}
                    options={[
                      { value: "red", label: "Red" },
                      { value: "orange", label: "Orange" },
                      { value: "blue", label: "Blue" },
                      { value: "green", label: "Green" },
                      { value: "gray", label: "Gray" },
                    ]}
                  />
                </label>
              </div>
              <div className="form-actions span-2">
                <button className="button secondary" disabled={busy}>
                  {editingPriorityId ? "Update priority" : "Create priority"}
                </button>
                {editingPriorityId && (
                  <button type="button" className="button ghost" onClick={() => { setEditingPriorityId(""); setPriorityLabel(""); setPriorityKey(""); }}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          </section>

          <section className="card">
            <h2>{editingFieldId ? "Edit custom field" : "Add a custom field"}</h2>
            <form className="form-grid" onSubmit={submitField}>
              <label>
                Label
                <input
                  value={fieldLabel}
                  onChange={(event) => {
                    setFieldLabel(event.target.value);
                    setFieldKeyValue(fieldKey(event.target.value));
                  }}
                  required
                />
              </label>
              <label>
                Key
                <input value={fieldKeyValue} onChange={(event) => setFieldKeyValue(event.target.value)} required />
              </label>
              <div className="inline-fields span-2">
                <label>
                  Type
                  <Select
                    ariaLabel="Custom field type"
                    value={fieldType}
                    onChange={setFieldType}
                    options={["text", "textarea", "number", "date", "select", "multiselect", "checkbox"].map((type) => ({
                      value: type,
                      label: humanize(type),
                    }))}
                  />
                </label>
                <label>
                  Visibility
                  <Select
                    ariaLabel="Custom field visibility"
                    value={fieldVisibility}
                    onChange={setFieldVisibility}
                    options={[
                      { value: "internal", label: "Internal" },
                      { value: "public", label: "Public" },
                    ]}
                  />
                </label>
              </div>
              {(fieldType === "select" || fieldType === "multiselect") && (
                <label className="span-2">
                  Options (comma separated)
                  <input value={fieldOptions} onChange={(event) => setFieldOptions(event.target.value)} required />
                </label>
              )}
              <label className="span-2">
                Applies to category
                <Select
                  ariaLabel="Applies to category"
                  value={fieldCategory}
                  onChange={setFieldCategory}
                  options={[
                    { value: "", label: "All categories" },
                    ...config.categories.map((category) => ({ value: category.id, label: category.name })),
                  ]}
                />
              </label>
              <label className="check-row span-2">
                <input type="checkbox" checked={fieldRequired} onChange={(event) => setFieldRequired(event.target.checked)} />
                Required
              </label>
              <div className="form-actions span-2">
                <button className="button secondary" disabled={busy}>
                  {editingFieldId ? "Update field" : "Create field"}
                </button>
                {editingFieldId && (
                  <button type="button" className="button ghost" onClick={() => { setEditingFieldId(""); setFieldLabel(""); setFieldKeyValue(""); setFieldOptions(""); }}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          </section>
        </div>
        <div className="admin-col">
          <section className="card">
            <h2>{editingCategoryId ? "Edit category" : "Add a category"}</h2>
            <form className="form-grid" onSubmit={submitCategory}>
              <label>
                Name
                <input
                  value={categoryName}
                  onChange={(event) => {
                    setCategoryName(event.target.value);
                    setCategorySlug(slugify(event.target.value));
                  }}
                  required
                />
              </label>
              <label>
                Slug
                <input value={categorySlug} onChange={(event) => setCategorySlug(event.target.value)} required />
              </label>
              <label className="span-2">
                Default team
                <Select
                  ariaLabel="Default team"
                  value={categoryTeam}
                  onChange={setCategoryTeam}
                  options={config.teams.map((team) => ({ value: team.id, label: team.name }))}
                />
              </label>
              <div className="form-actions span-2">
                <button className="button secondary" disabled={busy}>
                  {editingCategoryId ? "Update category" : "Create category"}
                </button>
                {editingCategoryId && (
                  <button type="button" className="button ghost" onClick={() => { setEditingCategoryId(""); setCategoryName(""); setCategorySlug(""); }}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          </section>

          <section className="card">
            <h2>{editingSlaId ? "Edit SLA policy" : "Add an SLA policy"}</h2>
            <form className="form-grid" onSubmit={submitSla}>
              <label className="span-2">
                Name
                <input value={slaName} onChange={(event) => setSlaName(event.target.value)} required />
              </label>
              <div className="inline-fields span-2">
                <label>
                  Priority
                  <Select
                    ariaLabel="SLA priority"
                    value={slaPriority}
                    onChange={setSlaPriority}
                    options={[
                      { value: "", label: "All priorities" },
                      ...config.priorities.map((priority) => ({ value: priority.id, label: priority.label })),
                    ]}
                  />
                </label>
                <label>
                  Category
                  <Select
                    ariaLabel="SLA category"
                    value={slaCategory}
                    onChange={setSlaCategory}
                    options={[
                      { value: "", label: "All categories" },
                      ...config.categories.map((category) => ({ value: category.id, label: category.name })),
                    ]}
                  />
                </label>
              </div>
              <div className="inline-fields span-2">
                <label>
                  Response minutes
                  <input
                    type="number"
                    min={1}
                    value={slaResponse}
                    onChange={(event) => setSlaResponse(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Resolution minutes
                  <input
                    type="number"
                    min={1}
                    value={slaResolution}
                    onChange={(event) => setSlaResolution(event.target.value)}
                    required
                  />
                </label>
              </div>
              <div className="form-actions span-2">
                <button className="button secondary" disabled={busy}>
                  {editingSlaId ? "Update SLA policy" : "Create SLA policy"}
                </button>
                {editingSlaId && (
                  <button type="button" className="button ghost" onClick={() => { setEditingSlaId(""); setSlaName(""); }}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          </section>

          <section className="card">
            <h2>{editingRuleId ? "Edit routing rule" : "Add a routing rule"}</h2>
            <p className="muted">
              Rules run before the category default, and the newest rule wins when two rules are equally specific. This
              builder creates a single category condition; the API accepts combined priority and custom-field conditions
              too.
            </p>
            <form className="form-grid" onSubmit={submitRule}>
              <label className="span-2">
                Rule name
                <input value={ruleName} onChange={(event) => setRuleName(event.target.value)} required />
              </label>
              <label>
                When category is
                <Select
                  ariaLabel="When category is"
                  value={ruleCategory}
                  onChange={setRuleCategory}
                  options={config.categories.map((category) => ({ value: category.id, label: category.name }))}
                />
              </label>
              <label>
                Route to
                <Select
                  ariaLabel="Route to"
                  value={ruleTeam}
                  onChange={setRuleTeam}
                  options={config.teams.map((team) => ({ value: team.id, label: team.name }))}
                />
              </label>
              <div className="form-actions span-2">
                <button className="button secondary" disabled={busy}>
                  {editingRuleId ? "Update rule" : "Create rule"}
                </button>
                {editingRuleId && (
                  <button type="button" className="button ghost" onClick={() => { setEditingRuleId(""); setRuleName(""); }}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          </section>
        </div>
      </div>

      <div className="admin-columns">
        <div className="admin-col">
          <section className="card">
            <h2>Teams</h2>
            {config.teams.length === 0 ? (
              <EmptyState title="No teams" />
            ) : (
              <ul className="config-list">
                {config.teams.map((team) => (
                  <li key={team.id}>
                    <div>
                      <strong>{team.name}</strong>
                      <span className="muted small">{team.slug}</span>
                    </div>
                    <ConfigActions
                      onEdit={() => editTeam(team)}
                      onRemove={() => deactivate(`/t/${tenantSlug}/teams/${team.id}`, team.name)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h2>Categories</h2>
            <ul className="config-list">
              {config.categories.map((category) => (
                <li key={category.id}>
                  <div>
                    <strong>{category.name}</strong>
                    <span className="muted small">
                      {category.default_team_id ? teamNameById.get(category.default_team_id) : "No default team"}
                    </span>
                  </div>
                  <ConfigActions
                    onEdit={() => editCategory(category)}
                    onRemove={() => deactivate(`/t/${tenantSlug}/categories/${category.id}`, category.name)}
                  />
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>Priorities</h2>
            <ul className="config-list">
              {config.priorities.map((priority) => (
                <li key={priority.id}>
                  <div>
                    <strong>{priority.label}</strong>
                    <span className="muted small">rank {priority.rank}</span>
                  </div>
                  <ConfigActions
                    onEdit={() => editPriority(priority)}
                    onRemove={() => deactivate(`/t/${tenantSlug}/priorities/${priority.id}`, priority.label)}
                  />
                </li>
              ))}
            </ul>
          </section>
        </div>
        <div className="admin-col">
          <section className="card">
            <h2>SLA policies</h2>
            {config.sla_policies.length === 0 ? (
              <EmptyState title="No SLA policies">Create one to add response and resolution targets.</EmptyState>
            ) : (
              <ul className="config-list">
                {config.sla_policies.map((policy) => (
                  <li key={policy.id}>
                    <div>
                      <strong>{policy.name}</strong>
                      <span className="muted small">
                        {policy.priority_id ? priorityNameById.get(policy.priority_id) : "Any priority"} ·{" "}
                        {policy.category_id ? categoryNameById.get(policy.category_id) : "Any category"} ·{" "}
                        {policy.response_minutes}m / {policy.resolution_minutes}m
                      </span>
                    </div>
                    <ConfigActions
                      onEdit={() => editSla(policy)}
                      onRemove={() => deactivate(`/t/${tenantSlug}/sla-policies/${policy.id}`, policy.name)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h2>Custom fields</h2>
            <ul className="config-list">
              {config.custom_fields.map((field) => (
                <li key={field.id}>
                  <div>
                    <strong>{field.label}</strong>
                    <span className="muted small">
                      {field.type} · {field.visibility}
                      {field.required ? " · required" : ""}
                    </span>
                  </div>
                  <ConfigActions
                    onEdit={() => editField(field)}
                    onRemove={() => deactivate(`/t/${tenantSlug}/custom-fields/${field.id}`, field.label)}
                  />
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>Routing rules</h2>
            {config.routing_rules.length === 0 ? (
              <EmptyState title="No routing rules">Tickets fall back to the category default team.</EmptyState>
            ) : (
              <ul className="config-list">
                {config.routing_rules.map((rule) => (
                  <li key={rule.id}>
                    <div>
                      <strong>{rule.name}</strong>
                      <span className="muted small">→ {teamNameById.get(rule.team_id) ?? "Unknown team"}</span>
                    </div>
                    <ConfigActions
                      onEdit={() => editRule(rule)}
                      onRemove={() => deactivate(`/t/${tenantSlug}/routing-rules/${rule.id}`, rule.name)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <section className="card">
        <h2>Notification templates</h2>
        <p className="muted">
          Placeholders use <code>{"{{name}}"}</code> syntax. Notifications are queued for the worker and sent when SMTP is
          configured.
        </p>
        <div className="stack">
          {templates.map((template) => (
            <TemplateEditor
              key={template.id}
              tenantSlug={tenantSlug}
              template={template}
              onSaved={() => setRefresh((value) => value + 1)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function ConfigActions({ onEdit, onRemove }: { onEdit: () => void; onRemove: () => void }) {
  return (
    <div className="config-actions">
      <button type="button" className="button ghost small" onClick={onEdit}>
        Edit
      </button>
      <button type="button" className="button ghost small" onClick={onRemove}>
        Deactivate
      </button>
    </div>
  );
}

function TemplateEditor({
  tenantSlug,
  template,
  onSaved,
}: {
  tenantSlug: string;
  template: NotificationTemplate;
  onSaved: () => void;
}) {
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [active, setActive] = useState(template.is_active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await put(`/t/${tenantSlug}/notification-templates/${template.id}`, {
        subject,
        body,
        isActive: active,
      });
      setSaved(true);
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="template-editor" onSubmit={(event) => void save(event)}>
      <div className="template-editor-head">
        <strong>{humanize(template.key)}</strong>
        <label className="check-row">
          <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
          Active
        </label>
      </div>
      <label>
        Subject
        <input value={subject} onChange={(event) => setSubject(event.target.value)} required maxLength={300} />
      </label>
      <label>
        Body
        <textarea value={body} onChange={(event) => setBody(event.target.value)} required rows={5} />
      </label>
      <div className="inline-fields">
        <button className="button secondary" disabled={busy}>
          {busy ? "Saving…" : "Save template"}
        </button>
        {saved && <span className="muted small">Saved</span>}
        {error && <span className="error-text small">{error}</span>}
      </div>
    </form>
  );
}
