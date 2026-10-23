import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Principal } from "./api";
import { Board } from "./Board";
import { Admin } from "./Admin";

export function App() {
  const [me, setMe] = useState<Principal | null | undefined>(undefined);
  const [page, setPage] = useState<"board" | "admin">("board");

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

  return (
    <>
      <header>
        <strong>Agent Kanban</strong>
        <nav>
          <button className={page === "board" ? "active" : ""} onClick={() => setPage("board")}>Board</button>
          {me.role === "admin" && <button className={page === "admin" ? "active" : ""} onClick={() => setPage("admin")}>Agents &amp; keys</button>}
        </nav>
        <span className="spacer" />
        <span>{me.name}{me.role === "admin" && " (admin)"}</span>
        <button onClick={logout}>Sign out</button>
      </header>
      {page === "board" ? <Board me={me} /> : <Admin />}
    </>
  );
}
