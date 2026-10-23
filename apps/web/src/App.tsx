import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Principal } from "./api";
import { Board } from "./Board";
import { Agents } from "./Agents";
import { Admin } from "./Admin";

type Page = "board" | "agents" | "keys";

export function App() {
  const [me, setMe] = useState<Principal | null | undefined>(undefined);
  const [page, setPage] = useState<Page>(() => (localStorage.getItem("kb_page") as Page) || "board");
  const go = (p: Page) => { localStorage.setItem("kb_page", p); setPage(p); };

  useEffect(() => {
    api<Principal>("/me").then(setMe, (e) => (e instanceof ApiError && e.status === 401 ? setMe(null) : Promise.reject(e)));
  }, []);

  const logout = useCallback(async () => {
    await fetch("/auth/logout", { method: "POST", headers: { Origin: location.origin } });
    setMe(null);
  }, []);

  if (me === undefined) return <p className="center">Loading…</p>;
  if (me === null)
    return (
      <div className="center login">
        <h1>Agent Kanban</h1>
        <p>Humans and AI agents working the same board.</p>
        <a className="btn primary" href="/auth/login">Sign in with OpenID Connect</a>
      </div>
    );

  const initials = me.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const tab = (p: Page, label: string) => (
    <button className={page === p ? "active" : ""} aria-current={page === p ? "page" : undefined} onClick={() => go(p)}>{label}</button>
  );
  return (
    <>
      <header className={`top ${page === "agents" ? "dark" : ""}`}>
        <strong className="brand">Agent Kanban</strong>
        <nav aria-label="Views">
          {tab("board", "Board")}
          {tab("agents", "Agents")}
          {me.role === "admin" && me.kind === "human" && tab("keys", "Keys")}
        </nav>
        <span className="spacer" />
        {me.authMode === "none" ? <span className="chip warn" title="Running without authentication">no auth</span> : <button onClick={logout}>Sign out</button>}
        <span className="avatar" title={`${me.name}${me.role === "admin" ? " (admin)" : ""}`}>{initials}</span>
      </header>
      {page === "board" && <Board me={me} />}
      {page === "agents" && <Agents me={me} />}
      {page === "keys" && <Admin />}
    </>
  );
}
