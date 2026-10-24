import { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar } from "./ui";
import { COLUMNS, ago, api, describeEvent, leaseMinutesLeft, type ActivityItem, type AgentRow, type Overview, type Principal } from "./api";
import { buildTimeline, type SegKind } from "./logic";
import { askAnswer } from "./prompts";
import { onChange } from "./events";

const STATE_LABEL = { working: "Working", blocked: "Waiting on you", stale: "Silent · lease expired", idle: "Idle" } as const;
const SEG_LABEL: Record<SegKind, string> = { working: "Working", review: "Sent to review", done: "Done", released: "Released", stale: "No heartbeat · lease expired" };
const AXIS = [["−60m", 0], ["−45m", 25], ["−30m", 50], ["−15m", 75]] as const;

export function Agents(_: { me: Principal }) {
  const [boards, setBoards] = useState<{ id: string; name: string }[]>([]);
  const [boardId, setBoardId] = useState<string | undefined>(() => localStorage.getItem("kb_board") ?? undefined);
  const [ov, setOv] = useState<Overview>();
  const [feed, setFeed] = useState<ActivityItem[]>([]);
  const [actors, setActors] = useState<"all" | "agent" | "human">("all");
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const all = await api<{ id: string; name: string }[]>("/boards");
    setBoards(all);
    const id = all.find((b) => b.id === boardId)?.id ?? all[0]?.id;
    if (id !== boardId) setBoardId(id);
    const [o, f] = await Promise.all([api<Overview>(`/overview?boardId=${id}`), api<ActivityItem[]>(`/activity?boardId=${id}&limit=200`)]);
    setOv(o); setFeed(f); setNow(Date.now());
  }, [boardId]);

  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  useEffect(() => {
    const off = onChange(() => load().catch(() => {}));
    const i = setInterval(() => load().catch(() => {}), 20_000); // countdowns and "ago" drift with the clock
    return () => { off(); clearInterval(i); };
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  };
  const release = (id: string) => run(() => api(`/tasks/${id}/move`, { method: "POST", body: { to: "confirmed" } }));
  const answer = async (id: string, question: string | null) => {
    const a = (await askAnswer(question))?.trim();
    if (a) run(() => api(`/tasks/${id}/answer`, { method: "POST", body: { answer: a } }));
  };

  const k = ov?.kpis;
  const lanes = useMemo(() => (ov ? buildTimeline(ov.agents, feed, now) : []), [ov, feed, now]);
  const total = ov ? Object.values(ov.pipeline).reduce((a, b) => a + b, 0) : 0;
  const shown = feed.filter((e) => actors === "all" || e.actorKind === actors).slice(0, 40);

  return (
    <div className="mission">
      <div className="mission-in">
        <div className="mission-head">
          <h1>Agents</h1>
          <span className="dim">Last 60 minutes</span>
          <select aria-label="Project" value={boardId} onChange={(e) => { localStorage.setItem("kb_board", e.target.value); setBoardId(e.target.value); }}>
            {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        {error && <div className="error" role="alert" onClick={() => setError(undefined)}>{error}</div>}

        <section className="kpis" aria-label="Summary">
          <div><span><i className="kdot" style={{ background: "var(--accent)" }} />Working</span><b>{k?.agentsActive ?? "–"}<small> / {k?.agentsTotal ?? "–"}</small></b></div>
          <div className={`needs${k?.waitingOnHuman ? " on" : ""}`}><span><i className="kdot" style={{ background: "var(--orange)" }} />Waiting on a human</span><b>{k?.waitingOnHuman ?? "–"}</b></div>
          <div className={`stalek${k?.staleLeases ? " on" : ""}`}><span><i className="kdot" style={{ background: "var(--orange)" }} />Stale leases</span><b>{k?.staleLeases ?? "–"}</b></div>
          <div><span><i className="kdot" style={{ background: "var(--green)" }} />Done today</span><b>{k?.doneToday ?? "–"}</b></div>
        </section>

        <div className="mission-cols">
          <section className="tl-card" aria-label="Run timeline">
            <div className="tl-head">
              <h2>Run timeline</h2>
              <ul className="legend" aria-label="Legend">
                <li><i className="sw working" />working</li><li><i className="sw question" />question</li><li><i className="sw review" />review</li><li><i className="sw done" />done</li><li><i className="sw stale" />stale</li>
              </ul>
            </div>
            <div className="tl-row axis"><span /><div className="axis-in" aria-hidden="true">{AXIS.map(([l, p]) => <span key={l} style={{ left: `${p}%` }}>{l}</span>)}<span className="nowl">now</span></div></div>
            {ov?.agents.length === 0 && <p className="dim pad">No agents have connected yet. Create one under Admin, or point an MCP client at /mcp.</p>}
            {lanes.map(({ agent: a, segs, marks }) => {
              const rank = (x: AgentRow["tasks"][number]) => ((leaseMinutesLeft(x) ?? 1) < 0 ? 0 : x.needsInput ? 1 : 2);
              const t = [...a.tasks].sort((x, y) => rank(x) - rank(y))[0];
              return (
                <div key={a.id} className={`tl-row lane-${a.state}`}>
                  <div className="tl-who">
                    <Avatar name={a.name} kind="agent" size={30} />
                    <div>
                      <b>{a.name}</b>
                      <small className={a.state}>{STATE_LABEL[a.state]}{a.state === "idle" ? ` · ${ago(a.lastActiveAt)}` : ""}</small>
                      {t && a.state !== "idle" && <small className="curtask" title={t.title}>{t.title}</small>}
                      {t && a.state === "stale" && <button className="primary small" onClick={() => release(t.id)}>Release to board</button>}
                      {t?.needsInput && <button className="primary small" onClick={() => answer(t.id, t.question)}>Answer</button>}
                    </div>
                  </div>
                  <div className="track" role="img" aria-label={`${a.name}: ${segs.map((s) => `${s.label} (${SEG_LABEL[s.kind].toLowerCase()})`).join(", ") || "no runs in the last hour"}`}>
                    {segs.map((s, i) => (
                      <div key={i} className={`tseg ${s.kind}`} style={{ left: `${s.left}%`, width: `${s.width}%` }} title={`${s.label} · ${SEG_LABEL[s.kind]}`}>{s.width > 12 ? (s.kind === "stale" ? "no heartbeat — lease expired" : s.label) : ""}</div>
                    ))}
                    {marks.map((m, i) => <i key={i} className={`mk ${m.kind}`} style={{ left: `${m.left}%` }} title={m.kind === "question" ? "Asked a question" : "Commented"} />)}
                    <i className="nowline" />
                  </div>
                </div>
              );
            })}
            <div className="pipeline-in">
              <div className="cap">Pipeline · {total} tasks</div>
              <div className="pbar">
                {ov && COLUMNS.map((c) => ov.pipeline[c.status] > 0 && (
                  <div key={c.status} className={`seg ${c.status}`} style={{ flexGrow: ov.pipeline[c.status] }}>{ov.pipeline[c.status]} {c.title.toLowerCase()}</div>
                ))}
              </div>
            </div>
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
                  <Avatar name={e.actorName} kind={e.actorKind} size={22} />
                  <span className="ftext"><b className={e.actorKind}>{e.actorName}</b> {describeEvent(e)} <b>{e.taskTitle}</b></span>
                  <time className="dim">{ago(e.createdAt).replace(" ago", "")}</time>
                </li>
              ))}
              {shown.length === 0 && <li className="dim">Nothing yet.</li>}
            </ul>
          </aside>
        </div>
      </div>
    </div>
  );
}
