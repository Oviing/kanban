import { api, type InboxItem, type Principal, type Status } from "./api";
import { askAnswer } from "./prompts";
import { Markdown } from "./Markdown";

const TITLES = { confirm: "Confirm to start", review: "Ready for review", input: "Question from agent", stale: "Stale claim" } as const;

interface Props {
  open: boolean;
  onToggle: () => void;
  items: InboxItem[];
  boards: { id: string; name: string }[];
  people: Record<string, Principal>;
  onOpen: (id: string) => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  move: (id: string, to: Status) => Promise<void>;
}

const InboxIcon = () => (
  <svg width="20" height="20" viewBox="0 0 22 22" aria-hidden="true"><path d="M3 12h4l2 3h4l2-3h4M4 5h14l2 7v6H2v-6z" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinejoin="round" /></svg>
);

/** Approvals live beside the board and can be hidden; collapsed it stays visible as a slim rail with a count. */
export function InboxSidebar({ open, onToggle, items, boards, people, onOpen, act, move }: Props) {
  if (!open)
    return (
      <aside className={`sidebar collapsed${items.length ? " has-items" : ""}`} aria-label="Needs you">
        <button onClick={onToggle} aria-expanded={false} aria-label={`Show Needs you (${items.length})`} title="Show approvals ( [ )">
          <InboxIcon />
          <span className="rail-label">Needs you</span>
          {items.length > 0 && <span className="badge">{items.length}</span>}
        </button>
      </aside>
    );

  return (
    <aside className="sidebar" aria-label="Needs you">
      <div className="sidebar-head">
        <h2>Needs you {items.length > 0 && <span className="badge">{items.length}</span>}</h2>
        <button onClick={onToggle} aria-expanded aria-label="Hide Needs you" title="Hide approvals ( [ )">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M9 2L4 7l5 5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      {items.length === 0 && <p className="dim empty">Nothing is waiting on you.</p>}
      <ul>
        {items.map(({ kind, task: t }) => {
          const by = people[t.assigneeId ?? t.createdBy];
          return (
            <li key={kind + t.id} className={`inb-${kind}`}>
              <div className="inb-main" onClick={() => onOpen(t.id)}>
                <span className="chip">{TITLES[kind]}</span>
                <strong>{t.title}</strong>
                <span className="meta">{[boards.length > 1 && boards.find((b) => b.id === t.boardId)?.name, by?.name].filter(Boolean).join(" · ")}</span>
                {kind === "input" && <div className="summary"><Markdown text={t.question ?? ""} /></div>}
                {kind === "review" && t.reviewSummary && <div className="summary"><Markdown text={t.reviewSummary} /></div>}
                {kind === "review" && t.reviewLinks.length > 0 && (
                  <div className="links" onClick={(e) => e.stopPropagation()}>
                    {t.reviewLinks.map((l) => <a key={l} href={/^https?:/.test(l) ? l : undefined} target="_blank" rel="noreferrer noopener">{l.replace(/^https?:\/\//, "")}</a>)}
                  </div>
                )}
              </div>
              <div className="inb-actions">
                {kind === "confirm" && <button className="primary" onClick={() => move(t.id, "confirmed")}>Confirm</button>}
                {kind === "review" && <>
                  <button className="primary" onClick={() => move(t.id, "done")}>Approve</button>
                  <button onClick={() => move(t.id, "in_progress")}>Request changes</button>
                </>}
                {kind === "input" && t.questionOptions?.slice(0, 3).map((o) => (
                  <button key={o} className="opt" onClick={() => act(() => api(`/tasks/${t.id}/answer`, { method: "POST", body: { answer: o } }))}>{o}</button>
                ))}
                {kind === "input" && (
                  <button className="primary" onClick={async () => { const a = (await askAnswer(t.question))?.trim(); if (a) act(() => api(`/tasks/${t.id}/answer`, { method: "POST", body: { answer: a } })); }}>Answer</button>
                )}
                {kind === "stale" && <button onClick={() => move(t.id, "confirmed")}>Release to board</button>}
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
