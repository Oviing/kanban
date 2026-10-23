import type { Context } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import type { Config } from "../config.js";

export const SESSION_COOKIE = "kb_session";
const MAX_AGE = 60 * 60 * 12;

export async function setSession(c: Context, cfg: Config, principalId: string) {
  await setSignedCookie(c, SESSION_COOKIE, JSON.stringify({ pid: principalId, exp: Date.now() + MAX_AGE * 1000 }), cfg.sessionSecret, {
    httpOnly: true,
    secure: cfg.publicUrl.startsWith("https:"),
    sameSite: "Lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function readSession(c: Context, cfg: Config): Promise<string | null> {
  const raw = await getSignedCookie(c, cfg.sessionSecret, SESSION_COOKIE);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as { pid: string; exp: number };
    return s.exp > Date.now() ? s.pid : null;
  } catch {
    return null;
  }
}
