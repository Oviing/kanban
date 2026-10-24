import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Principal } from "./api";
import { Board } from "./Board";
import { Agents } from "./Agents";
import { Admin } from "./Admin";
import { Avatar } from "./ui";

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

  const tab = (p: Page, label: string) => (
    <button className={page === p ? "active" : ""} aria-current={page === p ? "page" : undefined} onClick={() => go(p)}>{label}</button>
  );
  return (
    <>
      <header className="top">
        <strong className="brand"><span className="glyph"><i /></span>Kanban</strong>
        <nav className="seg" aria-label="Views">
          {tab("board", "Board")}
          {tab("agents", "Agents")}
          {me.role === "admin" && me.kind === "human" && tab("keys", "Keys")}
        </nav>
        <div className="right">
          {me.authMode === "none" ? <span className="chip warn" title="Running without authentication">no auth</span> : <button className="btn plain" onClick={logout}>Sign out</button>}
          <span title={`${me.name}${me.role === "admin" ? " (admin)" : ""}`}><Avatar name={me.name} kind="human" size={28} /></span>
        </div>
      </header>
      {page === "board" && <Board me={me} />}
      {page === "agents" && <Agents me={me} />}
      {page === "keys" && <Admin />}
    </>
  );
}
