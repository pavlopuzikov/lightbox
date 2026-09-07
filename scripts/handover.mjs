#!/usr/bin/env node
/**
 * Refresh .lightbox/handover.json from git and the sweep output, and write the
 * human copy, .lightbox/HANDOVER.md.
 *
 *   node scripts/handover.mjs [--key <key>] [--branch audit/front-end-2026-09]
 *
 * For each project on disk with a git checkout it records the current branch,
 * the audit branch's commits above its base, and the totals from
 * .lightbox/audit/<key>.json (plus <key>.after.json when a fix pass has run).
 * Fields a person writes by hand (status, note, tierC, lighthouse, approved,
 * pushed, pr) are never touched here: set() merges shallowly and this script only
 * passes what it computed.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, buildCatalogue } from "../src/catalogue.mjs";
import { Handover, summarise, metric } from "../src/handover.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : true;
}
const BRANCH = args.branch || "audit/front-end-2026-09";
const GROUP_ORDER = ["personal", "ventures", "tools", "work"];

function git(dir, ...a) {
  try {
    return execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).trim();
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function gitFacts(project, entry) {
  if (!project.exists || !fs.existsSync(path.join(project.dir, ".git")) && git(project.dir, "rev-parse", "--git-dir") === null) {
    return { current: null, branch: null, commits: [], base: entry?.base || null };
  }
  const current = git(project.dir, "rev-parse", "--abbrev-ref", "HEAD");
  const hasAudit = git(project.dir, "rev-parse", "--verify", "--quiet", BRANCH) !== null;
  if (!hasAudit) return { current, branch: null, commits: [], base: entry?.base || null };

  let base = entry?.base || null;
  if (!base) {
    for (const ref of ["origin/main", "origin/master", "main", "master"]) {
      const sha = git(project.dir, "merge-base", BRANCH, ref);
      if (sha) {
        base = { branch: ref, sha: sha.slice(0, 7) };
        break;
      }
    }
  }
  const range = base ? `${base.sha}..${BRANCH}` : BRANCH;
  const log = git(project.dir, "log", "--format=%h%x09%s", range) || "";
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, ...rest] = l.split("\t");
      return { sha, subject: rest.join("\t") };
    });
  return { current, branch: BRANCH, commits, base };
}

function sweepFacts(key) {
  const before = readJson(path.join(ROOT, ".lightbox", "audit", `${key}.json`));
  const after = readJson(path.join(ROOT, ".lightbox", "audit", `${key}.after.json`));
  const pick = (j) => (j ? (j.booted === false ? { booted: false, error: j.bootError || j.bootState } : { booted: true, ...j.totals }) : null);
  return { sweep: pick(before), sweepAfter: pick(after) };
}

async function main() {
  const { config } = await loadConfig(ROOT);
  const { projects, groups } = buildCatalogue(config);
  const handover = new Handover(path.join(ROOT, ".lightbox", "handover.json"));
  const wanted = args.key ? projects.filter((p) => p.key === args.key) : projects;

  for (const p of wanted) {
    const entry = handover.get(p.key);
    const g = gitFacts(p, entry);
    const s = sweepFacts(p.key);
    handover.set(p.key, {
      currentBranch: g.current,
      branch: g.branch,
      commits: g.commits,
      base: g.base,
      sweep: s.sweep,
      sweepAfter: s.sweepAfter,
      refreshedAt: new Date().toISOString(),
    });
  }
  handover.flush();
  clearInterval(handover.timer);

  /* HANDOVER.md */
  const titleOf = (id) => (groups.find((g) => g.id === id) || {}).title || id;
  const order = (p) => {
    const i = GROUP_ORDER.indexOf(p.group);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  const sorted = [...projects].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  const lines = ["# Front-end audit 2026-09, handover", "", `Refreshed ${new Date().toISOString().slice(0, 16).replace("T", " ")} by scripts/handover.mjs. Hand-written fields (status, note, proposals, Lighthouse, approval) survive a refresh.`, ""];
  let group = null;
  for (const p of sorted) {
    if (p.group !== group) {
      group = p.group;
      lines.push(`## ${titleOf(group)}`, "");
    }
    const e = handover.get(p.key) || {};
    const base = e.base ? `${e.base.branch}@${e.base.sha}` : "(none)";
    const n = (e.commits || []).length;
    lines.push(`### ${p.name} (${p.key})  base ${base}  ${e.branch ? `${e.branch}: ${n} commit${n === 1 ? "" : "s"}` : "no audit branch"}  approved: ${e.approved ? `yes, ${String(e.approvedAt).slice(0, 10)}` : "no"}`);
    if (e.status) lines.push(`Status: ${e.status}`);
    if (e.note) lines.push(`Note: ${e.note}`);
    if (e.currentBranch) lines.push(`Checked out: ${e.currentBranch}`);
    if (e.sweep) {
      lines.push(e.sweep.booted === false ? `Booted: no: ${e.sweep.error}` : "Booted: yes");
    } else lines.push(p.kind === "node" ? "Booted: not swept" : "Booted: static, not swept");
    if (n) lines.push("Fixes applied: " + e.commits.map((c) => `${c.sha} ${c.subject}`).join(" | "));
    if ((e.tierC || []).length) {
      lines.push("Findings deferred (Tier C):");
      for (const t of e.tierC) lines.push(`- ${t.title} [${t.route || ""}@${t.width || ""}${t.shot ? ", " + t.shot : ""}] -> proposed: ${t.proposal || ""}`);
    }
    if (e.sweep && e.sweep.booted !== false) {
      const s = e.sweep;
      const a = e.sweepAfter && e.sweepAfter.booted !== false ? e.sweepAfter : null;
      const cell = (k) => metric(s, a, k);
      lines.push(`Sweep: routes ${s.routes}, console errors ${cell("consoleErrors")}, failed requests ${cell("failedRequests")}, overflow ${cell("overflow")}, contrast ${cell("contrast")}, axe serious ${cell("axeSerious")}, meta ${cell("meta")}, focus ${cell("focus")}, motion ${cell("motion")}`);
      const cov = (t, label) => {
        if (!t) return null;
        if (!t.coverage) return `${label}: unrecorded, written before coverage was tracked`;
        if (t.coverage.complete) return `${label}: complete, ${t.coverage.cells} cells`;
        return `${label}: INCOMPLETE, ${t.coverage.loaded}/${t.coverage.cells} cells loaded${t.coverage.axeErrors ? `, axe threw on ${t.coverage.axeErrors}` : ""}${t.coverage.unreadableSheetCells ? `, ${t.coverage.unreadableSheetCells} with unreadable stylesheets` : ""}`;
      };
      lines.push(`Coverage: ${[cov(s, "before"), cov(a, "after")].filter(Boolean).join("  ")}`);
    }
    if (e.lighthouse) {
      const f = (x) => (x ? `${x.seo}/${x.a11y}/${x.bp}/${x.agentic}` : "not run");
      lines.push(`Lighthouse (SEO/A11y/BP/Agentic): before ${f(e.lighthouse.before)}  after ${f(e.lighthouse.after)}`);
    }
    if (e.pushed) lines.push(`Pushed: ${e.pushed}${e.pr ? "  PR " + e.pr : ""}`);
    lines.push("");
  }
  const md = path.join(ROOT, ".lightbox", "HANDOVER.md");
  fs.writeFileSync(md, lines.join("\n"));

  for (const p of wanted) {
    const e = handover.get(p.key);
    console.log(`${p.key.padEnd(20)} ${(e.currentBranch || "-").padEnd(36)} ${summarise(e).join(" · ") || "nothing recorded"}`);
  }
  console.log(`\nwrote ${path.relative(process.cwd(), md)}`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
