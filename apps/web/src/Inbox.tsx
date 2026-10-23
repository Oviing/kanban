import { api, type InboxItem, type Principal, type Status } from "./api";
import { askAnswer } from "./prompts";

const TITLES = { confirm: "Confirm to start", review: "Review the work", input: "Agent needs input", stale: "Stale claim" } as const;

export function Inbox({ items, boards, people, onOpen, act, move }: {
  items: InboxItem[];
  boards: { id: string; name: string }[];
  people: Record<string, Principal>;
  onOpen: (id: string) => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  move: (id: string, to: Status) => Promise<void>;
}) {
  if (!items.length) return null;
  return (
    <section className="inbox" aria-label="Needs you">
      <h3>Needs you <small>{items.length}</small></h3>
      <ul>
        {items.map(({ kind, task: t }) => {
          const by = people[t.assigneeId ?? t.createdBy];
          return (
            <li key={kind + t.id} className={`inb-${kind}`}>
              <div className="inb-main" onClick={() => onOpen(t.id)}>
                <span className="chip">{TITLES[kind]}</span>
                <strong>{t.title}</strong>
                <span className="meta">{boards.length > 1 && boards.find((b) => b.id === t.boardId)?.name} {by && `· ${by.kind === "agent" ? "🤖" : "👤"} ${by.name}`}</span>
                {kind === "input" && <div className="summary">❓ {t.question}</div>}
                {kind === "review" && t.reviewSummary && <div className="summary">{t.reviewSummary}</div>}
                {kind === "review" && t.reviewLinks.length > 0 && (
                  <div className="links" onClick={(e) => e.stopPropagation()}>
                    {t.reviewLinks.map((l) => <a key={l} href={/^https?:/.test(l) ? l : undefined} target="_blank" rel="noreferrer noopener">{l}</a>)}
                  </div>
                )}
              </div>
              <div className="inb-actions">
                {kind === "confirm" && <button className="primary" onClick={() => move(t.id, "confirmed")}>Confirm</button>}
                {kind === "review" && <>
                  <button className="primary" onClick={() => move(t.id, "done")}>Approve</button>
                  <button onClick={() => move(t.id, "in_progress")}>Request changes</button>
                </>}
                {kind === "input" && (
                  <button className="primary" onClick={() => { const a = askAnswer(t.question)?.trim(); if (a) act(() => api(`/tasks/${t.id}/answer`, { method: "POST", body: { answer: a } })); }}>Answer</button>
                )}
                {kind === "stale" && <button onClick={() => move(t.id, "confirmed")}>Release to board</button>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
