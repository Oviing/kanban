import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey, type JWTPayload } from "jose";
import { upsertOidcPrincipal, verifyApiKey, type Db, type Principal } from "@kanban/core";

export interface BearerOptions {
  issuer: string;
  audience?: string;
  /** Key resolver; defaults to the issuer's JWKS. Injectable for tests. */
  getKey?: JWTVerifyGetKey;
  jwksUri?: () => Promise<string>;
}

async function discoverJwksUri(issuer: string): Promise<string> {
  const res = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  return ((await res.json()) as { jwks_uri: string }).jwks_uri;
}

/** Verify an OIDC access token and map it to an agent principal (auto-provisioned on first use). */
export function makeBearerAuth(db: Db, opts: BearerOptions) {
  let getKey = opts.getKey;
  const resolveKey: JWTVerifyGetKey = async (header, token) => {
    if (!getKey) {
      const uri = opts.jwksUri ? await opts.jwksUri() : await discoverJwksUri(opts.issuer);
      getKey = createRemoteJWKSet(new URL(uri));
    }
    return getKey(header, token);
  };

  return async function authenticate(token: string): Promise<Principal | null> {
    if (token.startsWith("kb_")) return verifyApiKey(db, token);
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, resolveKey, {
        issuer: opts.issuer,
        audience: opts.audience,
        algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384", "PS256", "EdDSA"],
      }));
    } catch {
      return null;
    }
    if (!payload.sub) return null;
    const p = payload as Record<string, unknown>;
    const name = String(p.preferred_username ?? p.client_id ?? p.azp ?? p.name ?? payload.sub);
    return upsertOidcPrincipal(db, { issuer: opts.issuer, sub: payload.sub, kind: "agent", name });
  };
}
