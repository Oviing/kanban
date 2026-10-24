import { useEffect, useRef, useState } from "react";
import { api, ago, describeEvent, hostOf, isStale, leaseMinutesLeft, type Principal, type TaskDetail } from "./api";
import { askSummary } from "./prompts";
import { Avatar, Kbd } from "./ui";
import { Markdown } from "./Markdown";
import { MentionTextarea } from "./MentionTextarea";
import { PRIORITY_LABEL } from "./logic";

const NEXT: Record<string, { to: string; label: string; primary?: boolean }[]> = {
  proposed: [{ to: "confirmed", label: "Confirm", primary: true }],
  confirmed: [{ to: "in_progress", label: "Start (claim)", primary: true }],
  in_progress: [{ to: "review", label: "Submit for review", primary: true }, { to: "confirmed", label: "Release" }],
  review: [{ to: "done", label: "Approve", primary: true }, { to: "in_progress", label: "Request changes" }],
  done: [],
};
const STATUS_LABEL: Record<string, string> = { proposed: "Proposed", confirmed: "Confirmed", in_progress: "In progress", review: "In review", done: "Done" };
const label = (s?: string) => (s ? STATUS_LABEL[s] ?? s.replace("_", " ") : "");

export function TaskDrawer({ id, me, people, boardName, rev, onClose, onChange }: {
  id: string; me: Principal; people: Record<string, Principal>; boardName?: string; rev: number; onClose: () => void; onChange: () => Promise<void>;
}) {
  const [t, setT] = useState<TaskDetail>();
  const [comment, setComment] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string>();
  const sheet = useRef<HTMLElement>(null);
  const opener = useRef(document.activeElement);

  useEffect(() => { api<TaskDetail>(`/tasks/${id}`).then(setT, (e) => setError(e.message)); }, [id, rev]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector(".dlg, .pal, .mlist") && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  // Move focus into the sheet, and hand it back to the card that opened it.
  useEffect(() => {
    sheet.current?.focus();
    return () => (opener.current as HTMLElement | null)?.focus?.();
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try { await fn(); await onChange(); } catch (e) { setError((e as Error).message); }
  };
  if (!t) return <><div className="scrim" onClick={onClose} /><aside className="drawer" ref={sheet} tabIndex={-1}><button className="close" onClick={onClose} aria-label="Close">✕</button>{error ?? "Loading…"}</aside></>;

  const assignee = t.assigneeId ? people[t.assigneeId] : undefined;
  const actions = NEXT[t.status].filter((a) => t.moves?.[a.to as keyof typeof t.moves]?.ok);
  const canAnswer = t.needsInput && t.assigneeId !== me.id;
  const left = leaseMinutesLeft(t);
  const stale = isStale(t);
  const updated = t.events.length ? t.events[t.events.length - 1].createdAt : null;
  const doMove = async (a: { to: string }) => {
    const body: Record<string, unknown> = { to: a.to };
    if (a.to === "review") { const s = await askSummary(); if (s === null) return; if (s) body.summary = s; }
    run(() => api(`/tasks/${id}/move`, { method: "POST", body }));
  };
  const answerWith = (a: string) => { if (a.trim()) run(async () => { await api(`/tasks/${id}/answer`, { method: "POST", body: { answer: a.trim() } }); setReply(""); }); };
  const sendReply = () => answerWith(reply);
  const names = Object.values(people).map((p) => p.name);
  const everyone = Object.values(people);
  const sendComment = () => { if (comment.trim()) run(async () => { await api(`/tasks/${id}/comments`, { method: "POST", body: { body: comment } }); setComment(""); }); };
  const submitOnMeta = (fn: () => void) => (e: React.KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); fn(); } };

  return (
    <>
    <div className="scrim" onClick={onClose} />
    <aside className="drawer" aria-label="Task details" ref={sheet} tabIndex={-1}>
      <div className="drawer-top">
        <span className="dim">{boardName}</span>
        <span className="spacer" />
        <Kbd>esc</Kbd>
        <button className="close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="drawer-head">
        <div>
          <h2>{t.title}</h2>
          <div className="chips">
            <span className={`chip status ${t.status}`}>{label(t.status)}</span>
            {canAnswer && <span className="chip warn">Waiting on you</span>}
            {stale && <span className="chip warn">Stale</span>}
          </div>
        </div>
      </div>
      <div className="facts">
        <span><small>Assignee</small><b>{assignee ? <><Avatar name={assignee.name} kind={assignee.kind} size={20} />{assignee.name}</> : "none"}</b></span>
        <span><small>Priority</small><b>{PRIORITY_LABEL[t.priority] || "None"}</b></span>
        <span><small>Lease</small><b className={left !== null && left < 10 ? "warnt" : ""}>{left === null ? "–" : left < 0 ? `expired ${-left}m ago` : `${left} min left`}</b></span>
        <span><small>Updated</small><b>{updated ? ago(updated) : "–"}</b></span>
      </div>

      {error && <div className="error" role="alert">{error}</div>}
      {t.needsInput && (
        <section className="ask-box big" aria-label="Open question">
          <b>{assignee ? `${assignee.name} needs your answer` : "Question"}</b>
          <Markdown text={t.question ?? ""} names={names} />
          {canAnswer && t.questionOptions?.length > 0 && (
            <div className="quick" role="group" aria-label="Suggested answers">
              {t.questionOptions.map((o) => <button key={o} onClick={() => answerWith(o)}>{o}</button>)}
            </div>
          )}
          {canAnswer && (
            <div className="reply">
              <textarea value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={submitOnMeta(sendReply)} placeholder={t.questionOptions?.length ? "Or write your own answer…" : "Write your answer…"} aria-label="Your answer" rows={2} />
              <button className="primary" disabled={!reply.trim()} onClick={sendReply}>Answer</button>
            </div>
          )}
        </section>
      )}
      {stale && <div className="stale-box">Claim lease expired. The assignee has been silent since {ago(t.leaseExpiresAt)}.</div>}

      {t.reviewSummary && (
        <section className="evidence">
          <h3>Evidence from {assignee?.name ?? "the assignee"}</h3>
          <Markdown text={t.reviewSummary} names={names} />
          {t.reviewLinks.map((l) => (
            <a key={l} href={/^https?:/.test(l) ? l : undefined} target="_blank" rel="noreferrer noopener" className="evlink">
              <span className="evic"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M6 8l2-2M5 5.5l1.2-1.2a2 2 0 013 3L8 8.5M9 8.5l-1.2 1.2a2 2 0 01-3-3L6 5.5" /></svg></span>
              <span>{hostOf(l)}</span>
            </a>
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
      {t.comments.map((c) => (
        <div key={c.id} className="comment">
          <Avatar name={c.authorName} kind={c.authorKind} size={20} /><div><b>{c.authorName}</b><time>{ago(c.createdAt)}</time><Markdown text={c.body} names={names} /></div>
        </div>
      ))}
      <div className="composer">
        <MentionTextarea value={comment} onChange={setComment} people={everyone} onKeyDown={submitOnMeta(sendComment)} placeholder="Add a comment…  @ mentions, **bold**, `code`" aria-label="Add a comment" rows={1} />
        <Kbd>⌘↵</Kbd>
        <button disabled={!comment.trim()} onClick={sendComment}>Send</button>
      </div>

      <h3 className="lbl">Activity</h3>
      <ol className="timeline">
        {t.events.slice().reverse().map((e) => (
          <li key={e.id} className={e.type === "input_requested" && t.needsInput ? "hot" : ""}>
            <b>{e.actorName}</b> {describeEvent(e)} <time>{ago(e.createdAt)}</time>
            {e.type === "moved" && e.payload?.from && e.payload?.to && <span className="diff">{label(e.payload.from)} → {label(e.payload.to)}</span>}
          </li>
        ))}
      </ol>

      <div className="drawer-actions">
        {actions.map((a) => <button key={a.to + a.label} className={a.primary ? "primary" : ""} onClick={() => doMove(a)}>{a.label}</button>)}
        {stale && t.moves.in_progress.ok && (
          <button onClick={() => run(() => api(`/tasks/${id}/move`, { method: "POST", body: { to: "in_progress" } }))}>Take over (stale)</button>
        )}
        {!t.assigneeId && t.status !== "proposed" && t.status !== "done" && (
          <button onClick={() => run(() => api(`/tasks/${id}/assign`, { method: "POST", body: { assigneeId: me.id } }))}>Assign to me</button>
        )}
      </div>
    </aside>
    </>
  );
}
