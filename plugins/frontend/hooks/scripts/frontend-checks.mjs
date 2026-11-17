#!/usr/bin/env node
// Runs the project's lint, typecheck and test scripts when the agent stops,
// and asks it to keep working if any of them fail.
//
//   frontend-checks.mjs baseline   (SessionStart) remember the current state
//   frontend-checks.mjs check      (Stop)         run checks if files changed
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
  const input = readInput();
  const root = findProjectRoot(input.cwd || process.cwd());
  if (!root) return;

  const statePath = stateFile(input.session_id, root);
  const state = readJson(statePath) || { fingerprint: null, attempts: 0 };

  if (mode === "baseline") {
    writeJson(statePath, { fingerprint: fingerprint(root), attempts: 0 });
    return;
  }
  if (mode !== "check") return;

  const before = fingerprint(root);
  if (before !== null && before === state.fingerprint) return;

  const checks = detectChecks(root);
  if (checks.length === 0) return;

  const results = await Promise.all(checks.map((c) => runCheck(c, root)));
  const failed = results.filter((r) => !r.ok);

  if (failed.length === 0) {
    writeJson(statePath, { fingerprint: fingerprint(root), attempts: 0 });
    return;
  }

  const names = failed.map((r) => r.name).join(", ");
  if (state.attempts >= MAX_BLOCKS) {
    // Give up on this state; check again once the files change.
    writeJson(statePath, { fingerprint: fingerprint(root), attempts: 0 });
    output({
      systemMessage: `Frontend checks still failing after ${MAX_BLOCKS} attempts: ${names}`,
    });
    return;
  }

  writeJson(statePath, { fingerprint: state.fingerprint, attempts: state.attempts + 1 });
  const details = failed
    .map((r) => `## ${r.name} failed: \`${r.command}\`\n\n${tail(r.output)}`)
    .join("\n\n");
  output({
    decision: "block",
    reason:
      `Frontend checks failed (${names}). Fix the problems below, then finish.\n\n` + details,
  });
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

function findProjectRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function stateFile(sessionId, root) {
  const key = createHash("sha256")
    .update(`${sessionId || "no-session"}\0${root}`)
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

// Hash of tracked changes plus untracked files, or null outside a git repo.
function fingerprint(root) {
  const git = (...args) =>
    spawnSync("git", args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });

  const inside = git("rev-parse", "--is-inside-work-tree");
  if (inside.status !== 0) return null;

  const hash = createHash("sha256");
  const hasHead = git("rev-parse", "--verify", "-q", "HEAD").status === 0;
  const diff = hasHead
    ? git("diff", "HEAD", "--binary", "--", ".")
    : git("diff", "--cached", "--binary", "--", ".");
  hash.update(diff.stdout || "");

  const untracked = git("ls-files", "-o", "--exclude-standard", "-z", "--", ".");
  for (const file of String(untracked.stdout || "").split("\0").filter(Boolean)) {
    try {
      const st = fs.statSync(path.join(root, file));
      hash.update(`\0${file}\0${st.size}\0${st.mtimeMs}`);
    } catch {
      hash.update(`\0${file}`);
    }
  }
  return hash.digest("hex");
}

function packageManager(root, pkg) {
  const declared = typeof pkg.packageManager === "string" && pkg.packageManager.split("@")[0];
  if (["pnpm", "yarn", "bun", "npm"].includes(declared)) return declared;
  const has = (f) => fs.existsSync(path.join(root, f));
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  return "npm";
}

function detectChecks(root) {
  const pkg = readJson(path.join(root, "package.json"));
  if (!pkg) return [];
  const scripts = pkg.scripts || {};
  const pm = packageManager(root, pkg);
  const script = (name) => ({ cmd: pm, args: ["run", name], command: `${pm} run ${name}` });
  const checks = [];

  if (scripts.lint) checks.push({ name: "lint", ...script("lint") });

  const typecheck = TYPECHECK_SCRIPTS.find((s) => scripts[s]);
  if (typecheck) {
    checks.push({ name: "typecheck", ...script(typecheck) });
  } else {
    const tsc = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
    if (fs.existsSync(path.join(root, "tsconfig.json")) && fs.existsSync(tsc)) {
      checks.push({ name: "typecheck", cmd: tsc, args: ["--noEmit"], command: "tsc --noEmit" });
    }
  }

  if (scripts.test && !scripts.test.includes(NPM_TEST_STUB)) {
    checks.push({ name: "test", ...script("test") });
  }
  return checks;
}

function runCheck(check, root) {
  return new Promise((resolve) => {
    let out = "";
    const append = (chunk) => {
      out += chunk;
      if (out.length > OUTPUT_TAIL * 4) out = out.slice(-OUTPUT_TAIL * 2);
    };
    const child = spawn(check.cmd, check.args, {
      cwd: root,
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
      resolve({ ...check, ok: false, output: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ...check, ok: code === 0, output: out });
    });
  });
}

function tail(text) {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL ? "…\n" + trimmed.slice(-OUTPUT_TAIL) : trimmed;
}
