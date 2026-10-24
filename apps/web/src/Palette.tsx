import { useEffect, useMemo, useRef, useState } from "react";
import { COLUMNS, api, type Principal, type Status, type Task } from "./api";
import { askAnswer, askSummary } from "./prompts";
import { Kbd } from "./ui";
import type { Page } from "./route";

interface Row { id: string; group: string; label: string; sub?: string; key?: string; icon: string; run: () => void | Promise<void> }

const ICON = {
  task: "M3 3h8v8H3z", go: "M2 7h9M8 4l3 3-3 3", project: "M2 4h10M2 7h10M2 10h6", answer: "M2 3h10v7H6l-3 2.5V10H2z",
  theme: "M7 2a5 5 0 100 10A5 5 0 007 2zM7 2v10", plus: "M7 2v10M2 7h10",
} as const;
const TITLE: Record<Status, string> = Object.fromEntries(COLUMNS.map((c) => [c.status, c.title])) as Record<Status, string>;

function moveLabel(from: Status, to: Status) {
  if (from === "proposed" && to === "confirmed") return "Confirm";
  if (from === "in_progress" && to === "confirmed") return "Release to board";
  if (from === "review" && to === "done") return "Approve";
  if (from === "review" && to === "in_progress") return "Request changes";
  return `Move to ${TITLE[to]}`;
}

export function Palette({ me, onClose, onGo, onJump, onTheme, themeLabel, onNewTask }: {
  me: Principal; onClose: () => void; onGo: (p: Page) => void; onJump: (boardId: string, taskId?: string) => void;
  onTheme: () => void; themeLabel: string; onNewTask: () => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [boards, setBoards] = useState<{ id: string; name: string }[]>([]);
  const [people, setPeople] = useState<Record<string, Principal>>({});
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef(document.activeElement);

  useEffect(() => {
    input.current?.focus();
    Promise.all([api<Task[]>("/tasks"), api<{ id: string; name: string }[]>("/boards"), api<Principal[]>("/principals")])
      .then(([t, b, p]) => { setTasks(t); setBoards(b); setPeople(Object.fromEntries(p.map((x) => [x.id, x]))); }, () => {});
    return () => (opener.current as HTMLElement | null)?.focus?.();
  }, []);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = (s: string) => !needle || s.toLowerCase().includes(needle);
    const out: Row[] = [];
    const matched = tasks.filter((t) => hit(t.title) || hit(people[t.assigneeId ?? ""]?.name ?? "")).slice(0, needle ? 6 : 4);
    const boardName = (id: string) => (boards.length > 1 ? boards.find((b) => b.id === id)?.name : undefined);
    matched.forEach((t) => out.push({
      id: "t" + t.id, group: "Tasks", label: t.title, icon: ICON.task,
      sub: [TITLE[t.status], people[t.assigneeId ?? ""]?.name, t.needsInput ? "asking" : undefined, boardName(t.boardId)].filter(Boolean).join(" · "),
      run: () => onJump(t.boardId, t.id),
    }));
    const top = needle ? matched[0] : undefined;
    if (top) {
      if (top.needsInput && top.assigneeId !== me.id)
        out.push({ id: "a-ans", group: `Actions on “${top.title}”`, label: `Answer ${people[top.assigneeId ?? ""]?.name ?? "the"} question`, icon: ICON.answer, key: "a", run: async () => {
          const a = (await askAnswer(top.question))?.trim(); if (a) await api(`/tasks/${top.id}/answer`, { method: "POST", body: { answer: a } });
        } });
      COLUMNS.filter((c) => c.status !== top.status && top.moves[c.status]?.ok).forEach((c) => out.push({
        id: "a-" + c.status, group: `Actions on “${top.title}”`, label: moveLabel(top.status, c.status), icon: ICON.go,
        run: async () => {
          const body: { to: Status; summary?: string } = { to: c.status };
          if (c.status === "review") { const s = await askSummary(); if (s === null) return; if (s) body.summary = s; }
          await api(`/tasks/${top.id}/move`, { method: "POST", body });
        },
      }));
    }
    const go: Row[] = [
      { id: "g-board", group: "Go to", label: "Board", key: "g b", icon: ICON.project, run: () => onGo("board") },
      { id: "g-agents", group: "Go to", label: "Agents", key: "g a", icon: ICON.go, run: () => onGo("agents") },
      ...(me.role === "admin" && me.kind === "human" ? [{ id: "g-keys", group: "Go to", label: "Keys", key: "g k", icon: ICON.go, run: () => onGo("keys") } as Row] : []),
      ...boards.map((b) => ({ id: "p" + b.id, group: "Projects", label: b.name, icon: ICON.project, run: () => onJump(b.id) }) as Row),
      { id: "n-task", group: "Create", label: "New task", key: "c", icon: ICON.plus, run: onNewTask },
      { id: "x-theme", group: "Appearance", label: `Theme: ${themeLabel} (switch)`, icon: ICON.theme, run: onTheme },
    ];
    return [...out, ...go.filter((r) => hit(r.label) || hit(r.group))];
  }, [q, tasks, boards, people, me, onGo, onJump, onNewTask, onTheme, themeLabel]);

  useEffect(() => setSel(0), [q]);
  const run = (r?: Row) => { if (!r) return; onClose(); Promise.resolve(r.run()).catch((e) => alert((e as Error).message)); };
  const firstAction = rows.find((r) => r.id.startsWith("a-"));

  return (
    <>
      <div className="scrim pal-scrim" onClick={onClose} />
      <div className="pal" role="dialog" aria-modal="true" aria-label="Command palette"
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); onClose(); }
          else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(rows.length - 1, s + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
          else if (e.key === "Enter") { e.preventDefault(); run((e.metaKey || e.ctrlKey) && firstAction ? firstAction : rows[sel]); }
        }}>
        <div className="pal-in">
          <svg width="18" height="18" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.2" /><path d="M9.2 9.2L12 12" /></svg>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks, jump to a view or project…" aria-label="Search"
            role="combobox" aria-expanded aria-controls="pal-list" aria-activedescendant={rows[sel] ? "pal-" + rows[sel].id : undefined} />
          <Kbd>esc</Kbd>
        </div>
        <div id="pal-list" role="listbox" className="pal-list">
          {rows.length === 0 && <p className="dim pal-empty">No results for “{q}”.</p>}
          {rows.map((r, i) => (
            <div key={r.id}>
              {(i === 0 || rows[i - 1].group !== r.group) && <div className="pal-gh">{r.group}</div>}
              <div id={"pal-" + r.id} role="option" aria-selected={i === sel} className={`pal-r${i === sel ? " sel" : ""}`} onMouseMove={() => setSel(i)} onClick={() => run(r)}>
                <span className="pal-ic"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={r.icon} /></svg></span>
                <span className="pal-t"><b>{r.label}</b>{r.sub && <small>{r.sub}</small>}</span>
                {r.key && <Kbd>{r.key}</Kbd>}
              </div>
            </div>
          ))}
        </div>
        <div className="pal-foot"><span><Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate</span><span><Kbd>↵</Kbd> run</span>{firstAction && <span><Kbd>⌘↵</Kbd> first action</span>}<span className="spacer" /><span><Kbd>?</Kbd> shortcuts</span></div>
      </div>
    </>
  );
}
