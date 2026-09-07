/**
 * What a coding session did to each project, and whether the reviewer has
 * signed it off.
 *
 * Same shape as progress.mjs: one JSON file under .lightbox/, batched writes,
 * a failed write never takes the run down. The hub reads it to show a branch,
 * its commits, the sweep totals and the proposals waiting on a decision, and
 * it flips `approved` when the Approve button is pressed. Nothing else in the
 * tool writes to it; scripts/handover.mjs fills in the rest from git and the
 * sweep output, preserving whatever was written by hand.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * What the project itself is, as opposed to what this pass did to it. The
 * reviewer sets it from the hub. "" means nobody has said yet, which is worth
 * seeing: an unlabelled project is one nobody has triaged.
 */
export const STATUSES = Object.freeze(["active", "paused", "archived", "retired"]);

export const EMPTY = Object.freeze({
  status: "", // one of STATUSES, or "" when unset
  base: null, // { branch, sha } the audit branch was cut from
  branch: null, // the audit branch name
  commits: [], // [{ sha, subject }]
  note: "", // "audit only", "archived", "no shared ancestor", ...
  tierC: [], // [{ title, route, width, shot, proposal }]
  currentBranch: null, // what is actually checked out right now
  sweep: null, // totals from scripts/sweep.mjs, the before run
  sweepAfter: null, // the same totals from the after run, once fixes have landed
  lighthouse: null, // { before, after } for the public sites
  approved: false,
  approvedAt: null,
  pushed: null, // sha that left the machine
  pr: null, // its pull request URL
});

export class Handover {
  constructor(file) {
    this.file = file;
    /** @type {Record<string, object>} */
    this.data = {};
    this.dirty = false;
    this.mtime = 0;
    /** @type {Record<string, object>} field changes we have not written yet */
    this.pending = {};
    this.load();
    this.timer = setInterval(() => this.flush(), 4000);
    this.timer.unref?.();
  }

  /** Read the file into memory, recording the mtime we read. */
  load() {
    try {
      this.mtime = fs.statSync(this.file).mtimeMs;
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) this.data = raw;
    } catch {
      /* no file yet, or a half-written one: keep what we have */
    }
  }

  /**
   * scripts/handover.mjs rewrites this file while the hub is running, so an
   * in-memory copy loaded at startup goes stale within minutes and the next
   * flush would write the stale copy back over it. Re-read whenever the file
   * changed underneath us and we have nothing of our own pending.
   */
  refresh() {
    if (this.dirty) return;
    let m = 0;
    try {
      m = fs.statSync(this.file).mtimeMs;
    } catch {
      return;
    }
    if (m !== this.mtime) this.load();
  }

  /** The entry for a key, or null when nothing has been recorded. */
  get(key) {
    this.refresh();
    const e = this.data[key];
    return e ? { ...EMPTY, ...e } : null;
  }

  /** Shallow-merge a patch; arrays and objects in the patch replace, not append. */
  set(key, patch) {
    this.refresh();
    this.data[key] = { ...EMPTY, ...(this.data[key] || {}), ...patch };
    this.pending[key] = { ...(this.pending[key] || {}), ...patch };
    this.dirty = true;
    return { ...EMPTY, ...this.data[key] };
  }

  approve(key, when = new Date()) {
    return this.set(key, { approved: true, approvedAt: when.toISOString() });
  }

  unapprove(key) {
    return this.set(key, { approved: false, approvedAt: null });
  }

  /** Set the project's status. An unknown value clears it rather than storing junk. */
  setStatus(key, status) {
    const value = STATUSES.includes(status) ? status : "";
    return this.set(key, { status: value });
  }

  all() {
    this.refresh();
    const out = {};
    for (const key of Object.keys(this.data)) out[key] = { ...EMPTY, ...this.data[key] };
    return out;
  }

  /**
   * Apply only the fields we actually changed to whatever is on disk now,
   * rather than replacing the file with our copy of it. The hub changes
   * approved and approvedAt; every other field belongs to
   * scripts/handover.mjs, which rewrites this file while the hub is running.
   */
  flush() {
    if (!this.dirty) return;
    const pending = this.pending;
    this.pending = {};
    this.dirty = false;
    let merged = {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) merged = raw;
    } catch {
      /* no readable file: our own entries are all there is */
      merged = { ...this.data };
    }
    for (const [key, patch] of Object.entries(pending)) {
      merged[key] = { ...EMPTY, ...(merged[key] || {}), ...patch };
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(merged, null, 2));
      this.data = merged;
      this.mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      /* a failed write must not take the run down: keep the patches */
      this.pending = { ...pending, ...this.pending };
      this.dirty = true;
    }
  }
}

