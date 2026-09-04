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

export const EMPTY = Object.freeze({
  base: null, // { branch, sha } the audit branch was cut from
  branch: null, // the audit branch name
  commits: [], // [{ sha, subject }]
  note: "", // "audit only", "archived", "no shared ancestor", ...
  tierC: [], // [{ title, route, width, shot, proposal }]
  sweep: null, // totals from scripts/sweep.mjs
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
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) this.data = raw;
    } catch {
      this.data = {};
    }
    this.timer = setInterval(() => this.flush(), 4000);
    this.timer.unref?.();
  }

  /** The entry for a key, or null when nothing has been recorded. */
  get(key) {
    const e = this.data[key];
    return e ? { ...EMPTY, ...e } : null;
  }

  /** Shallow-merge a patch; arrays and objects in the patch replace, not append. */
  set(key, patch) {
    this.data[key] = { ...EMPTY, ...(this.data[key] || {}), ...patch };
    this.dirty = true;
    return this.get(key);
  }

  approve(key, when = new Date()) {
    return this.set(key, { approved: true, approvedAt: when.toISOString() });
  }

  unapprove(key) {
    return this.set(key, { approved: false, approvedAt: null });
  }

  all() {
    const out = {};
    for (const key of Object.keys(this.data)) out[key] = this.get(key);
    return out;
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch {
      /* a failed write must not take the run down */
    }
  }
}

/** One line of summary the hub and HANDOVER.md both use. */
export function summarise(entry) {
  if (!entry) return [];
  const lines = [];
  if (entry.branch) {
    lines.push(`${entry.branch} · ${entry.commits.length} commit${entry.commits.length === 1 ? "" : "s"}`);
  }
  if (entry.sweep) {
    const s = entry.sweep;
    lines.push(
      `sweep: ${s.routes} routes, ${s.consoleErrors} errors, ${s.overflow} overflow, ${s.contrast} contrast`
    );
  }
  if (entry.tierC.length) {
    lines.push(`${entry.tierC.length} proposal${entry.tierC.length === 1 ? "" : "s"}`);
  }
  return lines;
}
