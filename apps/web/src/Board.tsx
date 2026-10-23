import { useCallback, useEffect, useRef, useState } from "react";
import { COLUMNS, api, type Principal, type Status, type Task } from "./api";
import { TaskDrawer } from "./TaskDrawer";

export function Board({ me }: { me: Principal }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [people, setPeople] = useState<Record<string, Principal>>({});
  const [boards, setBoards] = useState<{ id: string; name: string }[]>([]);
  const [boardId, setBoardId] = useState<string | undefined>(() => localStorage.getItem("kb_board") ?? undefined);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [rev, setRev] = useState(0);
  const openRef = useRef(open);
  openRef.current = open;

  const load = useCallback(async () => {
    const all = await api<{ id: string; name: string }[]>("/boards");
    setBoards(all);
    const id = all.find((b) => b.id === boardId)?.id ?? all[0]?.id;
    if (id !== boardId) setBoardId(id);
    const [t, p] = await Promise.all([api<Task[]>(`/tasks${id ? `?boardId=${id}` : ""}`), api<Principal[]>("/principals")]);
    setTasks(t);
    setPeople(Object.fromEntries(p.map((x) => [x.id, x])));
    setRev((r) => r + 1);
  }, [boardId]);

  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("change", () => load().catch(() => {}));
    return () => es.close();
  }, [load]);

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

  const move = (id: string, to: Status) => act(() => api(`/tasks/${id}/move`, { method: "POST", body: { to } }));

  return (
    <main>
      <div className="projects">
        {boards.map((b) => (
          <button key={b.id} className={b.id === boardId ? "active" : ""} onClick={() => select(b.id)}>{b.name}</button>
        ))}
        {me.kind === "human" && <button onClick={newProject}>+ New project</button>}
        {me.kind === "human" && boards.length > 0 && <button onClick={rename} title="Rename project">✎</button>}
      </div>
      <form className="newtask" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task (humans create it pre-confirmed)…" />
        <button className="primary">Add</button>
      </form>
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
      <div className="columns">
        {COLUMNS.map((col) => (
          <section
            key={col.status}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { const id = e.dataTransfer.getData("text/plain"); if (id) move(id, col.status); }}
          >
            <h3>{col.title} <small>{tasks.filter((t) => t.status === col.status).length}</small></h3>
            {tasks.filter((t) => t.status === col.status).map((t) => {
              const who = t.assigneeId ? people[t.assigneeId] : undefined;
              return (
                <article key={t.id} draggable className={`card p${t.priority}`} onDragStart={(e) => e.dataTransfer.setData("text/plain", t.id)} onClick={() => setOpen(t.id)}>
                  <div>{t.title}</div>
                  <div className="meta">
                    {t.labels.map((l) => <span key={l} className="label">{l}</span>)}
                    {who && <span className={`badge ${who.kind}`}>{who.kind === "agent" ? "🤖" : "👤"} {who.name}</span>}
                  </div>
                  {t.status === "proposed" && (
                    <button className="confirm" onClick={(e) => { e.stopPropagation(); move(t.id, "confirmed"); }}>Confirm</button>
                  )}
                </article>
              );
            })}
          </section>
        ))}
      </div>
      {open && <TaskDrawer id={open} me={me} people={people} rev={rev} onClose={() => setOpen(null)} onChange={load} />}
    </main>
  );
}
