import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { api, del, errorMessage, humanize, patch, post } from "../api.js";
import { useAuth } from "../auth.js";
import { EmptyState, ErrorAlert, PageHeader, RoleBadge, Spinner } from "../components.js";
import type { Config, PendingInvitation, Role, Team, TenantUser } from "../types.js";

type UsersResponse = { users: TenantUser[]; invitations: PendingInvitation[] };

type Draft = { role: Role; isActive: boolean; teamIds: string[] };

const ROLES: Role[] = ["tenant_admin", "agent", "employee"];

export function UsersPage() {
  const { tenantSlug = "" } = useParams();
  const { memberships } = useAuth();
  const role = memberships.find((item) => item.slug === tenantSlug)?.role;
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("agent");
  const [inviteTeams, setInviteTeams] = useState<string[]>([]);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  useEffect(() => {
    if (role !== "tenant_admin") return;
    let cancelled = false;
    Promise.all([
      api<UsersResponse>(`/t/${tenantSlug}/users`),
      api<Config>(`/t/${tenantSlug}/config`),
    ])
      .then(([data, config]) => {
        if (cancelled) return;
        setUsers(data.users);
        setInvitations(data.invitations);
        setTeams(config.teams);
        setDrafts(
          Object.fromEntries(
            data.users.map((user) => [
              user.id,
              { role: user.role, isActive: user.is_active, teamIds: user.team_ids },
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
  }, [tenantSlug, role, refresh]);

  if (role !== "tenant_admin") {
    return (
      <div className="card narrow">
        <h1>Admins only</h1>
        <p className="muted">You do not have permission to manage people in this workspace.</p>
      </div>
    );
  }
  if (loading) return <Spinner label="Loading people…" />;

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
    setNotice(null);
    try {
      await patch(`/t/${tenantSlug}/users/${user.id}`, {
        role: draft.role,
        isActive: draft.isActive,
        teamIds: draft.teamIds,
      });
      setNotice(`${user.name} updated.`);
      setRefresh((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function invite(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
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
      setNotice("Invitation created. Copy the link below and share it securely.");
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
      setNotice("Invitation revoked.");
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
    <>
      <PageHeader eyebrow="Workspace" title="People">
        <p className="muted">Invite teammates, set roles, and assign teams.</p>
      </PageHeader>
      <ErrorAlert message={error} />
      {notice && <div className="callout success">{notice}</div>}
      {inviteLink && (
        <div className="callout warning">
          <strong>Invitation link</strong>
          <p className="mono-break">{inviteLink}</p>
          <button
            className="button secondary small"
            onClick={() => {
              void navigator.clipboard.writeText(inviteLink);
              setNotice("Invitation link copied.");
            }}
          >
            Copy link
          </button>
        </div>
      )}

      <div className="admin-grid">
        <section className="card">
          <div className="section-heading"><h2>Invite someone</h2></div>
          <form className="stack" onSubmit={(event) => void invite(event)}>
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
              Role
              <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Role)}>
                {ROLES.map((item) => (
                  <option key={item} value={item}>{humanize(item)}</option>
                ))}
              </select>
            </label>
            {teams.length > 0 && (
              <fieldset className="field-group">
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
            <button className="button" disabled={busy} type="submit">Create invitation</button>
          </form>
        </section>

        <section className="card">
          <div className="section-heading"><h2>Pending invitations</h2></div>
          {invitations.length === 0 ? (
            <EmptyState title="No pending invitations">New invitations will appear here.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
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

      <section className="card" style={{ marginTop: "1.25rem" }}>
        <div className="section-heading"><h2>Members</h2></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Person</th><th>Role</th><th>Teams</th><th>Active</th><th /></tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const draft = drafts[user.id] ?? {
                  role: user.role,
                  isActive: user.is_active,
                  teamIds: user.team_ids,
                };
                return (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.name}</strong>
                      <div className="muted small">{user.email}</div>
                    </td>
                    <td>
                      <select
                        value={draft.role}
                        onChange={(event) => updateDraft(user.id, { role: event.target.value as Role })}
                      >
                        {ROLES.map((item) => (
                          <option key={item} value={item}>{humanize(item)}</option>
                        ))}
                      </select>
                    </td>
                    <td>
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
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={draft.isActive}
                        onChange={(event) => updateDraft(user.id, { isActive: event.target.checked })}
                        aria-label={`Active: ${user.name}`}
                      />
                    </td>
                    <td>
                      <button className="button secondary small" disabled={busy} onClick={() => void saveUser(user)}>
                        Save
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
