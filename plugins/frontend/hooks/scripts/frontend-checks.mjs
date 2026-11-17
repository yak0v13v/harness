#!/usr/bin/env node
// Runs the project's lint, typecheck and test scripts when the agent stops,
// and asks it to keep working if any of them fail.
//
//   frontend-checks.mjs baseline   (SessionStart) remember the current state
//   frontend-checks.mjs check      (Stop)         run checks in changed packages
//
// Works in monorepos: every package.json in the git repository is a candidate
// package (the root one is optional). A changed file belongs to the nearest
// package above it that has checks, and only packages with changes are checked.
// Outside git, the nearest package.json above the working directory is checked
// on every stop.
//
// Set HARNESS_FRONTEND_CHECKS=0 to disable.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BLOCKS = 3;
const OUTPUT_TAIL = 4000;
const CHECK_TIMEOUT_MS = 540_000;
const TYPECHECK_SCRIPTS = ["typecheck", "type-check", "tsc", "types"];
const NPM_TEST_STUB = "no test specified";

main().catch(() => process.exit(0));

async function main() {
  if (process.env.HARNESS_FRONTEND_CHECKS === "0") return;

  const mode = process.argv[2];
  if (mode !== "baseline" && mode !== "check") return;

  const input = readInput();
  const cwd = path.resolve(input.cwd || process.cwd());
  const repo = gitRoot(cwd);
  const scope = repo || findProjectRoot(cwd);
  if (!scope) return;

  const statePath = stateFile(input.session_id, scope);
  const state = readJson(statePath) || { fingerprints: {}, attempts: 0 };
  const saved = state.fingerprints || {};

  const packages = repo ? discoverPackages(repo) : discoverSinglePackage(scope);
  if (packages.length === 0) return;

  if (mode === "baseline") {
    writeJson(statePath, { fingerprints: fingerprints(repo, packages), attempts: 0 });
    return;
  }

  const current = fingerprints(repo, packages);
  const changed = packages.filter((p) => !repo || current[p.rel] !== saved[p.rel]);
  if (changed.length === 0) return;

  const runs = changed.flatMap((p) => p.checks.map((c) => runCheck(c, p)));
  const results = await Promise.all(runs);
  const failed = results.filter((r) => !r.ok);
  const failedPackages = new Set(failed.map((r) => r.pkg.rel));

  // Packages that passed (or were unchanged) take their current state;
  // failed ones keep the saved state so the next stop checks them again.
  const after = fingerprints(repo, packages);
  const keep = (rels) => {
    const next = { ...after };
    for (const rel of rels) {
      if (saved[rel] === undefined) delete next[rel];
      else next[rel] = saved[rel];
    }
    return next;
  };

  if (failed.length === 0) {
    writeJson(statePath, { fingerprints: after, attempts: 0 });
    return;
  }

  const names = failed.map(label).join(", ");
  if (state.attempts >= MAX_BLOCKS) {
    // Give up on this state; check again once the files change.
    writeJson(statePath, { fingerprints: after, attempts: 0 });
    output({
      systemMessage: `Frontend checks still failing after ${MAX_BLOCKS} attempts: ${names}`,
    });
    return;
  }

  writeJson(statePath, { fingerprints: keep(failedPackages), attempts: state.attempts + 1 });
  const details = failed
    .map((r) => {
      const where = r.pkg.rel === "." ? "" : ` in \`${r.pkg.rel}/\``;
      return `## ${label(r)} failed: \`${r.command}\`${where}\n\n${tail(r.output)}`;
    })
    .join("\n\n");
  output({
    decision: "block",
    reason:
      `Frontend checks failed (${names}). Fix the problems below, then finish.\n\n` + details,
  });
}

function label(result) {
  return result.pkg.rel === "." ? result.name : `${result.pkg.rel}: ${result.name}`;
}

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

