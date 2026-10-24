import { useCallback, useEffect, useState } from "react";
import { Avatar } from "./ui";
import { COLUMNS, ago, api, describeEvent, leaseMinutesLeft, type ActivityItem, type AgentRow, type Overview, type Principal } from "./api";

const STATE_LABEL = { working: "working", blocked: "blocked on you", stale: "silent", idle: "idle" } as const;

function Spark({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  return (
    <div className="bars" role="img" aria-label="Activity over the last hour">
      {data.map((v, i) => <i key={i} style={{ height: `${Math.max(8, (v / max) * 100)}%` }} />)}
    </div>
  );
}

function Lease({ task: t, total }: { task?: AgentRow["tasks"][number]; total: number }) {
  if (!t?.leaseExpiresAt) return <span className="mono dim">no claim</span>;
  const left = leaseMinutesLeft(t)!;
  const pct = Math.max(0, Math.min(100, (left / total) * 100));
  return (
    <div>
      <div className={`mono ${left < 0 ? "warn" : "ok"}`}>{left < 0 ? `expired ${-left}m ago` : `${left}m left`}</div>
      <div className="bar"><i className={left < 0 ? "warn" : ""} style={{ width: left < 0 ? "100%" : `${pct}%` }} /></div>
    </div>
  );
}

export function Agents({ me }: { me: Principal }) {
  const [boards, setBoards] = useState<{ id: string; name: string }[]>([]);
  const [boardId, setBoardId] = useState<string | undefined>(() => localStorage.getItem("kb_board") ?? undefined);
  const [ov, setOv] = useState<Overview>();
  const [feed, setFeed] = useState<ActivityItem[]>([]);
  const [actors, setActors] = useState<"all" | "agent" | "human">("all");
  const [error, setError] = useState<string>();
  const [live, setLive] = useState(false);
  const total = me.leaseMinutes ?? 30;

  const load = useCallback(async () => {
    const all = await api<{ id: string; name: string }[]>("/boards");
    setBoards(all);
    const id = all.find((b) => b.id === boardId)?.id ?? all[0]?.id;
    if (id !== boardId) setBoardId(id);
    const [o, f] = await Promise.all([api<Overview>(`/overview?boardId=${id}`), api<ActivityItem[]>(`/activity?boardId=${id}&limit=40`)]);
    setOv(o); setFeed(f);
  }, [boardId]);

  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.addEventListener("change", () => load().catch(() => {}));
    const i = setInterval(() => load().catch(() => {}), 20_000); // countdowns and "ago" drift with the clock
    return () => { es.close(); clearInterval(i); };
  }, [load]);

  const release = async (id: string) => {
    try { await api(`/tasks/${id}/move`, { method: "POST", body: { to: "confirmed" } }); await load(); } catch (e) { setError((e as Error).message); }
  };
  const k = ov?.kpis;
  const total23 = ov ? Object.values(ov.pipeline).reduce((a, b) => a + b, 0) : 0;
  const shown = feed.filter((e) => actors === "all" || e.actorKind === actors);

  return (
    <div className="mission">
      <div className="mission-in">
        <div className="mission-head">
          <h1>Agents</h1>
          <span className="livepill"><i className={live ? "pulse" : ""} />{live ? "Live · connected" : "Reconnecting…"}</span>
          <select aria-label="Project" value={boardId} onChange={(e) => { localStorage.setItem("kb_board", e.target.value); setBoardId(e.target.value); }}>
            {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        {error && <div className="error" onClick={() => setError(undefined)}>{error}</div>}

        <section className="kpis" aria-label="Summary">
          <div><span>Agents working</span><b>{k?.agentsActive ?? "–"}<small> / {k?.agentsTotal ?? "–"}</small></b></div>
          <div className={`needs${k?.waitingOnHuman ? " on" : ""}`}><span>Waiting on a human</span><b>{k?.waitingOnHuman ?? "–"}</b></div>
          <div className={`stalek${k?.staleLeases ? " on" : ""}`}><span>Stale leases</span><b>{k?.staleLeases ?? "–"}</b></div>
          <div><span>Done today</span><b>{k?.doneToday ?? "–"}</b></div>
        </section>

        <div className="mission-cols">
          <section className="lanes" aria-label="Agents">
            <div className="lane head"><span>Agent</span><span>Current task</span><span>Lease</span><span className="r">WIP</span></div>
            {ov?.agents.length === 0 && <p className="dim pad">No agents have connected yet. Create one under Keys, or point an MCP client at /mcp.</p>}
            {ov?.agents.map((a) => {
              const rank = (x: AgentRow["tasks"][number]) => ((leaseMinutesLeft(x) ?? 1) < 0 ? 0 : x.needsInput ? 1 : 2);
              const sorted = [...a.tasks].sort((x, y) => rank(x) - rank(y));
              const t = sorted[0];
              return (
                <div key={a.id} className={`lane ${a.state}`}>
                  <div className="who">
                    <Avatar name={a.name} size={34} />
                    <div><b>{a.name}</b><small className={a.state}>{STATE_LABEL[a.state]}{a.canConfirm ? " · can approve" : ""}</small></div>
                  </div>
                  <div className="cur">
                    {t ? <div className="tt">{t.title}</div> : <div className="dim">Last active {ago(a.lastActiveAt)}</div>}
                    {t?.needsInput && <div className="ask">{t.question}</div>}
                    {t && !t.needsInput && a.state !== "stale" && <Spark data={a.activity} />}
                    {a.state === "stale" && t && (
                      <div className="row-actions">
                        <button className="primary small" onClick={() => release(t.id)}>Release to board</button>
                      </div>
                    )}
                  </div>
                  <Lease task={t} total={total} />
                  <div className="r mono">{a.tasks.length}</div>
                </div>
              );
            })}
          </section>

          <aside className="feed" aria-label="Activity">
            <div className="feed-head">
              <span>Live activity</span>
              <select aria-label="Actors" value={actors} onChange={(e) => setActors(e.target.value as typeof actors)}>
                <option value="all">All actors</option><option value="agent">Agents</option><option value="human">Humans</option>
              </select>
            </div>
            <ul>
              {shown.map((e) => (
                <li key={e.id}>
                  <time className="mono dim">{new Date(e.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</time>
                  <span><b className={e.actorKind}>{e.actorName}</b> {describeEvent(e)} <b>{e.taskTitle}</b></span>
                </li>
              ))}
              {shown.length === 0 && <li className="dim">Nothing yet.</li>}
            </ul>
          </aside>
        </div>

        <section className="pipeline" aria-label="Pipeline">
          <div className="cap">Pipeline · {total23} tasks</div>
          <div className="pbar">
            {ov && COLUMNS.map((c) => ov.pipeline[c.status] > 0 && (
              <div key={c.status} className={`seg ${c.status}`} style={{ flexGrow: ov.pipeline[c.status] }}>{ov.pipeline[c.status]} {c.title.toLowerCase()}</div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
