// Deploys main to collect.alazy.app from this PC. Run from the main checkout: node scripts/deploy.mjs [--check]
// --check runs only the checks that come before anything changes. --first is for the one deploy that brings the key check to a live
// worker that has none; it is refused once live reports a commit.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyGate, keyProblems } from "./deploy-lib.mjs";

const live = process.env.LIVE_URL ?? "https://collect.alazy.app";
const keysDir = process.env.COLLECT_KEYS_DIR ?? join(homedir(), "Desktop", "Keys", "lazycollect");
const checkOnly = process.argv.includes("--check");
const first = process.argv.includes("--first");
const win = process.platform === "win32";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: win, stdio: opts.show ? "inherit" : ["ignore", "pipe", "pipe"], cwd: opts.cwd });
  if (r.status !== 0) {
    if (opts.show) stop(`${cmd} ${args[0]} failed`);
    stop(`${cmd} ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? "").trim();
}

function stop(msg, head = "Not deployed") {
  console.error(`\n${head}: ${msg}`);
  process.exit(1);
}

const server = process.cwd();
const root = run("git", ["rev-parse", "--show-toplevel"]);
if (!server.replaceAll("\\", "/").endsWith("/server")) stop("run it from the server folder");

run("git", ["fetch", "-q", "origin", "main"]);
if (run("git", ["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") stop("not on main");
if (run("git", ["status", "--porcelain"])) stop("there are uncommitted changes");
const sha = run("git", ["rev-parse", "HEAD"]);
if (sha !== run("git", ["rev-parse", "origin/main"])) stop("main is not at origin/main (pull or push first)");
console.log(`main ${sha.slice(0, 7)} is origin/main`);

const runs = JSON.parse(run("gh", ["run", "list", "--workflow", "ci.yml", "--branch", "main", "--commit", sha, "--limit", "1", "--json", "status,conclusion,url"]));
if (!runs.length) stop("CI has not run on this commit");
if (runs[0].status !== "completed") stop(`CI is still ${runs[0].status}: ${runs[0].url}`);
if (runs[0].conclusion !== "success") stop(`CI on this commit is ${runs[0].conclusion}: ${runs[0].url}`);
console.log("CI is green on this commit");

const masterKey = readFileSync(join(keysDir, "master-key-na.txt"), "utf8").trim();
const hashKey = readFileSync(join(keysDir, "hash-key.txt"), "utf8").trim();

async function keyCheck() {
  const res = await fetch(`${live}/api/health/keys`, { headers: { "X-Key-Check": await keyGate(hashKey) } });
  return keyProblems(res.status, res.ok ? await res.json() : null, masterKey);
}

const before = await keyCheck();
if (before.length) {
  if (!first) stop(`${before.join("\n")}\n(the first deploy that brings the key check needs --first)`);
  const health = await (await fetch(`${live}/api/health`)).json();
  if ("commit" in health) stop("--first is refused: live already reports a commit, so its key check has to pass");
  console.log("live has no key check yet; it runs after this deploy");
} else console.log("live keys match the Keys folder and open the stored values");

if (checkOnly) process.exit(0);

const sitekey = process.env.VITE_TURNSTILE_SITEKEY ?? run("gh", ["variable", "get", "TURNSTILE_SITEKEY"]);
const web = join(root, "web");
// what goes out is what the lockfiles gave CI
run("npm", ["ci"], { cwd: server, show: true });
run("npm", ["ci"], { cwd: web, show: true });
run("bash", ["scripts/fetch_docaligner.sh"], { cwd: web, show: true });
process.env.VITE_TURNSTILE_SITEKEY = sitekey;
run("npm", ["run", "build"], { cwd: web, show: true });

// One-off for the deploy that brings US English as the base (control 0015, NA 0030). The old worker keeps writing 'en' rows until
// the new one is live; those, and only those, are Canadian too. Delete this block after that deploy.
const sql = (db, q) => JSON.parse(run("npx", ["wrangler", "d1", "execute", db, "--remote", "--json", "--command", q], { cwd: server }))[0].results;
const canadian = sql("lazycollect-control", "SELECT COUNT(*) AS n FROM d1_migrations WHERE name = '0015_canadian_english.sql'")[0].n === 0;
const migratedAt = Date.now();
for (const db of ["lazycollect-control", "lazycollect-na"]) run("npx", ["wrangler", "d1", "migrations", "apply", db, "--remote"], { cwd: server, show: true });
run("npx", ["wrangler", "deploy", "--var", `COMMIT:${sha}`], { cwd: server, show: true });
if (canadian) {
  const liveAt = Date.now();
  const between = `locale = 'en' AND created_at >= ${migratedAt} AND created_at <= ${liveAt}`;
  sql("lazycollect-control", `UPDATE firms SET locale = 'en-CA' WHERE ${between}`);
  for (const table of ["requests", "clients", "templates"]) sql("lazycollect-na", `UPDATE ${table} SET locale = 'en-CA' WHERE ${between}`);
  console.log("rows written by the old worker since the migrations are Canadian English now");
}

let named = false;
for (let i = 0; i < 10 && !named; i++) {
  named = (await (await fetch(`${live}/api/health`)).json()).commit === sha;
  if (!named) await new Promise((r) => setTimeout(r, 3000));
}
if (!named) stop("live does not name the new commit yet; check it by hand");
const after = await keyCheck();
if (after.length) stop(after.join("; "), "Deployed, but the key check failed");

mkdirSync(join(root, ".scratch"), { recursive: true });
appendFileSync(join(root, ".scratch", "deploys.log"), `${new Date().toISOString()} ${sha}\n`);
console.log(`live runs ${sha.slice(0, 7)} and the keys still match`);
