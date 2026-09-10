/**
 * How much you have actually said about each page.
 *
 * The reviewed dot is binary: a page is done or it is not. That answers the
 * wrong question. Walking a site, what you want to know is where the notes have
 * piled up and which page you have not looked at in a fortnight, and the
 * archive under .lightbox/reviews/<key>/inbox.md already holds both facts in
 * prose. This keeps the countable part of it beside that file as index.json so
 * the hub can render it without parsing megabytes of markdown on every refresh.
 *
 * Derived data, deliberately. Deleting index.json costs the counts and nothing
 * else; inbox.md remains the record.
 */

import fs from "node:fs";
import path from "node:path";

/** Notes in one review's markdown. Every note ends in exactly one comment. */
export function countNotes(markdown) {
  if (typeof markdown !== "string") return 0;
  const m = markdown.match(/^\*\*Comment:\*\*/gm);
  return m ? m.length : 0;
}

export class Notes {
  /** @param {string} reviewDir .lightbox/reviews */
  constructor(reviewDir) {
    this.dir = reviewDir;
    /** @type {Record<string, Record<string, {notes: number, last: string}>>} */
    this.cache = {};
  }

  file(key) {
    return path.join(this.dir, key, "index.json");
  }

  /** Read-through cache. The hub re-renders on a timer; the disk should not. */
  get(key) {
    if (!this.cache[key]) {
      try {
        this.cache[key] = JSON.parse(fs.readFileSync(this.file(key), "utf8"));
      } catch {
        // No index yet, or an unreadable one. Rebuild it from the archive
        // rather than starting from zero: this is derived data, and inbox.md
        // already holds every review ever taken. It is also what makes the
        // counts appear for sittings that predate this file existing.
        this.cache[key] = this.rebuild(key);
      }
    }
    return this.cache[key];
  }

  /** Recount one project from its inbox.md. Returns {} if there is no archive. */
  rebuild(key) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(this.dir, key, "inbox.md"), "utf8");
    } catch {
      return {};
    }
    /** @type {Record<string, {notes: number, last: string}>} */
    const out = {};
    // Each appended review starts with the comment archiveReview writes:
    // <!-- 2026-09-10T05:47:07.051Z http://localhost:4008/ -->
    const head = /^<!-- (\S+) (\S*) -->$/gm;
    const marks = [...raw.matchAll(head)];
    for (let i = 0; i < marks.length; i++) {
      const [, stamp, page] = marks[i];
      const body = raw.slice(
        marks[i].index + marks[i][0].length,
        i + 1 < marks.length ? marks[i + 1].index : raw.length
      );
      const n = countNotes(body);
      if (!n || !page) continue;
      let route;
      try {
        route = new URL(page).pathname;
      } catch {
        continue;
      }
      const prev = out[route];
      out[route] = {
        notes: (prev?.notes || 0) + n,
        // The archive is appended in order, so the last stamp wins.
        last: prev && prev.last > stamp ? prev.last : stamp,
      };
    }
    return out;
  }

  /** Notes recorded against one route, or 0. */
  countFor(key, route) {
    return this.get(key)[route]?.notes || 0;
  }

  /** Notes recorded against a project across every route. */
  totalFor(key) {
    return Object.values(this.get(key)).reduce((n, e) => n + (e.notes || 0), 0);
  }

  /** ISO date of the last review of a route, or null. */
  lastFor(key, route) {
    return this.get(key)[route]?.last || null;
  }

  record(key, route, notes) {
    if (!notes) return;
    const data = this.get(key);
    data[route] = { notes: (data[route]?.notes || 0) + notes, last: new Date().toISOString() };
    try {
      fs.mkdirSync(path.dirname(this.file(key)), { recursive: true });
      fs.writeFileSync(this.file(key), JSON.stringify(data, null, 2));
    } catch {
      /* the count is a convenience; inbox.md is the record and it was written
         first. A failed write here must not take a review down. */
    }
  }
}
