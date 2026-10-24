import * as client from "openid-client";
import { getSignedCookie, setSignedCookie, deleteCookie } from "hono/cookie";
import { Hono } from "hono";
import { createOrg, listOrgs, promoteFirstHuman, upsertOidcPrincipal, type Db } from "@kanban/core";
import type { Config } from "../config.js";

const required = <T,>(v: T | null): T => { if (!v) throw new Error("OIDC is not configured"); return v; };
import { SESSION_COOKIE, setSession } from "./session.js";

const FLOW_COOKIE = "kb_oidc";

/** Authorization Code + PKCE login for humans. Discovery is lazy so the server can start before the IdP is up. */
export function oidcRoutes(db: Db, config: Config) {
  const cfg = { ...config, oidc: required(config.oidc) };
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

  // Lets the login page name the provider ("Sign in with Google") without knowing the issuer.
  const provider = /(^|\.)google\.com$/.test(new URL(cfg.oidc.issuer).hostname) ? "google" : "oidc";
  app.get("/auth/info", (c) => c.json({ provider }));

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
    // With open sign-up an unverified email must not count: invites are pinned to emails.
    const ident = { issuer: cfg.oidc.issuer, sub: claims.sub, kind: "human" as const, name, email: cfg.multiTenant ? trusted : email };
    const admins = trusted ? cfg.adminEmails.filter((a) => a.toLowerCase() === trusted.toLowerCase()) : [];
    let pid: string;
    if (cfg.multiTenant) {
      // Everyone gets a workspace of their own on first sign-in; further ones come via invites or "new organization".
      const u = await upsertOidcPrincipal(db, ident, admins, null);
      if (!(await listOrgs(db, u.id)).length) await createOrg(db, u.id, `${name}'s workspace`);
      pid = u.id;
    } else {
      pid = (await promoteFirstHuman(db, await upsertOidcPrincipal(db, ident, admins))).id;
    }
    await setSession(c, cfg, pid);
    return c.redirect("/");
  });

  app.post("/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  return app;
}
