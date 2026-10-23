import { useCallback, useEffect, useState } from "react";
import { COLUMNS, api, isLive, isStale, leaseMinutesLeft, type InboxItem, type Principal, type Status, type Task } from "./api";
import { TaskDrawer } from "./TaskDrawer";
import { Inbox } from "./Inbox";
import { askSummary } from "./prompts";

interface BoardInfo { id: string; name: string; humanInLoop: boolean }

export function Board({ me }: { me: Principal }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [people, setPeople] = useState<Record<string, Principal>>({});
  const [boards, setBoards] = useState<BoardInfo[]>([]);
  const [boardId, setBoardId] = useState<string | undefined>(() => localStorage.getItem("kb_board") ?? undefined);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [rev, setRev] = useState(0);
  const [dragging, setDragging] = useState<Task | null>(null);
  const [assignee, setAssignee] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [, tick] = useState(0);
  const leaseTotal = me.leaseMinutes ?? 30;

  const load = useCallback(async () => {
    const all = await api<BoardInfo[]>("/boards");
    setBoards(all);
    const id = all.find((b) => b.id === boardId)?.id ?? all[0]?.id;
    if (id !== boardId) setBoardId(id);
    const [t, p, i] = await Promise.all([
      api<Task[]>(`/tasks${id ? `?boardId=${id}` : ""}`),
      api<Principal[]>("/principals"),
      api<InboxItem[]>("/inbox"),
    ]);
    setTasks(t);
    setInbox(i);
    setPeople(Object.fromEntries(p.map((x) => [x.id, x])));
    setRev((r) => r + 1);
  }, [boardId]);

  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("change", () => load().catch(() => {}));
    return () => es.close();
  }, [load]);
  // Leases expire with the clock, not with events: re-evaluate stale/live badges every 30s.
  useEffect(() => { const i = setInterval(() => { tick((n) => n + 1); load().catch(() => {}); }, 30_000); return () => clearInterval(i); }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    act(async () => { await api("/tasks", { method: "POST", body: { title, boardId, confirmed: me.kind === "human" } }); setTitle(""); });
  };

  const select = (id: string) => { localStorage.setItem("kb_board", id); setBoardId(id); setOpen(null); };
  const newProject = () => {
    const name = prompt("Project name")?.trim();
    if (name) act(async () => select((await api<{ id: string }>("/boards", { method: "POST", body: { name } })).id));
  };
  const rename = () => {
    const cur = boards.find((b) => b.id === boardId);
    const name = prompt("Rename project", cur?.name)?.trim();
    if (name && cur) act(() => api(`/boards/${cur.id}`, { method: "PATCH", body: { name } }));
  };
  const current = boards.find((b) => b.id === boardId);
  const toggleLoop = () => {
    if (!current) return;
    const next = !current.humanInLoop;
    const msg = next
      ? `Require humans to confirm and approve in "${current.name}" again?`
      : `Run "${current.name}" autonomously? Agents will be able to confirm tasks and approve each other's work without any human. Agents still cannot approve their own work.`;
    if (confirm(msg)) act(() => api(`/boards/${current.id}`, { method: "PATCH", body: { humanInLoop: next } }));
  };

  const move = async (id: string, to: Status) => {
    const body: { to: Status; summary?: string } = { to };
    if (to === "review") {
      const s = askSummary();
      if (s === null) return;
      if (s) body.summary = s;
    }
    await act(() => api(`/tasks/${id}/move`, { method: "POST", body }));
  };

  const dropState = (col: Status) => {
    if (!dragging) return { cls: "", hint: undefined as string | undefined };
    const m = dragging.moves[col];
    if (m.ok) return { cls: "drop-ok", hint: "Drop to move here" };
    return { cls: "drop-no", hint: col === dragging.status ? undefined : m.reason };
  };

  const visible = tasks.filter((t) => !assignee || t.assigneeId === assignee || (assignee === "none" && !t.assigneeId));
  const assignees = Object.values(people).filter((p) => tasks.some((t) => t.assigneeId === p.id));

  const card = (t: Task) => {
    const who = t.assigneeId ? people[t.assigneeId] : undefined;
    const left = leaseMinutesLeft(t);
    return (
      <article
        key={t.id}
        draggable
        tabIndex={0}
        className={`card p${t.priority} s-${t.status}${isStale(t) ? " stale" : ""}${t.needsInput ? " asking" : ""}`}
        onDragStart={(e) => { e.dataTransfer.setData("text/plain", t.id); setDragging(t); }}
        onDragEnd={() => setDragging(null)}
        onClick={() => setOpen(t.id)}
        onKeyDown={(e) => e.key === "Enter" && setOpen(t.id)}
      >
        <div className="ct">{t.title}</div>
        {t.status === "review" && t.reviewSummary && <div className="clamp">{t.reviewSummary}</div>}
        <div className="meta">
          {t.priority >= 3 && <span className="chip hot">P{t.priority}</span>}
          {t.labels.map((l) => <span key={l} className="label">{l}</span>)}
          {who && (
            <span className={`who ${who.kind}`}>
              {isLive(t) && <i className="pulse" title="Agent is active; its lease renews on every sign of life" />}
              {who.name}
            </span>
          )}
          {isStale(t) && <span className="chip warn" title="The agent's claim lease expired; another agent may take it over">stale{left !== null ? ` ${-left}m` : ""}</span>}
          {isLive(t) && left !== null && <span className="lease">lease {left}m</span>}
          {t.status === "review" && t.reviewLinks.length > 0 && <span className="lease strong">{t.reviewLinks.length} link{t.reviewLinks.length > 1 ? "s" : ""}</span>}
        </div>
        {isLive(t) && left !== null && <div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, (left / leaseTotal) * 100))}%` }} /></div>}
        {t.needsInput && <div className="chip ask block" title={t.question ?? ""}>Needs input: {t.question}</div>}
        {t.status === "proposed" && t.moves.confirmed.ok && (
          <button className="confirm" onClick={(e) => { e.stopPropagation(); move(t.id, "confirmed"); }}>Confirm</button>
        )}
      </article>
    );
  };

  return (
    <main className="board-page">
      <div className="toolbar">
        <div className="projects" role="tablist" aria-label="Projects">
          {boards.map((b) => (
            <button key={b.id} role="tab" aria-selected={b.id === boardId} className={b.id === boardId ? "active" : ""} onClick={() => select(b.id)}>{b.name}</button>
          ))}
          {me.kind === "human" && <button className="ghost" onClick={newProject}>+ Project</button>}
          {me.kind === "human" && boards.length > 0 && <button className="ghost" onClick={rename} title="Rename project" aria-label="Rename project">✎</button>}
        </div>
        <span className="spacer" />
        {current && !current.humanInLoop && <span className="chip auto" title="No human confirmation or approval is required in this project">autonomous</span>}
        {me.kind === "human" && me.role === "admin" && current && (
          <button onClick={toggleLoop} title="Whether a human must confirm tasks and approve reviews">{current.humanInLoop ? "Humans in loop: on" : "Humans in loop: off"}</button>
        )}
      </div>

      <Inbox items={inbox} boards={boards} people={people} onOpen={setOpen} act={act} move={move} />

      <div className="filters">
        <form className="newtask" onSubmit={add}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={me.kind === "human" ? "New task (created confirmed)…" : "New task (starts as proposed)…"} aria-label="New task title" />
          <button className="primary">Add task</button>
        </form>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Filter by assignee">
          <option value="">All assignees</option>
          <option value="none">Unassigned</option>
          {assignees.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}

      <div className="columns">
        {COLUMNS.map((col) => {
          const { cls, hint } = dropState(col.status);
          const items = visible.filter((t) => t.status === col.status);
          const collapsed = col.status === "done" && !showDone && !dragging;
          return (
            <section
              key={col.status}
              className={`${cls} col-${col.status}${collapsed ? " collapsed" : ""}`}
              title={hint}
              aria-label={col.title}
              onDragOver={(e) => dragging?.moves[col.status].ok && e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const t = dragging; setDragging(null); if (t?.moves[col.status].ok) move(t.id, col.status); }}
            >
              <h2>
                {col.title} <small>{items.length}</small>
                {col.status === "done" && items.length > 0 && <button className="linklike" onClick={() => setShowDone((v) => !v)}>{showDone ? "hide" : "show"}</button>}
              </h2>
              {dragging && cls === "drop-no" && hint && <p className="why">{hint}</p>}
              {!collapsed && items.map(card)}
            </section>
          );
        })}
      </div>
      {open && <TaskDrawer id={open} me={me} people={people} rev={rev} onClose={() => setOpen(null)} onChange={load} />}
    </main>
  );
}
