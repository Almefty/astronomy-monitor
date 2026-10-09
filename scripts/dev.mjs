// Starts the local dev server (Vite + the Worker running in workerd).
//
// Why this wrapper exists: workerd's built-in certificate list does not yet trust the
// "Sectigo Public Server Authentication Root R46" chain used by *.jpl.nasa.gov, so the
// JPL Close Approach API fails locally with "internal error" (it works on Cloudflare).
// Node ships the current Mozilla root store; we hand it to workerd via NODE_EXTRA_CA_CERTS.
// Nothing is installed system-wide; the bundle lives in .wrangler/ (gitignored).
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, ".wrangler", "ca", "mozilla-roots.pem");
mkdirSync(path.dirname(bundle), { recursive: true });

let pem = rootCertificates.join("\n");
if (process.env.NODE_EXTRA_CA_CERTS) {
  try {
    pem += "\n" + readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8");
  } catch {
    /* ignore an unreadable user-provided bundle */
  }
}
writeFileSync(bundle, pem);

const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
const child = spawn(process.execPath, [vite, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, NODE_EXTRA_CA_CERTS: bundle },
});
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
