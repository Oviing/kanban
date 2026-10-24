import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Principal } from "./api";
import { Board } from "./Board";
import { Agents } from "./Agents";
import { Admin } from "./Admin";
import { Avatar, Kbd, isTyping } from "./ui";
import { DialogHost } from "./dialog";
import { Palette } from "./Palette";
import { navigate, useRoute, type Page } from "./route";
import { NEXT_THEME, useTheme } from "./theme";

const SHORTCUTS: [string, string][] = [
  ["⌘K  or  Ctrl K", "Command palette"], ["c", "New task"], ["j  /  k", "Next / previous card"], ["Enter", "Open the focused card"],
  ["[", "Show or hide Needs you"], ["g then b / a / k", "Go to Board / Agents / Keys"], ["Esc", "Close the open sheet or dialog"], ["?", "This list"],
];
const THEME_LABEL = { system: "System", light: "Light", dark: "Dark" } as const;

export function App() {
  const [me, setMe] = useState<Principal | null | undefined>(undefined);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [live, setLive] = useState<boolean | null>(null);
  const [theme, setTheme] = useTheme();
  const chord = useRef(0);
  const route = useRoute((localStorage.getItem("kb_page") as Page) || "board");
  const page = route.page;
  useEffect(() => { localStorage.setItem("kb_page", page); }, [page]);
  const go = useCallback((p: Page) => navigate(p === "board" ? { page: p, boardId: localStorage.getItem("kb_board") ?? undefined } : { page: p }), []);

  useEffect(() => {
    api<Principal>("/me").then(setMe, (e) => (e instanceof ApiError && e.status === 401 ? setMe(null) : Promise.reject(e)));
  }, []);
  useEffect(() => {
    if (!me) return;
    const es = new EventSource("/api/events");
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [me]);

  const logout = useCallback(async () => {
    await fetch("/auth/logout", { method: "POST", headers: { Origin: location.origin } });
    setMe(null);
  }, []);
  const newTask = useCallback(() => {
    // Off the board the capture bar isn't mounted yet: switch first, then focus it.
    go("board");
    setTimeout(() => window.dispatchEvent(new Event("kb:new-task")), page === "board" ? 0 : 60);
  }, [go, page]);
  const jumpTo = useCallback((boardId: string, taskId?: string) => navigate({ page: "board", boardId, taskId }, { task: !!taskId }), []);
  const cycleTheme = useCallback(() => setTheme(NEXT_THEME[theme]), [theme, setTheme]);

  useEffect(() => {
    if (!me) return;
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((o) => !o); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || palette) return;
      if (e.key === "?") { setHelp((o) => !o); return; }
      if (e.key === "Escape") { setHelp(false); return; }
      if (document.querySelector(".dlg")) return;
      if (e.key === "c") { e.preventDefault(); newTask(); return; }
      if (e.key === "g") { chord.current = Date.now(); return; }
      if (Date.now() - chord.current < 1000) {
        const p = ({ b: "board", a: "agents", k: "keys" } as Record<string, Page | undefined>)[e.key];
        chord.current = 0;
        if (p && (p !== "keys" || (me.role === "admin" && me.kind === "human"))) go(p);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [me, palette, go, newTask]);

  if (me === undefined) return <p className="center">Loading…</p>;
  if (me === null)
    return (
      <div className="center login">
        <h1>Agent Kanban</h1>
        <p>Humans and AI agents working the same board.</p>
        <a className="btn primary" href="/auth/login">Sign in with OpenID Connect</a>
      </div>
    );

  const canKeys = me.role === "admin" && me.kind === "human";
  const tab = (p: Page, label: string) => (
    <button className={page === p ? "active" : ""} aria-current={page === p ? "page" : undefined} onClick={() => go(p)}>{label}</button>
  );
  const tabs: [Page, string, string][] = [
    ["board", "Board", "M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v13h-4z"], ["agents", "Agents", "M12 4a4 4 0 100 8 4 4 0 000-8zM4 21c1-4 4-6 8-6s7 2 8 6"],
    ...(canKeys ? [["keys", "Keys", "M14 10a4 4 0 11-3.5 6L3 16v-3h3v-2h2l2.5-1.2A4 4 0 0114 10z"] as [Page, string, string]] : []),
  ];
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <strong className="brand"><span className="glyph"><i /></span>Kanban</strong>
        <nav className="seg" aria-label="Views">
          {tab("board", "Board")}
          {tab("agents", "Agents")}
          {canKeys && tab("keys", "Keys")}
        </nav>
        <div className="right">
          {live !== null && <span className="livepill" title={live ? "Connected, updates arrive instantly" : "Connection lost, retrying"}><i className={live ? "pulse" : "off"} />{live ? "Live" : "Reconnecting…"}</span>}
          <button className="search" onClick={() => setPalette(true)} aria-label="Open command palette (⌘K)">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.2" /><path d="M9.2 9.2L12 12" /></svg>
            <span>Search or jump to…</span><Kbd>⌘K</Kbd>
          </button>
          <button className="icon" onClick={cycleTheme} title={`Theme: ${THEME_LABEL[theme]} (click to change)`} aria-label={`Theme: ${THEME_LABEL[theme]}. Switch theme`}>
            <svg width="16" height="16" viewBox="0 0 14 14" fill={theme === "dark" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              {theme === "system" ? <><circle cx="7" cy="7" r="5" /><path d="M7 2a5 5 0 010 10z" fill="currentColor" /></> : theme === "light" ? <><circle cx="7" cy="7" r="2.6" /><path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.8 2.8l1 1M10.2 10.2l1 1M2.8 11.2l1-1M10.2 3.8l1-1" strokeLinecap="round" /></> : <path d="M11.5 8.5A5 5 0 015.5 2.5a5 5 0 106 6z" />}
            </svg>
          </button>
          {me.authMode === "none" ? <span className="chip warn" title="Running without authentication">no auth</span> : <button className="btn plain" onClick={logout}>Sign out</button>}
          <span title={`${me.name}${me.role === "admin" ? " (admin)" : ""}`}><Avatar name={me.name} kind="human" size={28} /></span>
        </div>
      </header>
      <div id="main">
        {page === "board" && <Board me={me} route={route} />}
        {page === "agents" && <Agents me={me} />}
        {page === "keys" && <Admin />}
      </div>
      <nav className="tabbar" aria-label="Main">
        {tabs.map(([p, label, d]) => (
          <button key={p} className={page === p ? "on" : ""} aria-current={page === p ? "page" : undefined} onClick={() => go(p)}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>{label}
          </button>
        ))}
        <button onClick={() => setPalette(true)}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg>Search</button>
      </nav>
      {palette && <Palette me={me} onClose={() => setPalette(false)} onGo={go} onJump={jumpTo} onTheme={cycleTheme} themeLabel={THEME_LABEL[theme]} onNewTask={newTask} />}
      {help && (
        <>
          <div className="scrim dlg-scrim" onClick={() => setHelp(false)} />
          <div className="dlg help" role="dialog" aria-modal="true" aria-labelledby="help-title">
            <h2 id="help-title">Keyboard shortcuts</h2>
            <dl>{SHORTCUTS.map(([k, d]) => <div key={k}><dt><Kbd>{k}</Kbd></dt><dd>{d}</dd></div>)}</dl>
            <div className="dlg-actions"><button className="primary" autoFocus onClick={() => setHelp(false)}>Done</button></div>
          </div>
        </>
      )}
      <DialogHost />
    </>
  );
}
