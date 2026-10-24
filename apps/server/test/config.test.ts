import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("AUTH_MODE=none needs no other settings and binds to loopback", () => {
    const c = loadConfig({ AUTH_MODE: "none" });
    expect(c).toMatchObject({ authMode: "none", host: "127.0.0.1", oidc: null, publicUrl: "http://localhost:3000" });
    expect(c.databaseUrl).toBeUndefined();
  });
  it("refuses to expose no-auth beyond loopback unless explicitly allowed", () => {
    expect(() => loadConfig({ AUTH_MODE: "none", HOST: "0.0.0.0" })).toThrow(/ALLOW_NO_AUTH_REMOTE/);
    const c = loadConfig({ AUTH_MODE: "none", HOST: "0.0.0.0", ALLOW_NO_AUTH_REMOTE: "true", PUBLIC_URL: "http://203.0.113.7:3000" });
    expect(c.allowedHosts).toContain("203.0.113.7:3000");
  });
  it("oidc mode still requires its settings", () => {
    expect(() => loadConfig({})).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ PUBLIC_URL: "https://k", SESSION_SECRET: "short", OIDC_ISSUER: "i", OIDC_CLIENT_ID: "c" })).toThrow(/32/);
  });
  it("rejects unknown modes", () => expect(() => loadConfig({ AUTH_MODE: "nope" })).toThrow());
});
