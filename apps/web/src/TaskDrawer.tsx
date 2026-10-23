import { useEffect, useState } from "react";
import { api, isStale, type Principal, type TaskDetail } from "./api";
import { askAnswer, askSummary } from "./prompts";

const NEXT: Record<string, { to: string; label: string }[]> = {
  proposed: [{ to: "confirmed", label: "Confirm" }],
  confirmed: [{ to: "in_progress", label: "Start (claim)" }],
  in_progress: [{ to: "review", label: "Submit for review" }, { to: "confirmed", label: "Release" }],
  review: [{ to: "done", label: "Approve" }, { to: "in_progress", label: "Request changes" }],
  done: [],
};

export function TaskDrawer({ id, me, people, rev, onClose, onChange }: {
  id: string; me: Principal; people: Record<string, Principal>; rev: number; onClose: () => void; onChange: () => Promise<void>;
}) {
  const [t, setT] = useState<TaskDetail>();
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => { api<TaskDetail>(`/tasks/${id}`).then(setT, (e) => setError(e.message)); }, [id, rev]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try { await fn(); await onChange(); } catch (e) { setError((e as Error).message); }
  };
  if (!t) return <aside className="drawer"><button onClick={onClose}>Close</button>{error}</aside>;

  const who = (n: string, k: string) => <b className={`badge ${k}`}>{k === "agent" ? "🤖" : "👤"} {n}</b>;
  return (
    <aside className="drawer">
      <button className="close" onClick={onClose}>✕</button>
      <h2>{t.title}</h2>
      <p className="meta">{t.status.replace("_", " ")} · created by {people[t.createdBy]?.name ?? "?"} · assignee {t.assigneeId ? people[t.assigneeId]?.name : "—"}</p>
      <textarea
        defaultValue={t.description}
        placeholder="Description"
        onBlur={(e) => e.target.value !== t.description && run(() => api(`/tasks/${id}`, { method: "PATCH", body: { description: e.target.value, expectedVersion: t.version } }))}
      />
      {error && <div className="error">{error}</div>}
      {t.needsInput && <div className="ask-box">❓ {t.question}</div>}
      {isStale(t) && <div className="stale-box">Claim lease expired — the assignee has been silent since {new Date(t.leaseExpiresAt!).toLocaleTimeString()}.</div>}
      {t.reviewSummary && (
        <div className="evidence">
          <h4>Submitted for review</h4>
          <p>{t.reviewSummary}</p>
          {t.reviewLinks.map((l) => <div key={l}><a href={/^https?:/.test(l) ? l : undefined} target="_blank" rel="noreferrer noopener">{l}</a></div>)}
        </div>
      )}
      <div className="actions">
        {NEXT[t.status].filter((a) => t.moves?.[a.to as keyof typeof t.moves]?.ok).map((a) => (
          <button key={a.to + a.label} className="primary" onClick={() => {
            const body: Record<string, unknown> = { to: a.to };
            if (a.to === "review") { const s = askSummary(); if (s === null) return; if (s) body.summary = s; }
            run(() => api(`/tasks/${id}/move`, { method: "POST", body }));
          }}>{a.label}</button>
        ))}
        {isStale(t) && t.moves.in_progress.ok && (
          <button onClick={() => run(() => api(`/tasks/${id}/move`, { method: "POST", body: { to: "in_progress" } }))}>Take over (stale)</button>
        )}
        {t.needsInput && (me.kind === "human" || me.canConfirm) && (
          <button className="primary" onClick={() => { const a = askAnswer(t.question)?.trim(); if (a) run(() => api(`/tasks/${id}/answer`, { method: "POST", body: { answer: a } })); }}>Answer question</button>
        )}
        {!t.assigneeId && t.status !== "proposed" && t.status !== "done" && (
          <button onClick={() => run(() => api(`/tasks/${id}/assign`, { method: "POST", body: { assigneeId: me.id } }))}>Assign to me</button>
        )}
      </div>
      <h4>Comments</h4>
      {t.comments.map((c) => <div key={c.id} className="comment">{who(c.authorName, c.authorKind)} <time>{new Date(c.createdAt).toLocaleString()}</time><p>{c.body}</p></div>)}
      <form onSubmit={(e) => { e.preventDefault(); if (comment.trim()) run(async () => { await api(`/tasks/${id}/comments`, { method: "POST", body: { body: comment } }); setComment(""); }); }}>
        <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment…" />
      </form>
      <h4>Activity</h4>
      <ul className="events">
        {t.events.slice().reverse().map((e) => (
          <li key={e.id}>{who(e.actorName, e.actorKind)} {e.type}{e.payload?.to ? ` → ${e.payload.to}` : ""} <time>{new Date(e.createdAt).toLocaleString()}</time></li>
        ))}
      </ul>
    </aside>
  );
}
