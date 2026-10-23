import * as client from "openid-client";
import { getSignedCookie, setSignedCookie, deleteCookie } from "hono/cookie";
import { Hono } from "hono";
import { promoteFirstHuman, upsertOidcPrincipal, type Db } from "@kanban/core";
import type { Config } from "../config.js";
import { SESSION_COOKIE, setSession } from "./session.js";

const FLOW_COOKIE = "kb_oidc";

/** Authorization Code + PKCE login for humans. Discovery is lazy so the server can start before the IdP is up. */
export function oidcRoutes(db: Db, cfg: Config) {
  const app = new Hono();
  let discovered: Promise<client.Configuration> | undefined;
  const conf = () =>
    (discovered ??= client
      .discovery(
        new URL(cfg.oidc.issuer),
        cfg.oidc.clientId,
        cfg.oidc.clientSecret,
        cfg.oidc.clientSecret ? undefined : client.None(),
        cfg.oidc.allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((e) => {
        discovered = undefined;
        throw e;
      }));
  const redirectUri = `${cfg.publicUrl}/auth/callback`;
  const secure = cfg.publicUrl.startsWith("https:");

  app.get("/auth/login", async (c) => {
    const config = await conf();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: cfg.oidc.scope,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    await setSignedCookie(c, FLOW_COOKIE, JSON.stringify({ verifier, state, nonce }), cfg.sessionSecret, {
      httpOnly: true, secure, sameSite: "Lax", path: "/auth", maxAge: 600,
    });
    return c.redirect(url.href);
  });

  app.get("/auth/callback", async (c) => {
    const raw = await getSignedCookie(c, cfg.sessionSecret, FLOW_COOKIE);
    deleteCookie(c, FLOW_COOKIE, { path: "/auth" });
    if (!raw) return c.text("Login session expired, please try again", 400);
    const flow = JSON.parse(raw) as { verifier: string; state: string; nonce: string };
    const config = await conf();
    let tokens;
    try {
      tokens = await client.authorizationCodeGrant(config, new URL(c.req.url.replace(/^http:/, secure ? "https:" : "http:")), {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
      });
    } catch (e) {
      return c.text(`Login failed: ${(e as Error).message}`, 400);
    }
    const claims = tokens.claims()!;
    let email = (claims.email as string | undefined) ?? null;
    let name = (claims.name ?? claims.preferred_username ?? email ?? claims.sub) as string;
    if (!email && tokens.access_token) {
      try {
        const ui = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
        email = ui.email ?? null;
        name = (ui.name ?? name) as string;
      } catch {}
    }
    // Only trust the email for admin bootstrap if the IdP says it is verified.
    const trusted = claims.email_verified === true ? email : null;
    let p = await upsertOidcPrincipal(
      db,
      { issuer: cfg.oidc.issuer, sub: claims.sub, kind: "human", name, email },
      trusted ? cfg.adminEmails.filter((a) => a.toLowerCase() === trusted.toLowerCase()) : [],
    );
    p = await promoteFirstHuman(db, p);
    await setSession(c, cfg, p.id);
    return c.redirect("/");
  });

  app.post("/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  return app;
}
