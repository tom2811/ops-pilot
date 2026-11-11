import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { PERMISSION_KEYS, type Permission } from "@opspilot/core";
import { api, del, errorMessage, humanize, patch, post } from "../api.js";
import { useAuth } from "../auth.js";
import { EmptyState, ErrorAlert, PageHeader, PageSkeleton, RoleBadge } from "../components.js";
import { Select, Sheet, useConfirm, useToast } from "../ui.js";
import type {
  Config,
  CustomRole,
  PendingInvitation,
  Role,
  Team,
  TenantUser,
} from "../types.js";

type UsersResponse = { users: TenantUser[]; invitations: PendingInvitation[]; custom_roles: CustomRole[] };

type Draft = {
  role: Role;
  isActive: boolean;
  teamIds: string[];
  customRoleId: string | null;
  managerUserId: string | null;
};

const ROLES: Role[] = ["tenant_admin", "agent", "employee"];

const PERMISSION_LABELS: Record<Permission, string> = {
  "config.manage": "Manage workspace configuration",
  "users.manage": "Manage people and roles",
  "tickets.assign": "Assign tickets",
  "tickets.delete": "Delete tickets",
  "reports.view": "View reports and dashboards",
  "audit.view": "View the audit log",
};

export function UsersPage() {
  const { tenantSlug = "" } = useParams();
  const { memberships } = useAuth();
  const membership = memberships.find((item) => item.slug === tenantSlug);
  const canManage = membership?.permissions.includes("users.manage") ?? false;
  const confirm = useConfirm();
  const toast = useToast();
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("agent");
  const [inviteTeams, setInviteTeams] = useState<string[]>([]);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [roleSheetOpen, setRoleSheetOpen] = useState(false);
  const [roleName, setRoleName] = useState("");
  const [roleBase, setRoleBase] = useState<Role>("agent");
  const [rolePermissions, setRolePermissions] = useState<Permission[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<UsersResponse>(`/t/${tenantSlug}/users`),
      api<Config>(`/t/${tenantSlug}/config`),
    ])
      .then(([data, config]) => {
        if (cancelled) return;
        setUsers(data.users);
        setInvitations(data.invitations);
        setRoles(data.custom_roles);
        setTeams(config.teams);
        setDrafts(
          Object.fromEntries(
            data.users.map((user) => [
              user.id,
              {
                role: user.role,
                isActive: user.is_active,
                teamIds: user.team_ids,
                customRoleId: user.custom_role_id,
                managerUserId: user.manager_user_id,
              },
            ]),
          ),
        );
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
  }, [tenantSlug, refresh]);

  if (loading) return <PageSkeleton rows={6} cols={5} label="Loading people" />;

  function updateDraft(userId: string, change: Partial<Draft>): void {
    setDrafts((current) => {
      const existing = current[userId];
      if (!existing) return current;
      return { ...current, [userId]: { ...existing, ...change } };
    });
  }

  async function saveUser(user: TenantUser): Promise<void> {
    const draft = drafts[user.id];
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await patch(`/t/${tenantSlug}/users/${user.id}`, {
        role: draft.role,
        isActive: draft.isActive,
        teamIds: draft.teamIds,
        customRoleId: draft.customRoleId,
        managerUserId: draft.managerUserId,
      });
      toast.success(`${user.name} updated.`);
      setRefresh((value) => value + 1);
    } catch (caught) {
      setDrafts((current) => ({
        ...current,
        [user.id]: {
          role: user.role,
          isActive: user.is_active,
          teamIds: user.team_ids,
          customRoleId: user.custom_role_id,
          managerUserId: user.manager_user_id,
        },
      }));
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function invite(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setInviteLink(null);
    try {
      const result = await post<{ link: string }>(`/t/${tenantSlug}/invitations`, {
        email: inviteEmail,
        role: inviteRole,
        teamIds: inviteTeams,
      });
      setInviteLink(result.link);
      setInviteEmail("");
      setInviteTeams([]);
      toast.success("Invitation created", "Copy the link below and share it securely.");
      setRefresh((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await del(`/t/${tenantSlug}/invitations/${id}`);
      toast.success("Invitation revoked.");
      setRefresh((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function startRoleEdit(role: CustomRole): void {
    setEditingRoleId(role.id);
    setRoleName(role.name);
    setRoleBase(role.base_role);
    setRolePermissions(role.permissions.filter((item): item is Permission =>
      (PERMISSION_KEYS as readonly string[]).includes(item),
    ));
    setRoleSheetOpen(true);
  }

  function startRoleCreate(): void {
    setEditingRoleId(null);
    setRoleName("");
    setRoleBase("agent");
    setRolePermissions([]);
    setRoleSheetOpen(true);
  }

  function resetRoleForm(): void {
    setEditingRoleId(null);
    setRoleName("");
    setRoleBase("agent");
    setRolePermissions([]);
    setRoleSheetOpen(false);
  }

  async function saveRole(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body = { name: roleName, baseRole: roleBase, permissions: rolePermissions };
    try {
      if (editingRoleId) {
        await patch(`/t/${tenantSlug}/custom-roles/${editingRoleId}`, body);
      } else {
        await post(`/t/${tenantSlug}/custom-roles`, body);
      }
      toast.success(editingRoleId ? "Role updated." : "Role created.");
      resetRoleForm();
      setRefresh((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function deleteRole(role: CustomRole): Promise<void> {
    const confirmed = await confirm({
      title: `Delete the "${role.name}" role?`,
      body: "Members will fall back to their base role.",
      confirmLabel: "Delete role",
      tone: "danger",
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await del(`/t/${tenantSlug}/custom-roles/${role.id}`);
      toast.success("Role deleted.");
      if (editingRoleId === role.id) resetRoleForm();
      setRefresh((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function toggleTeam(userId: string, teamId: string): void {
    const draft = drafts[userId];
    if (!draft) return;
    updateDraft(userId, {
      teamIds: draft.teamIds.includes(teamId)
        ? draft.teamIds.filter((id) => id !== teamId)
        : [...draft.teamIds, teamId],
    });
  }

  return (
    <div className="stack-lg">
      <PageHeader eyebrow="Workspace" title="People and access">
        <p className="muted">Invite teammates, assign teams, and build custom permission sets.</p>
      </PageHeader>
      <ErrorAlert message={error} />
      {!canManage && (
        <div
          className="card"
          style={{
            marginBottom: 16,
            background: "rgba(56, 139, 253, 0.1)",
            border: "1px solid rgba(88, 166, 255, 0.35)",
            padding: "12px 18px",
            borderRadius: 8,
          }}
        >
          <strong style={{ color: "var(--accent-blue, #58a6ff)", display: "flex", alignItems: "center", gap: 8 }}>
            Read-Only Reviewer Mode
          </strong>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted, #8b949e)" }}>
            Team roster and roles are displayed in read-only inspection mode. User invitations, role modifications, and team assignments are restricted to Tenant Administrators.
          </p>
        </div>
      )}
      {inviteLink && (
        <div className="callout warning">
          <strong>Invitation link</strong>
          <p className="mono-break">{inviteLink}</p>
          <button
            className="button secondary small"
            onClick={() => {
              void navigator.clipboard.writeText(inviteLink);
              toast.info("Invitation link copied.");
            }}
          >
            Copy link
          </button>
        </div>
      )}

      {canManage && (
        <>
          <div className="admin-section-divider">
            <div className="eyebrow">Onboarding</div>
            <h3>Invitations & Access</h3>
          </div>

          <div className="people-top">
            <section className="card">
              <div className="section-heading"><h2>Invite someone</h2></div>
              <form className="form-grid" onSubmit={(event) => void invite(event)}>
                <label>
                  Email
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Base role
                  <Select
                    ariaLabel="Base role"
                    value={inviteRole}
                    onChange={(next) => setInviteRole(next as Role)}
                    options={ROLES.map((item) => ({ value: item, label: humanize(item) }))}
                  />
                </label>
                {teams.length > 0 && (
                  <fieldset className="field-group span-2">
                    <legend>Teams</legend>
                    {teams.map((team) => (
                      <label key={team.id} className="check-row">
                        <input
                          type="checkbox"
                          checked={inviteTeams.includes(team.id)}
                          onChange={(event) =>
                            setInviteTeams((current) =>
                              event.target.checked
                                ? [...current, team.id]
                                : current.filter((id) => id !== team.id),
                            )
                          }
                        />
                        {team.name}
                      </label>
                    ))}
                  </fieldset>
                )}
                <div className="form-actions span-2">
                  <button className="button" disabled={busy} type="submit">Create invitation</button>
                </div>
              </form>
            </section>

            <section className="list-panel card">
              <div className="panel-head">
                <h2>Pending invitations</h2>
                <span className="badge subtle">{invitations.length}</span>
              </div>
              {invitations.length === 0 ? (
                <EmptyState title="No pending invitations">New invitations will appear here.</EmptyState>
              ) : (
                <div className="table-wrap">
                  <table className="compact">
                    <thead><tr><th>Email</th><th>Role</th><th>Expires</th><th /></tr></thead>
                    <tbody>
                      {invitations.map((invitation) => (
                        <tr key={invitation.id}>
                          <td>{invitation.email}</td>
                          <td><RoleBadge role={invitation.role} /></td>
                          <td className="muted small">{new Date(invitation.expires_at).toLocaleDateString()}</td>
                          <td>
                            <button className="button ghost small" disabled={busy} onClick={() => void revoke(invitation.id)}>
                              Revoke
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </>
      )}

      <div className="admin-section-divider">
        <div className="eyebrow">Workspace roster</div>
        <h3>Members</h3>
      </div>

      <section className="list-panel card">
        <div className="panel-head">
          <h2>Members</h2>
          <span className="badge subtle">{users.length}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Person</th><th>Role</th><th>Teams</th><th>Manager</th><th>Active</th><th /></tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const draft = drafts[user.id] ?? {
                  role: user.role,
                  isActive: user.is_active,
                  teamIds: user.team_ids,
                  customRoleId: user.custom_role_id,
                  managerUserId: user.manager_user_id,
                };
                const roleValue = draft.customRoleId ? `custom:${draft.customRoleId}` : `builtin:${draft.role}`;
                return (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.name}</strong>
                      <div className="muted small">{user.email}</div>
                    </td>
                    <td>
                      {canManage ? (
                        <Select
                          ariaLabel={`Role for ${user.name}`}
                          value={roleValue}
                          onChange={(value) => {
                            if (value.startsWith("custom:")) {
                              const role = roles.find((item) => item.id === value.slice(7));
                              if (role) {
                                updateDraft(user.id, { customRoleId: role.id, role: role.base_role });
                              }
                            } else {
                              updateDraft(user.id, {
                                customRoleId: null,
                                role: value.slice(8) as Role,
                              });
                            }
                          }}
                          options={[
                            ...ROLES.map((item) => ({
                              value: `builtin:${item}`,
                              label: humanize(item),
                              group: "Built-in roles",
                            })),
                            ...roles.map((item) => ({
                              value: `custom:${item.id}`,
                              label: `${item.name} (${humanize(item.base_role)})`,
                              group: "Custom roles",
                            })),
                          ]}
                        />
                      ) : (
                        <RoleBadge role={user.role} />
                      )}
                    </td>
                    <td>
                      {canManage ? (
                        <div className="team-checks">
                          {teams.map((team) => (
                            <label key={team.id} className="check-row">
                              <input
                                type="checkbox"
                                checked={draft.teamIds.includes(team.id)}
                                onChange={() => toggleTeam(user.id, team.id)}
                              />
                              {team.name}
                            </label>
                          ))}
                        </div>
                      ) : (
                        <span className="small">
                          {user.team_ids.length > 0
                            ? teams
                                .filter((t) => user.team_ids.includes(t.id))
                                .map((t) => t.name)
                                .join(", ")
                            : <span className="muted">No teams</span>}
                        </span>
                      )}
                    </td>
                    <td>
                      {canManage ? (
                        <Select
                          ariaLabel={`Manager for ${user.name}`}
                          value={draft.managerUserId ?? ""}
                          onChange={(value) => updateDraft(user.id, { managerUserId: value || null })}
                          options={[
                            { value: "", label: "No manager" },
                            ...users
                              .filter((other) => other.id !== user.id)
                              .map((other) => ({ value: other.id, label: other.name })),
                          ]}
                        />
                      ) : (
                        <span className="small muted">
                          {users.find((other) => other.id === user.manager_user_id)?.name ?? "None"}
                        </span>
                      )}
                    </td>
                    <td>
                      {canManage ? (
                        <input
                          type="checkbox"
                          checked={draft.isActive}
                          onChange={(event) => updateDraft(user.id, { isActive: event.target.checked })}
                          aria-label={`Active: ${user.name}`}
                        />
                      ) : (
                        <span className={`badge ${user.is_active ? "success" : "subtle"}`}>
                          {user.is_active ? "Active" : "Inactive"}
                        </span>
                      )}
                    </td>
                    <td>
                      {canManage && (
                        <button className="button secondary small" disabled={busy} onClick={() => void saveUser(user)}>
                          Save
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="admin-section-divider">
        <div className="eyebrow">Permissions</div>
        <h3>Custom Roles</h3>
      </div>

      <section className="list-panel card">
        <div className="panel-head">
          <h2>Custom roles</h2>
          <div className="panel-actions">
            <span className="badge subtle">{roles.length}</span>
            <button type="button" className="button secondary small" onClick={startRoleCreate}>
              New role
            </button>
          </div>
        </div>
        {roles.length === 0 ? (
          <EmptyState title="No custom roles">Create one to grant a focused permission set.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="compact">
              <thead>
                <tr><th>Role</th><th>Base role</th><th>Members</th><th>Permissions</th><th /></tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.id}>
                    <td><strong>{role.name}</strong></td>
                    <td>{humanize(role.base_role)}</td>
                    <td>{role.member_count}</td>
                    <td className="muted small">
                      {role.permissions.length === 0
                        ? "No extra permissions"
                        : role.permissions.map((permission) => humanize(permission.replace(".", " "))).join(", ")}
                    </td>
                    <td>
                      <div className="role-actions">
                        <button className="button ghost small" disabled={busy} onClick={() => startRoleEdit(role)}>
                          Edit
                        </button>
                        <button className="button ghost small" disabled={busy} onClick={() => void deleteRole(role)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Sheet
        open={roleSheetOpen}
        onClose={resetRoleForm}
        eyebrow="Custom role"
        title={editingRoleId ? "Edit role" : "New role"}
        description="Pick a base role, then add only the permissions this role should have."
        footer={
          <>
            <button type="button" className="button secondary" onClick={resetRoleForm}>
              Cancel
            </button>
            <button type="submit" form="role-form" className="button" disabled={busy}>
              {editingRoleId ? "Save role" : "Create role"}
            </button>
          </>
        }
      >
        <form id="role-form" className="form-stack" onSubmit={(event) => void saveRole(event)}>
          <label>
            Role name
            <input
              data-autofocus
              value={roleName}
              onChange={(event) => setRoleName(event.target.value)}
              required
            />
          </label>
          <label>
            Base role
            <Select
              ariaLabel="Base role"
              value={roleBase}
              onChange={(next) => setRoleBase(next as Role)}
              options={ROLES.map((item) => ({ value: item, label: humanize(item) }))}
            />
          </label>
          <fieldset className="field-group">
            <legend>Permissions</legend>
            {PERMISSION_KEYS.map((permission) => (
              <label key={permission} className="check-row">
                <input
                  type="checkbox"
                  checked={rolePermissions.includes(permission)}
                  onChange={(event) =>
                    setRolePermissions((current) =>
                      event.target.checked
                        ? [...current, permission]
                        : current.filter((item) => item !== permission),
                    )
                  }
                />
                {PERMISSION_LABELS[permission]}
              </label>
            ))}
          </fieldset>
        </form>
      </Sheet>
    </div>
  );
}
