import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COLUMNS, api, isLive, isStale, leaseMinutesLeft, type InboxItem, type Principal, type Status, type Task } from "./api";
import { TaskDrawer } from "./TaskDrawer";
import { InboxSidebar } from "./Inbox";
import { askName, askSummary } from "./prompts";
import { Avatar, Kbd, Ring, isTyping, useMedia } from "./ui";
import { PRIORITY_LABEL, parseCapture } from "./logic";
import type { Jump } from "./App";

interface BoardInfo { id: string; name: string }

export function Board({ me, jump }: { me: Principal; jump?: Jump }) {
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
  const [priority, setPriority] = useState(0);
  const [onlyMine, setOnlyMine] = useState(false);
  const [onlyStale, setOnlyStale] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [mobileCol, setMobileCol] = useState<Status>("in_progress");
  const [, tick] = useState(0);
  const capture = useRef<HTMLInputElement>(null);
  const narrow = useMedia("(max-width: 700px)");
  const [inboxOpen, setInboxOpen] = useState(() => {
    try { const v = localStorage.getItem("kb_inbox_open"); if (v !== null) return v === "1"; } catch {}
    return window.innerWidth >= 900;
  });
  const toggleInbox = useCallback(() => setInboxOpen((o) => { try { localStorage.setItem("kb_inbox_open", o ? "0" : "1"); } catch {} return !o; }), []);
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
  // The command palette can send us to a project and/or a task.
  useEffect(() => {
    if (!jump) return;
    localStorage.setItem("kb_board", jump.boardId);
    setBoardId(jump.boardId);
    setOpen(jump.taskId ?? null);
  }, [jump]);
  useEffect(() => {
    const focus = () => { capture.current?.focus(); capture.current?.scrollIntoView({ block: "nearest" }); };
    window.addEventListener("kb:new-task", focus);
    return () => window.removeEventListener("kb:new-task", focus);
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector(".dlg, .pal")) return;
      if (e.key === "[") return toggleInbox();
      if (e.key === "j" || e.key === "k") {
        const cards = [...document.querySelectorAll<HTMLElement>(".columns .card")].filter((c) => c.offsetParent !== null);
        if (!cards.length) return;
        const i = cards.indexOf(document.activeElement as HTMLElement);
        const next = e.key === "j" ? Math.min(cards.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
        e.preventDefault();
        cards[next].focus();
        cards[next].scrollIntoView({ block: "nearest" });
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [toggleInbox]);
  // Leases expire with the clock, not with events: re-evaluate stale/live badges every 30s.
  useEffect(() => { const i = setInterval(() => { tick((n) => n + 1); load().catch(() => {}); }, 30_000); return () => clearInterval(i); }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const cap = parseCapture(title, Object.values(people), boards);
    if (!cap.title) return;
    act(async () => {
      const t = await api<Task>("/tasks", { method: "POST", body: { title: cap.title, boardId: cap.boardId ?? boardId, priority: cap.priority, confirmed: true } });
      if (cap.assigneeId) await api(`/tasks/${t.id}/assign`, { method: "POST", body: { assigneeId: cap.assigneeId } });
      setTitle("");
    });
  };
  const preview = useMemo(() => (title.trim() ? parseCapture(title, Object.values(people), boards) : null), [title, people, boards]);

  const select = (id: string) => { localStorage.setItem("kb_board", id); setBoardId(id); setOpen(null); };
  const newProject = async () => {
    const name = (await askName("New project"))?.trim();
    if (name) act(async () => select((await api<{ id: string }>("/boards", { method: "POST", body: { name } })).id));
  };
  const rename = async () => {
    const cur = boards.find((b) => b.id === boardId);
    const name = (await askName("Rename project", cur?.name))?.trim();
    if (name && cur) act(() => api(`/boards/${cur.id}`, { method: "PATCH", body: { name } }));
  };
  const current = boards.find((b) => b.id === boardId);

  const move = async (id: string, to: Status) => {
    const body: { to: Status; summary?: string } = { to };
    if (to === "review") {
      const s = await askSummary();
      if (s === null) return;
      if (s) body.summary = s;
    }
    await act(() => api(`/tasks/${id}/move`, { method: "POST", body }));
  };

  const dropState = (col: Status) => {
    if (!dragging) return { cls: "", hint: undefined as string | undefined };
    const m = dragging.moves[col];
    if (m.ok) return { cls: "drop-ok", hint: col === "review" ? "Drop to move to Review · add a summary" : "Drop to move here" };
    return { cls: "drop-no", hint: col === dragging.status ? undefined : m.reason };
  };

  const waiting = useMemo(() => new Set(inbox.map((i) => i.task.id)), [inbox]);
  const staleCount = tasks.filter(isStale).length;
  const visible = tasks.filter((t) =>
    (!assignee || t.assigneeId === assignee || (assignee === "none" && !t.assigneeId)) &&
    (!priority || t.priority >= priority) && (!onlyMine || waiting.has(t.id)) && (!onlyStale || isStale(t)));
  const assignees = Object.values(people).filter((p) => tasks.some((t) => t.assigneeId === p.id));
  const filtered = !!assignee || !!priority || onlyMine || onlyStale;

  const card = (t: Task) => {
    const who = t.assigneeId ? people[t.assigneeId] : undefined;
    const left = leaseMinutesLeft(t);
    const stale = isStale(t);
    return (
      <article
        key={t.id}
        draggable
        tabIndex={0}
        className={`card p${t.priority} s-${t.status}${stale ? " stale" : ""}${t.needsInput ? " asking" : ""}${dragging?.id === t.id ? " dragging" : ""}`}
        onDragStart={(e) => { e.dataTransfer.setData("text/plain", t.id); setDragging(t); }}
        onDragEnd={() => setDragging(null)}
        onClick={() => setOpen(t.id)}
        onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && setOpen(t.id)}
      >
        <div className="ct">{t.title}</div>
        {t.needsInput && <div className="ask-box" title={t.question ?? ""}><b>{who ? `Question from ${who.name}` : "Question"}</b>{t.question}</div>}
        {t.status === "review" && t.reviewSummary && <div className="clamp">{t.reviewSummary}</div>}
        <div className="meta">
          {t.priority > 0 && <span className={`tag pr${t.priority}`}>{PRIORITY_LABEL[t.priority]}</span>}
          {t.labels.map((l) => <span key={l} className="label">{l}</span>)}
          {stale && <span className="tag warn" title="The agent's claim lease expired; another agent may take it over">Stale</span>}
          {t.status === "review" && t.reviewLinks.length > 0 && <a className="lnk" href={/^https?:/.test(t.reviewLinks[0]) ? t.reviewLinks[0] : undefined} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{t.reviewLinks.length} link{t.reviewLinks.length > 1 ? "s" : ""} ↗</a>}
        </div>
        {who && (
          <div className="foot">
            <Avatar name={who.name} kind={who.kind} size={22} />
            <span className="fname">{who.name}</span>
            {(isLive(t) || stale) && left !== null && (
              <span className={`lease${left < 10 ? " warn" : ""}`}>{left < 0 ? `silent ${-left} min` : `${left} min`}<Ring left={left} total={leaseTotal} /></span>
            )}
          </div>
        )}
        {t.status === "proposed" && t.moves.confirmed.ok && (
          <button className="confirm" onClick={(e) => { e.stopPropagation(); move(t.id, "confirmed"); }}>Confirm</button>
        )}
        {t.status === "review" && t.moves.done.ok && (
          <button className="confirm" onClick={(e) => { e.stopPropagation(); setOpen(t.id); }}>Review</button>
        )}
      </article>
    );
  };

  return (
    <main className="board-page">
      <div className="board-layout">
      <InboxSidebar open={inboxOpen} onToggle={toggleInbox} items={inbox} boards={boards} people={people} onOpen={setOpen} act={act} move={move} />
      <div className="board-main">
      <div className="toolbar">
        <h1 className="page-title">{current?.name ?? "Board"}</h1>
        <div className="projects" role="tablist" aria-label="Projects">
          {boards.map((b) => (
            <button key={b.id} role="tab" aria-selected={b.id === boardId} className={b.id === boardId ? "active" : ""} onClick={() => select(b.id)}>{b.name}</button>
          ))}
          {me.kind === "human" && <button className="ghost" onClick={newProject}>+ Project</button>}
          {me.kind === "human" && boards.length > 0 && <button className="ghost" onClick={rename} title="Rename project" aria-label="Rename project">✎</button>}
        </div>
        <span className="spacer" />
      </div>

      <div className="filters">
        <form className="newtask" onSubmit={add}>
          <input ref={capture} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task…  try  Fix login !high @nova #atlas" aria-label="New task title" aria-describedby="capture-help" />
          <Kbd>c</Kbd>
          <button className="primary" disabled={!preview?.title}>Add task</button>
        </form>
        <button className={`fchip${onlyMine ? " on" : ""}`} aria-pressed={onlyMine} onClick={() => setOnlyMine((v) => !v)}>Waiting on me · {waiting.size}</button>
        <button className={`fchip${onlyStale ? " on" : ""}`} aria-pressed={onlyStale} onClick={() => setOnlyStale((v) => !v)}>Stale · {staleCount}</button>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Filter by assignee">
          <option value="">Assignee: anyone</option>
          <option value="none">Unassigned</option>
          {assignees.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={priority} onChange={(e) => setPriority(Number(e.target.value))} aria-label="Filter by priority">
          <option value={0}>Priority: any</option>
          {[1, 2, 3, 4].map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]} or higher</option>)}
        </select>
        {filtered && <button className="linklike" onClick={() => { setAssignee(""); setPriority(0); setOnlyMine(false); setOnlyStale(false); }}>Clear filters</button>}
      </div>
      <p id="capture-help" className="capture-help" aria-live="polite">
        {preview && (preview.priority || preview.assigneeId || preview.boardId)
          ? <>Will create “{preview.title || "…"}”{preview.priority ? <> · <b>{PRIORITY_LABEL[preview.priority]}</b> priority</> : null}{preview.assigneeId ? <> · assigned to <b>{people[preview.assigneeId]?.name}</b></> : null}{preview.boardId ? <> · in <b>{boards.find((b) => b.id === preview.boardId)?.name}</b></> : null}</>
          : "Tasks are created confirmed. Use !low !med !high !urgent, @name to assign and #project to file elsewhere."}
      </p>
      {error && <div className="error" role="alert" onClick={() => setError(null)}>{error}</div>}

      <div className="colpick" role="tablist" aria-label="Columns">
        {COLUMNS.map((c) => (
          <button key={c.status} role="tab" aria-selected={mobileCol === c.status} className={mobileCol === c.status ? "on" : ""} onClick={() => setMobileCol(c.status)}>
            {c.title} <small>{visible.filter((t) => t.status === c.status).length}</small>
          </button>
        ))}
      </div>

      <div className="columns">
        {COLUMNS.map((col) => {
          const { cls, hint } = dropState(col.status);
          const items = visible.filter((t) => t.status === col.status);
          const collapsed = col.status === "done" && !showDone && !dragging && !(narrow && mobileCol === "done");
          return (
            <section
              key={col.status}
              className={`${cls} col-${col.status}${collapsed ? " collapsed" : ""}${mobileCol === col.status ? " mshow" : ""}`}
              aria-label={col.title}
              onDragOver={(e) => dragging?.moves[col.status].ok && e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const t = dragging; setDragging(null); if (t?.moves[col.status].ok) move(t.id, col.status); }}
            >
              <h2>
                <i className={`dot s-${col.status}`} />{col.title} <small>{items.length}</small>
                {col.status === "done" && items.length > 0 && !narrow && <button className="linklike" onClick={() => setShowDone((v) => !v)}>{showDone ? "hide" : "show"}</button>}
              </h2>
              {dragging && hint && <p className={`why ${cls === "drop-ok" ? "ok" : ""}`}>{hint}</p>}
              {!collapsed && items.map(card)}
              {!collapsed && items.length === 0 && !dragging && <p className="col-empty">{filtered ? "No matching tasks." : "Nothing here."}</p>}
            </section>
          );
        })}
      </div>
      </div>
      </div>
      {open && <TaskDrawer id={open} me={me} people={people} boardName={current?.name} rev={rev} onClose={() => setOpen(null)} onChange={load} />}
    </main>
  );
}
