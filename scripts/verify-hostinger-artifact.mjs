/**
 * VERIFIES THE HOSTINGER ARTIFACT ACTUALLY RUNS.
 *
 * The build script calling this is the difference between "we produced a folder" and
 * "the folder works". It starts the packaged server exactly as the host would
 * (`node server.js`, from inside the artifact), then checks it serves the SPA and
 * answers the API. A bundle that was assembled correctly but cannot boot — the
 * `@crm/shared` and pdfmake failures from this phase — would pass every earlier
 * check and die here.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve("dist-hostinger");
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok, d });
  console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`);
};

// ---------------------------------------------------------------------------
console.log("artifact contents");
// ---------------------------------------------------------------------------
for (const path of ["server.js", "dist/server.js", "package.json", "web-dist/index.html", "node_modules"]) {
  check(`${path} exists`, existsSync(resolve(DIR, path)), "");
}

// `workspace:*` would make `npm install` impossible on the host. Catch it here.
const pkg = JSON.parse((await import("node:fs")).readFileSync(resolve(DIR, "package.json"), "utf8"));
const workspaceDeps = Object.entries(pkg.dependencies ?? {}).filter(([, v]) => String(v).startsWith("workspace:"));
check("no workspace: dependencies remain", workspaceDeps.length === 0, workspaceDeps.map(([k]) => k).join(", "));
check("the start script is plain node", pkg.scripts?.start === "node server.js", pkg.scripts?.start);

// ---------------------------------------------------------------------------
console.log("\nbooting the packaged server");
// ---------------------------------------------------------------------------
// A development environment is used so the local Supabase and localhost CORS pass
// the production guards. What is being tested is that the ARTIFACT boots and
// serves — not the production config, which has its own audit.
//
// The credentials are supplied explicitly because the artifact deliberately
// contains no .env: on the real host these come from the panel. Reading them from
// apps/api/.env keeps the artifact test pointed at the same local database the
// other suites use.
const localEnv = Object.fromEntries(
  (await import("node:fs"))
    .readFileSync("apps/api/.env", "utf8")
    .split("\n")
    .map((line) => line.match(/^([A-Z_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "").trim()]),
);

const child = spawn(process.execPath, ["server.js"], {
  cwd: DIR,
  env: {
    ...process.env,
    ...localEnv,
    NODE_ENV: "development",
    PORT: String(PORT),
    // Relative to the artifact, exactly as documented for the host panel.
    WEB_DIST_PATH: "./web-dist",
    LOG_LEVEL: "error",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += d.toString()));
child.stderr.on("data", (d) => (stderr += d.toString()));

const started = await new Promise((res) => {
  const timer = setTimeout(() => res(false), 25_000);
  const poll = setInterval(async () => {
    try {
      const r = await fetch(`${BASE}/health/live`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        clearInterval(poll);
        clearTimeout(timer);
        res(true);
      }
    } catch {}
  }, 500);
});

check("the packaged server started", started, started ? "" : stderr.slice(0, 300) || stdout.slice(0, 300));

if (started) {
  const shell = await fetch(`${BASE}/`).then((r) => r.text()).catch(() => "");
  check("it serves the SPA shell", shell.includes('id="root"'), `${shell.length} bytes`);
  check("the shell references a built asset", /\/assets\/index-[^"]+\.js/.test(shell));

  const deep = await fetch(`${BASE}/invoices/abc`).then((r) => r.text()).catch(() => "");
  check("a deep link returns the shell", deep.includes('id="root"'));

  const api = await fetch(`${BASE}/api/v1/clients`).catch(() => null);
  check("the API answers with JSON", api?.status === 401, String(api?.status));
  const apiBody = await api?.json().catch(() => null);
  check("...and it is not the HTML shell", Boolean(apiBody?.error), JSON.stringify(apiBody).slice(0, 80));

  const ready = await fetch(`${BASE}/health/ready`).then((r) => r.json()).catch(() => null);
  check("the database is reachable from the artifact", ready?.data?.database === "reachable", ready?.data?.database);
}

child.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 800));
if (!child.killed) child.kill("SIGKILL");

// A crash on shutdown is also a deployment bug.
check("no crash output during the run", !/uncaught|ERR_MODULE_NOT_FOUND|Cannot find module/i.test(stderr), stderr.slice(0, 200));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.n} — ${f.d}`);
  process.exit(1);
}
