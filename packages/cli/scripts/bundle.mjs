// Bundles the server (+ @kanban/core) into one file and copies the built web UI next to it.
import { build } from "esbuild";
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const webDist = here("../../../apps/web/dist");
if (!existsSync(webDist)) throw new Error("apps/web/dist missing: run `npm run build -w @kanban/web` first");

rmSync(here("../dist"), { recursive: true, force: true });
rmSync(here("../web"), { recursive: true, force: true });

await build({
  entryPoints: [here("../../../apps/server/src/index.ts")],
  outfile: here("../dist/server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  // Native/heavy deps stay external and are installed from this package's dependencies.
  external: ["pg", "pg-native", "@electric-sql/pglite", "jose", "openid-client"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
cpSync(webDist, here("../web"), { recursive: true });
console.log("bundled packages/cli/dist/server.js and web/");
