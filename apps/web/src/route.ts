import { useMemo, useSyncExternalStore } from "react";

export type Page = "board" | "agents" | "keys";
export interface Route { page: Page; boardId?: string; taskId?: string }

/** Hash routes need no server support: #/b/<board>[/t/<task>], #/agents, #/keys. */
export function parseRoute(hash: string, fallback: Page = "board"): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "agents") return { page: "agents" };
  if (parts[0] === "keys") return { page: "keys" };
  if (parts[0] === "b" && parts[1]) return { page: "board", boardId: parts[1], taskId: parts[2] === "t" ? parts[3] : undefined };
  if (parts[0] === "board") return { page: "board" };
  return { page: fallback };
}

export function routeHash(r: Route): string {
  if (r.page !== "board") return `#/${r.page}`;
  if (!r.boardId) return "#/board";
  return `#/b/${encodeURIComponent(r.boardId)}${r.taskId ? `/t/${encodeURIComponent(r.taskId)}` : ""}`;
}

export function navigate(r: Route, opts: { replace?: boolean; task?: boolean } = {}) {
  const h = routeHash(r);
  if (h === location.hash) return;
  // `task` marks the history entry that opened a task, so closing it can simply go back.
  if (opts.replace) history.replaceState(r.taskId ? { kbTask: true } : null, "", h);
  else history.pushState(opts.task ? { kbTask: true } : null, "", h);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Close an open task: step back if we pushed it, otherwise replace the entry. */
export function closeTask(r: Route) {
  if (history.state?.kbTask) history.back();
  else navigate({ page: "board", boardId: r.boardId }, { replace: true });
}

const subscribe = (cb: () => void) => { window.addEventListener("hashchange", cb); window.addEventListener("popstate", cb); return () => { window.removeEventListener("hashchange", cb); window.removeEventListener("popstate", cb); }; };

export function useRoute(fallback: Page): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  return useMemo(() => parseRoute(hash, fallback), [hash, fallback]);
}
