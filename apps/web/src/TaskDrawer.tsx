import { useEffect, useState } from "react";
import { api, describeEvent, hostOf, isStale, ago, type Principal, type TaskDetail } from "./api";
import { askAnswer, askSummary } from "./prompts";

const NEXT: Record<string, { to: string; label: string; primary?: boolean }[]> = {
  proposed: [{ to: "confirmed", label: "Confirm", primary: true }],
  confirmed: [{ to: "in_progress", label: "Start (claim)", primary: true }],
  in_progress: [{ to: "review", label: "Submit for review", primary: true }, { to: "confirmed", label: "Release" }],
  review: [{ to: "done", label: "Approve", primary: true }, { to: "in_progress", label: "Request changes" }],
  done: [],
};
const STATUS_LABEL: Record<string, string> = { proposed: "Proposed", confirmed: "Confirmed", in_progress: "In progress", review: "In review", done: "Done" };

export function TaskDrawer({ id, me, people, rev, onClose, onChange }: {
  id: string; me: Principal; people: Record<string, Principal>; rev: number; onClose: () => void; onChange: () => Promise<void>;
}) {
  const [t, setT] = useState<TaskDetail>();
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => { api<TaskDetail>(`/tasks/${id}`).then(setT, (e) => setError(e.message)); }, [id, rev]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try { await fn(); await onChange(); } catch (e) { setError((e as Error).message); }
  };
  if (!t) return <><div className="scrim" onClick={onClose} /><aside className="drawer"><button className="close" onClick={onClose} aria-label="Close">✕</button>{error}</aside></>;

  const who = (n: string, k: string) => <b className={`who ${k}`}>{n}</b>;
  const actions = NEXT[t.status].filter((a) => t.moves?.[a.to as keyof typeof t.moves]?.ok);
  const canAnswer = t.needsInput && (me.kind === "human" || me.canConfirm || !t.humanInLoop) && t.assigneeId !== me.id;
  const doMove = (a: { to: string }) => {
    const body: Record<string, unknown> = { to: a.to };
    if (a.to === "review") { const s = askSummary(); if (s === null) return; if (s) body.summary = s; }
    run(() => api(`/tasks/${id}/move`, { method: "POST", body }));
  };

  return (
    <>
    <div className="scrim" onClick={onClose} />
    <aside className="drawer" aria-label="Task details">
      <div className="drawer-head">
        <div>
          <span className={`chip status ${t.status}`}>{STATUS_LABEL[t.status]}</span>
          <h2>{t.title}</h2>
        </div>
        <button className="close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="facts">
        <span><small>Assignee</small><b>{t.assigneeId ? people[t.assigneeId]?.name : "none"}</b></span>
        <span><small>Created by</small><b>{people[t.createdBy]?.name ?? "?"}</b></span>
        <span><small>Priority</small><b>{t.priority}</b></span>
      </div>

      {error && <div className="error">{error}</div>}
      {t.needsInput && <div className="ask-box"><b>{t.assigneeId ? `Question from ${people[t.assigneeId]?.name}` : "Question"}</b>{t.question}</div>}
      {isStale(t) && <div className="stale-box">Claim lease expired. The assignee has been silent since {ago(t.leaseExpiresAt)}.</div>}

      {t.reviewSummary && (
        <section className="evidence">
          <h3>Evidence from {t.assigneeId ? people[t.assigneeId]?.name : "the assignee"}</h3>
          <p>{t.reviewSummary}</p>
          {t.reviewLinks.map((l) => (
            <a key={l} href={/^https?:/.test(l) ? l : undefined} target="_blank" rel="noreferrer noopener" className="evlink">{hostOf(l)}</a>
          ))}
        </section>
      )}

      <label className="lbl" htmlFor="desc">Description</label>
      <textarea
        id="desc"
        defaultValue={t.description}
        placeholder="Add details, acceptance criteria…"
        onBlur={(e) => e.target.value !== t.description && run(() => api(`/tasks/${id}`, { method: "PATCH", body: { description: e.target.value, expectedVersion: t.version } }))}
      />

      <h3 className="lbl">Comments</h3>
      {t.comments.map((c) => <div key={c.id} className="comment">{who(c.authorName, c.authorKind)} <time>{ago(c.createdAt)}</time><p>{c.body}</p></div>)}
      <form onSubmit={(e) => { e.preventDefault(); if (comment.trim()) run(async () => { await api(`/tasks/${id}/comments`, { method: "POST", body: { body: comment } }); setComment(""); }); }}>
        <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment…" aria-label="Add a comment" />
      </form>

      <h3 className="lbl">Activity</h3>
      <ol className="timeline">
        {t.events.slice().reverse().map((e) => (
          <li key={e.id}>{who(e.actorName, e.actorKind)} {describeEvent(e)} <time>{ago(e.createdAt)}</time></li>
        ))}
      </ol>

      <div className="drawer-actions">
        {actions.map((a) => <button key={a.to + a.label} className={a.primary ? "primary" : ""} onClick={() => doMove(a)}>{a.label}</button>)}
        {isStale(t) && t.moves.in_progress.ok && (
          <button onClick={() => run(() => api(`/tasks/${id}/move`, { method: "POST", body: { to: "in_progress" } }))}>Take over (stale)</button>
        )}
        {canAnswer && <button className="primary" onClick={() => { const a = askAnswer(t.question)?.trim(); if (a) run(() => api(`/tasks/${id}/answer`, { method: "POST", body: { answer: a } })); }}>Answer question</button>}
        {!t.assigneeId && t.status !== "proposed" && t.status !== "done" && (
          <button onClick={() => run(() => api(`/tasks/${id}/assign`, { method: "POST", body: { assigneeId: me.id } }))}>Assign to me</button>
        )}
      </div>
    </aside>
    </>
  );
}
