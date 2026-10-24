import type { ActivityItem, AgentRow, Principal } from "./api";

export const PRIORITY_LABEL = ["", "Low", "Medium", "High", "Urgent"] as const;
const PRIORITY_WORDS: Record<string, number> = { low: 1, med: 2, medium: 2, high: 3, urgent: 4 };

export interface Capture { title: string; priority?: number; assigneeId?: string; boardId?: string }

/**
 * Quick-capture grammar: "Fix login !high @nova #atlas".
 * Tokens that don't resolve to a priority, person or project stay in the title.
 */
export function parseCapture(input: string, people: Principal[], boards: { id: string; name: string }[]): Capture {
  const out: Capture = { title: "" };
  const words: string[] = [];
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  const pick = <T extends { name: string }>(list: T[], q: string): T | undefined => {
    const key = norm(q);
    if (!key) return undefined;
    const exact = list.find((x) => norm(x.name) === key);
    if (exact) return exact;
    const pre = list.filter((x) => norm(x.name).startsWith(key));
    return pre.length === 1 ? pre[0] : undefined;
  };
  for (const w of input.trim().split(/\s+/)) {
    if (w.startsWith("!") && out.priority === undefined && w.slice(1).toLowerCase() in PRIORITY_WORDS) out.priority = PRIORITY_WORDS[w.slice(1).toLowerCase()];
    else if (w.startsWith("@") && !out.assigneeId && pick(people, w.slice(1))) out.assigneeId = pick(people, w.slice(1))!.id;
    else if (w.startsWith("#") && !out.boardId && pick(boards, w.slice(1))) out.boardId = pick(boards, w.slice(1))!.id;
    else words.push(w);
  }
  out.title = words.join(" ").trim();
  return out;
}

export type SegKind = "working" | "review" | "done" | "released" | "stale";
export interface TimelineSeg { left: number; width: number; kind: SegKind; label: string; taskId: string }
export interface TimelineMark { left: number; kind: "question" | "comment"; taskId: string }
export interface Lane { agent: AgentRow; segs: TimelineSeg[]; marks: TimelineMark[] }

/** One lane per agent for the last `windowMin` minutes, derived from the activity feed (newest first) and current task state. */
export function buildTimeline(agents: AgentRow[], feed: ActivityItem[], now: number, windowMin = 60): Lane[] {
  const start = now - windowMin * 60_000;
  const pos = (t: number) => Math.max(0, Math.min(100, ((t - start) / (now - start)) * 100));
  const events = [...feed].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return agents.map((agent) => {
    const segs: TimelineSeg[] = [];
    const marks: TimelineMark[] = [];
    const seen = new Set<string>();
    for (const e of events) {
      const at = new Date(e.createdAt).getTime();
      if (e.actorName !== agent.name || e.actorKind !== "agent") continue;
      if (at >= start && e.type === "input_requested") marks.push({ left: pos(at), kind: "question", taskId: e.taskId });
      if (at >= start && e.type === "commented") marks.push({ left: pos(at), kind: "comment", taskId: e.taskId });
    }
    const claims = events.filter((e) => (e.type === "claimed" || e.type === "taken_over") && e.actorName === agent.name && e.actorKind === "agent");
    for (const c of claims) {
      const from = new Date(c.createdAt).getTime();
      const next = events.find((e) => e.taskId === c.taskId && e.id > c.id && (e.type === "moved" || e.type === "released"));
      const to = next ? new Date(next.createdAt).getTime() : now;
      if (to < start) continue;
      const task = agent.tasks.find((t) => t.id === c.taskId);
      const kind: SegKind = !next ? (agent.state === "stale" && task ? "stale" : "working")
        : next.type === "released" ? "released"
        : next.payload.to === "review" ? "review"
        : next.payload.to === "done" ? "done" : "released";
      const left = pos(from);
      segs.push({ left, width: Math.max(1.5, pos(to) - left), kind, label: c.taskTitle, taskId: c.taskId });
      seen.add(c.taskId);
    }
    // Claims older than the window still show as a bar from the left edge.
    for (const t of agent.tasks) {
      if (seen.has(t.id) || t.status !== "in_progress") continue;
      segs.push({ left: 0, width: 100, kind: agent.state === "stale" ? "stale" : "working", label: t.title, taskId: t.id });
    }
    return { agent, segs, marks };
  });
}
