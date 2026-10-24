import { describe, expect, it } from "vitest";
import { buildTimeline, parseCapture } from "../src/logic";
import type { ActivityItem, AgentRow, Principal } from "../src/api";

const people = [
  { id: "u1", kind: "human", name: "Joel", role: "admin" },
  { id: "a1", kind: "agent", name: "Nova", role: "member" },
  { id: "a2", kind: "agent", name: "Novak", role: "member" },
] as Principal[];
const boards = [{ id: "b1", name: "Atlas Migration" }, { id: "b2", name: "Website" }];

describe("parseCapture", () => {
  it("extracts priority, assignee and project and leaves the title", () => {
    expect(parseCapture("Fix login !high @joel #atlas", people, boards)).toEqual({ title: "Fix login", priority: 3, assigneeId: "u1", boardId: "b1" });
  });
  it("keeps unknown tokens in the title", () => {
    expect(parseCapture("Ship #123 @nobody !later", people, boards)).toEqual({ title: "Ship #123 @nobody !later" });
  });
  it("prefers exact names and ignores ambiguous prefixes", () => {
    expect(parseCapture("a @nova", people, boards).assigneeId).toBe("a1");
    expect(parseCapture("a @nov", people, boards).assigneeId).toBeUndefined();
  });
});

describe("buildTimeline", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const at = (min: number) => new Date(now - min * 60_000).toISOString();
  const agent = (over: Partial<AgentRow>): AgentRow => ({ id: "a1", name: "Nova", state: "working", lastActiveAt: null, activity: [], tasks: [], ...over });
  const ev = (id: number, type: string, min: number, payload: ActivityItem["payload"] = {}, taskId = "t1"): ActivityItem =>
    ({ id, type, payload, createdAt: at(min), taskId, taskTitle: "Task " + taskId, actorName: "Nova", actorKind: "agent" });

  it("turns claim to review into a purple-ready segment and question marks", () => {
    const [lane] = buildTimeline([agent({})], [ev(1, "claimed", 40), ev(2, "input_requested", 30), ev(3, "moved", 20, { to: "review" })], now);
    expect(lane.segs).toHaveLength(1);
    expect(lane.segs[0].kind).toBe("review");
    expect(lane.segs[0].left).toBeCloseTo(33.3, 0);
    expect(lane.segs[0].width).toBeCloseTo(33.3, 0);
    expect(lane.marks.map((m) => m.kind)).toEqual(["question"]);
  });
  it("shows an open claim as working, or stale when the agent is stale", () => {
    const t = { id: "t1", title: "x", status: "in_progress" as const, needsInput: false, question: null, leaseExpiresAt: null };
    const seg = buildTimeline([agent({ tasks: [t] })], [ev(1, "claimed", 10)], now)[0].segs[0];
    expect(seg.kind).toBe("working");
    expect(seg.width).toBeCloseTo(16.7, 0);
    expect(buildTimeline([agent({ state: "stale", tasks: [t] })], [ev(1, "claimed", 10)], now)[0].segs[0].kind).toBe("stale");
  });
  it("draws claims older than the window from the left edge", () => {
    const t = { id: "t9", title: "old", status: "in_progress" as const, needsInput: false, question: null, leaseExpiresAt: null };
    expect(buildTimeline([agent({ tasks: [t] })], [], now)[0].segs[0]).toMatchObject({ left: 0, width: 100, kind: "working" });
  });
});

import { parseInline, parseMarkdown } from "../src/markdown";

describe("markdown", () => {
  it("parses inline styles, links and mentions of known people", () => {
    expect(parseInline("**hi** `x` _y_ @Local user ok", ["Local user"]).map((n) => n.t)).toEqual(["b", "text", "code", "text", "i", "text", "mention", "text"]);
    expect(parseInline("see https://a.io/x, and [docs](https://b.io)")).toMatchObject([{ t: "text" }, { t: "a", href: "https://a.io/x" }, { t: "text" }, { t: "a", href: "https://b.io" }]);
  });
  it("never turns other schemes into links and leaves unknown mentions as text", () => {
    expect(parseInline("[x](javascript:alert(1)) @ghost").every((n) => n.t === "text")).toBe(true);
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([{ t: "text", v: "<img src=x onerror=alert(1)>" }]);
  });
  it("groups blocks: paragraphs, fenced code and lists", () => {
    const b = parseMarkdown("Intro\nline two\n\n- a\n- b\n\n1. one\n\n```\ncode **not bold**\n```");
    expect(b.map((x) => x.t)).toEqual(["p", "ul", "ol", "code"]);
    expect(b[1]).toMatchObject({ items: [[{ t: "text", v: "a" }], [{ t: "text", v: "b" }]] });
    expect(b[3]).toEqual({ t: "code", v: "code **not bold**" });
  });
});

import { parseRoute, routeHash } from "../src/route";

describe("routes", () => {
  it("round-trips board and task links", () => {
    for (const r of [{ page: "board" as const }, { page: "board" as const, boardId: "b1" }, { page: "board" as const, boardId: "b1", taskId: "t 1" }, { page: "agents" as const }, { page: "keys" as const }])
      expect(parseRoute(routeHash(r))).toEqual(r);
  });
  it("falls back for unknown or empty hashes", () => {
    expect(parseRoute("", "agents")).toEqual({ page: "agents" });
    expect(parseRoute("#/nope")).toEqual({ page: "board" });
  });
});
