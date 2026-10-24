import { useCallback, useEffect, useState } from "react";
import { api, type Principal } from "./api";

interface Person extends Principal { email?: string | null; createdAt?: string }
interface Invite { id: string; email: string; role: "admin" | "member"; expiresAt: string }
interface Key { id: string; principalId: string; label: string; prefix: string; createdAt: string; revokedAt: string | null; lastUsedAt: string | null }

export function Admin({ me }: { me: Principal }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [link, setLink] = useState<string>();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const [p, k, i] = await Promise.all([api<Person[]>("/principals"), api<Key[]>("/api-keys"), api<Invite[]>("/invites")]);
    setPeople(p); setKeys(k); setInvites(i);
  }, []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  };
  const agents = people.filter((p) => p.kind === "agent");
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? id;

  return (
    <main className="admin">
      {error && <div className="error" role="alert" onClick={() => setError(undefined)}>{error}</div>}
      <h3>People{me.orgs?.length ? <small className="hint"> · {me.orgs.find((o) => o.id === me.orgId)?.name}</small> : null}</h3>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Joined</th><th>Role</th><th /></tr></thead>
        <tbody>
          {people.filter((p) => p.kind === "human").map((p) => (
            <tr key={p.id}>
              <td>{p.name}{p.id === me.id && <small className="hint"> (you)</small>}</td>
              <td>{p.email ?? "—"}</td>
              <td>{p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "—"}</td>
              <td>
                <select value={p.role} aria-label={`Role of ${p.name}`} onChange={(e) => run(() => api(`/principals/${p.id}`, { method: "PATCH", body: { role: e.target.value } }))}>
                  <option value="member">Member</option><option value="admin">Admin</option>
                </select>
              </td>
              <td>{p.id !== me.id && <button onClick={async () => { if (confirm(`Remove ${p.name} from this organization?`)) run(() => api(`/principals/${p.id}`, { method: "DELETE" })); }}>Remove</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {me.authMode !== "none" && (
        <>
          <form onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api("/invites", { method: "POST", body: { email: inviteEmail.trim(), role: inviteRole } }); setLink(`${location.origin}/#/invite/${r.token}`); setInviteEmail(""); }); }}>
            <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="Email (optional, limits who can accept)" aria-label="Invitee email" />{" "}
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "member" | "admin")} aria-label="Invite role"><option value="member">Member</option><option value="admin">Admin</option></select>{" "}
            <button className="primary">Create invite link</button>
          </form>
          {link && <div className="fresh">Send this link to the person. It works once and expires in 7 days:<code>{link}</code></div>}
          {invites.length > 0 && (
            <table>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}><td>{i.email || "Anyone with the link"}</td><td>{i.role}</td><td>expires {new Date(i.expiresAt).toLocaleDateString()}</td>
                    <td><button onClick={() => run(() => api(`/invites/${i.id}`, { method: "DELETE" }))}>Revoke</button></td></tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <p className="hint">People appear here after they sign in or accept an invite. Admins manage agents, keys and roles; at least one admin must remain.</p>
      <h3>Agents</h3>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) run(async () => { await api("/agents", { method: "POST", body: { name } }); setName(""); }); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New agent name" /> <button className="primary">Create agent</button>
      </form>
      <table>
        <thead><tr><th>Name</th><th /></tr></thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td>🤖 {a.name}</td>
              <td><button onClick={() => run(async () => { const r = await api("/api-keys", { method: "POST", body: { agentId: a.id, label: "ui" } }); setFresh(r.key); })}>New API key</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Agents that authenticate with OIDC client-credentials tokens appear here automatically on first use.</p>
      {fresh && <div className="fresh">Copy this key now — it won't be shown again:<code>{fresh}</code></div>}
      <h3>API keys</h3>
      <table>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td>{nameOf(k.principalId)}</td><td><code>{k.prefix}…</code></td>
              <td>{k.revokedAt ? "revoked" : k.lastUsedAt ? `used ${new Date(k.lastUsedAt).toLocaleString()}` : "unused"}</td>
              <td>{!k.revokedAt && <button onClick={() => run(() => api(`/api-keys/${k.id}`, { method: "DELETE" }))}>Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