function output(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function git(cwd, ...args) {
  return spawnSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
}

function gitRoot(cwd) {
  const res = git(cwd, "rev-parse", "--show-toplevel");
  return res.status === 0 ? path.resolve(res.stdout.trim()) : null;
}

function findProjectRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function stateFile(sessionId, scope) {
  const key = createHash("sha256")
    .update(`${sessionId || "no-session"}\0${scope}`)
    .digest("hex")
    .slice(0, 32);
  return path.join(os.tmpdir(), "harness-frontend-checks", `${key}.json`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {
    // State is an optimisation; checks still work without it.
  }
}

// Every non-ignored package.json in the repository that has at least one check,
// deepest first so the nearest package wins when files are assigned.
function discoverPackages(repo) {
  const res = git(repo, "ls-files", "-co", "--exclude-standard", "-z", "--", ":(glob)**/package.json");
  if (res.status !== 0) return [];
  const rels = String(res.stdout)
    .split("\0")
    .filter((f) => f && !f.split("/").includes("node_modules"))
    .map((f) => path.posix.dirname(f));
  return [...new Set(rels)]
    .map((rel) => makePackage(path.join(repo, rel), rel, repo))
    .filter((p) => p.checks.length > 0)
    .sort((a, b) => depth(b.rel) - depth(a.rel));
}

function discoverSinglePackage(dir) {
  const pkg = makePackage(dir, ".", dir);
  return pkg.checks.length > 0 ? [pkg] : [];
}

function makePackage(dir, rel, top) {
  return { dir, rel, checks: detectChecks(dir, top) };
}

function depth(rel) {
  return rel === "." ? 0 : rel.split("/").length;
}

function owner(file, packages) {
  return packages.find((p) => p.rel === "." || file === p.rel || file.startsWith(p.rel + "/"));
}

// Per-package hash of the files that differ from HEAD (tracked changes plus
// untracked files). A package with no changes has no entry; empty outside git.
function fingerprints(repo, packages) {
  if (!repo) return {};
  const res = git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames");
  if (res.status !== 0) return {};

  const byPackage = new Map();
  for (const entry of String(res.stdout).split("\0")) {
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    const pkg = owner(file, packages);
    if (!pkg) continue;
    let sig;
    try {
      const st = fs.lstatSync(path.join(repo, file));
      sig = `${st.size}:${st.mtimeMs}`;
    } catch {
      sig = "missing";
    }
    if (!byPackage.has(pkg.rel)) byPackage.set(pkg.rel, []);
    byPackage.get(pkg.rel).push(`${code}\0${file}\0${sig}`);
  }

  const result = {};
  for (const [rel, lines] of byPackage) {
    result[rel] = createHash("sha256").update(lines.sort().join("\n")).digest("hex");
  }
  return result;
}

// Walks from dir up to top (inclusive), returning the first path that exists.
function findUp(dir, top, names) {
  let cur = dir;
  for (;;) {
    for (const name of names) {
      const candidate = path.join(cur, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (cur === top) return null;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function packageManager(dir, top, pkg) {
  const declared = typeof pkg.packageManager === "string" && pkg.packageManager.split("@")[0];
  if (["pnpm", "yarn", "bun", "npm"].includes(declared)) return declared;
  const lock = findUp(dir, top, ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "package-lock.json"]);
  const name = lock ? path.basename(lock) : "";
  if (name === "pnpm-lock.yaml") return "pnpm";
  if (name === "yarn.lock") return "yarn";
  if (name.startsWith("bun.")) return "bun";
  if (!lock && top !== dir) {
    // Workspace members often inherit packageManager from the root package.json.
    const rootPkg = readJson(path.join(top, "package.json"));
    const inherited = rootPkg && typeof rootPkg.packageManager === "string" && rootPkg.packageManager.split("@")[0];
    if (["pnpm", "yarn", "bun"].includes(inherited)) return inherited;
  }
  return "npm";
}

function detectChecks(dir, top) {
  const pkg = readJson(path.join(dir, "package.json"));
  if (!pkg) return [];
  const scripts = pkg.scripts || {};
  const pm = packageManager(dir, top, pkg);
  const script = (name) => ({ cmd: pm, args: ["run", name], command: `${pm} run ${name}` });
  const checks = [];

  if (scripts.lint) checks.push({ name: "lint", ...script("lint") });

  const typecheck = TYPECHECK_SCRIPTS.find((s) => scripts[s]);
  if (typecheck) {
    checks.push({ name: "typecheck", ...script(typecheck) });
  } else if (fs.existsSync(path.join(dir, "tsconfig.json"))) {
    const bin = process.platform === "win32" ? "tsc.cmd" : "tsc";
    const tsc = findUp(dir, top, [path.join("node_modules", ".bin", bin)]);
    if (tsc) checks.push({ name: "typecheck", cmd: tsc, args: ["--noEmit"], command: "tsc --noEmit" });
  }

  if (scripts.test && !scripts.test.includes(NPM_TEST_STUB)) {
    checks.push({ name: "test", ...script("test") });
  }
  return checks;
}

function runCheck(check, pkg) {
  return new Promise((resolve) => {
    let out = "";
    const append = (chunk) => {
      out += chunk;
      if (out.length > OUTPUT_TAIL * 4) out = out.slice(-OUTPUT_TAIL * 2);
    };
    const child = spawn(check.cmd, check.args, {
      cwd: pkg.dir,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const timer = setTimeout(() => {
      append(`\n[timed out after ${CHECK_TIMEOUT_MS / 1000}s]`);
      child.kill("SIGKILL");
    }, CHECK_TIMEOUT_MS);
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ...check, pkg, ok: false, output: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ...check, pkg, ok: code === 0, output: out });
    });
  });
}

function tail(text) {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL ? "…\n" + trimmed.slice(-OUTPUT_TAIL) : trimmed;
}
