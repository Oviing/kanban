export interface Config {
  port: number;
  databaseUrl: string;
  publicUrl: string;
  sessionSecret: string;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    /** Expected `aud` of agent bearer tokens. If unset, audience is not checked (not recommended). */
    audience?: string;
    scope: string;
    allowInsecure: boolean;
  };
  adminEmails: string[];
  leaseMinutes: number;
}

function req(env: NodeJS.ProcessEnv, k: string): string {
  const v = env[k];
  if (!v) throw new Error(`Missing required environment variable ${k}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = req(env, "PUBLIC_URL").replace(/\/$/, "");
  const sessionSecret = req(env, "SESSION_SECRET");
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: req(env, "DATABASE_URL"),
    publicUrl,
    sessionSecret,
    oidc: {
      issuer: req(env, "OIDC_ISSUER"),
      clientId: req(env, "OIDC_CLIENT_ID"),
      clientSecret: env.OIDC_CLIENT_SECRET || undefined,
      audience: env.OIDC_AUDIENCE || undefined,
      scope: env.OIDC_SCOPE ?? "openid profile email",
      allowInsecure: env.OIDC_ALLOW_INSECURE === "true",
    },
    leaseMinutes: Number(env.LEASE_MINUTES ?? 30),
    adminEmails: (env.OIDC_ADMIN_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}
