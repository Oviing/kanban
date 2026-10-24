export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** Expected `aud` of agent bearer tokens. If unset, audience is not checked (not recommended). */
  audience?: string;
  scope: string;
  allowInsecure: boolean;
}

export interface Config {
  /** "oidc": sign-in via OpenID Connect. "none": no authentication (local / private network only). */
  authMode: "oidc" | "none";
  host: string;
  port: number;
  /** Postgres URL. If unset, an embedded database is stored in `dataDir` (fine for local use and single-node deployments). */
  databaseUrl?: string;
  dataDir: string;
  publicUrl: string;
  sessionSecret: string;
  oidc: OidcConfig | null;
  /** Hostnames (host[:port]) this server answers to in no-auth mode; guards against DNS rebinding. */
  allowedHosts: string[];
  adminEmails: string[];
  leaseMinutes: number;
}

function req(env: NodeJS.ProcessEnv, k: string): string {
  const v = env[k];
  if (!v) throw new Error(`Missing required environment variable ${k}`);
  return v;
}

const isLoopback = (h: string) => ["127.0.0.1", "localhost", "::1"].includes(h);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authMode = (env.AUTH_MODE ?? "oidc") as Config["authMode"];
  if (authMode !== "oidc" && authMode !== "none") throw new Error(`AUTH_MODE must be "oidc" or "none"`);
  const port = Number(env.PORT ?? 3000);
  const noAuth = authMode === "none";
  const host = env.HOST ?? (noAuth ? "127.0.0.1" : "0.0.0.0");
  if (noAuth && !isLoopback(host) && env.ALLOW_NO_AUTH_REMOTE !== "true")
    throw new Error(
      `AUTH_MODE=none with HOST=${host} would expose an unauthenticated board beyond this machine. ` +
        `Bind to 127.0.0.1, or set ALLOW_NO_AUTH_REMOTE=true if the network itself restricts access (VPN, security group, SSH tunnel).`,
    );
  const publicUrl = (env.PUBLIC_URL ?? (noAuth ? `http://localhost:${port}` : req(env, "PUBLIC_URL"))).replace(/\/$/, "");
  const sessionSecret = env.SESSION_SECRET ?? (noAuth ? "" : req(env, "SESSION_SECRET"));
  if (!noAuth && sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const extraHosts = (env.ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    authMode,
    host,
    port,
    databaseUrl: env.DATABASE_URL || undefined,
    dataDir: env.DATA_DIR || "./data",
    publicUrl,
    sessionSecret,
    oidc: noAuth
      ? null
      : {
          issuer: req(env, "OIDC_ISSUER"),
          clientId: req(env, "OIDC_CLIENT_ID"),
          clientSecret: env.OIDC_CLIENT_SECRET || undefined,
          audience: env.OIDC_AUDIENCE || undefined,
          scope: env.OIDC_SCOPE ?? "openid profile email",
          allowInsecure: env.OIDC_ALLOW_INSECURE === "true",
        },
    allowedHosts: [new URL(publicUrl).host.toLowerCase(), `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, ...extraHosts],
    leaseMinutes: Number(env.LEASE_MINUTES ?? 30),
    adminEmails: (env.OIDC_ADMIN_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}
