import { useCallback, useEffect, useState } from "react";
import { api, type Principal } from "./api";

interface Key { id: string; principalId: string; label: string; prefix: string; createdAt: string; revokedAt: string | null; lastUsedAt: string | null }

export function Admin() {
  const [people, setPeople] = useState<Principal[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const [p, k] = await Promise.all([api<Principal[]>("/principals"), api<Key[]>("/api-keys")]);
    setPeople(p); setKeys(k);
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
      {error && <div className="error">{error}</div>}
      <h3>Agents</h3>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) run(async () => { await api("/agents", { method: "POST", body: { name } }); setName(""); }); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New agent name" /> <button className="primary">Create agent</button>
      </form>
      <table>
        <thead><tr><th>Name</th><th>Can confirm / approve</th><th /></tr></thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td>🤖 {a.name}</td>
              <td><input type="checkbox" checked={a.canConfirm} onChange={(e) => run(() => api(`/principals/${a.id}`, { method: "PATCH", body: { canConfirm: e.target.checked } }))} /></td>
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