/** Totals key on the left, the coverage bucket that measured it on the right. */
const COVERAGE_KEY = {
  consoleErrors: "console",
  failedRequests: "requests",
  overflow: "overflow",
  contrast: "contrast",
  axeSerious: "axe",
  meta: "meta",
  focus: "focus",
  motion: "motion",
};

/** `complete`, `12/36 unmeasured`, or `unrecorded` for a pre-coverage audit. */
export function coverageOf(totals, k) {
  if (!totals || !totals.coverage) return "unrecorded";
  const c = totals.coverage.byCheck && totals.coverage.byCheck[COVERAGE_KEY[k]];
  if (!c) return "unrecorded";
  return c.unmeasured ? `${c.unmeasured}/${c.measured + c.unmeasured} unmeasured` : "complete";
}

/**
 * Render one metric, and refuse to render it as an improvement when either
 * side of the comparison is partial.
 *
 * "1034 to 0" is a claim about a fix. It is only true if both runs actually
 * measured the thing. On a project whose every route 500s, both sides record 0
 * because nothing ran, and this used to print that as a clean sweep.
 */
export function metric(before, after, k) {
  const cb = coverageOf(before, k);
  const ca = after ? coverageOf(after, k) : null;
  // "unrecorded" is an audit written before coverage was tracked. That is not
  // the same claim as "we measured and came up short", so its numbers are still
  // printed; `coverageNote` flags the whole line as needing a re-sweep.
  const partial = (c) => c !== "complete" && c !== "unrecorded";
  if (!after) return partial(cb) ? `partial (${cb})` : `${before[k]}`;
  if (partial(cb) || partial(ca)) return `not comparable (before ${cb}, after ${ca})`;
  return after[k] !== before[k] ? `${before[k]} to ${after[k]}` : `${after[k]}`;
}

/** Appended once per line when either side predates coverage tracking. */
export function coverageNote(before, after) {
  const stale = (t) => t && !t.coverage;
  return stale(before) || stale(after) ? " (coverage unrecorded, re-sweep to confirm)" : "";
}

/** One line of summary the hub and HANDOVER.md both use. */
export function summarise(entry) {
  if (!entry) return [];
  const lines = [];
  if (entry.branch) {
    lines.push(`${entry.branch} · ${entry.commits.length} commit${entry.commits.length === 1 ? "" : "s"}`);
  }
  if (entry.sweep && entry.sweep.booted === false) {
    lines.push(`did not boot: ${entry.sweep.error}`);
  } else if (entry.sweep) {
    // Show where the numbers ended up, not where they started. Reading the
    // before figure off a card whose fixes have already landed is how a key
    // that measures clean keeps looking like outstanding work.
    const s = entry.sweep;
    const a = entry.sweepAfter && entry.sweepAfter.booted !== false ? entry.sweepAfter : null;
    const cell = (k) => metric(s, a, k);
    lines.push(
      `sweep: ${s.routes} routes, ${cell("consoleErrors")} errors, ${cell("overflow")} overflow, ${cell("contrast")} contrast${coverageNote(s, a)}`
    );
  }
  if (entry.tierC.length) {
    lines.push(`${entry.tierC.length} proposal${entry.tierC.length === 1 ? "" : "s"}`);
  }
  return lines;
}
