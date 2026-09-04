/**
 * Getting reviews out of the bridge before it forgets them.
 *
 * inspect-comment's MCP server keeps its last twenty reviews and deletes the
 * screenshots of older ones. A sitting across forty projects overflows that
 * before a coding session has read any of it. `drain` copies each stored
 * review into .lightbox/reviews/<key>/ (markdown, the raw queue, the shots)
 * and remembers the ids it has taken, so it can run at the start of every
 * coding batch and only ever move new ones.
 *
 * The bridge drops the fields the proxy adds (project, projectName,
 * projectDir), so the project key is read back out of the markdown header the
 * proxy rewrote: `# Review: <name> (<key>) <path>`.
 */

import fs from "node:fs";
import path from "node:path";

const HEADER = /^# Review: .*?\(([a-z0-9][a-z0-9_-]*)\)\s+(\S*)/m;

export function keyFromMarkdown(markdown) {
  const m = HEADER.exec(String(markdown || ""));
  return m ? { key: m[1], route: m[2] } : null;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * @param {object} o
 * @param {string} o.storeFile   the bridge's reviews.json
 * @param {string} o.shotsDir    where the bridge writes review-<id>-note-<n>.png
 * @param {string} o.outDir      .lightbox/reviews
 * @param {string} [o.drainedFile]  defaults to <outDir>/drained.json
 */
export function drain({ storeFile, shotsDir, outDir, drainedFile }) {
  drainedFile = drainedFile || path.join(outDir, "drained.json");
  const store = readJson(storeFile, { reviews: [] });
  const reviews = Array.isArray(store) ? store : store.reviews || [];
  const drained = readJson(drainedFile, { reviews: [] });
  const taken = new Set(drained.reviews.map((r) => r.id));
  const moved = [];

  for (const r of [...reviews].sort((a, b) => a.id - b.id)) {
    if (taken.has(r.id)) continue;
    const parsed = keyFromMarkdown(r.markdown);
    const key = parsed ? parsed.key : "unknown";
    const dir = path.join(outDir, key);
    const shotOut = path.join(dir, "shots");
    fs.mkdirSync(dir, { recursive: true });

    /* shots: copy, then point the markdown at the copies */
    let markdown = String(r.markdown || "");
    const copied = [];
    if (shotsDir && fs.existsSync(shotsDir)) {
      const prefix = `review-${r.id}-note-`;
      for (const name of fs.readdirSync(shotsDir)) {
        if (!name.startsWith(prefix)) continue;
        fs.mkdirSync(shotOut, { recursive: true });
        const from = path.join(shotsDir, name);
        const to = path.join(shotOut, name);
        try {
          fs.copyFileSync(from, to);
          copied.push(name);
          markdown = markdown.split(from).join(to).split(from.split(path.sep).join("/")).join(to.split(path.sep).join("/"));
        } catch {
          /* a missing shot is recorded below, not fatal */
        }
      }
    }

    const mdFile = path.join(dir, `review-${r.id}.md`);
    const jsonFile = path.join(dir, `review-${r.id}.json`);
    fs.writeFileSync(mdFile, markdown.trim() + "\n");
    fs.writeFileSync(
      jsonFile,
      JSON.stringify({ id: r.id, receivedAt: r.receivedAt, page: r.page, viewport: r.viewport, count: r.count, queue: r.queue || [], logs: r.logs || [] }, null, 2)
    );
    const entry = { id: r.id, key, route: parsed ? parsed.route : null, page: r.page, receivedAt: r.receivedAt, shots: copied.length, drainedAt: new Date().toISOString(), file: mdFile };
    drained.reviews.push(entry);
    moved.push(entry);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(drainedFile, JSON.stringify(drained, null, 2));
  return { moved, total: drained.reviews.length, stored: reviews.length };
}

/** What is in the store and what has already been taken, for `reviews list`. */
export function status({ storeFile, drainedFile }) {
  const store = readJson(storeFile, { reviews: [] });
  const reviews = Array.isArray(store) ? store : store.reviews || [];
  const drained = readJson(drainedFile, { reviews: [] });
  const taken = new Set(drained.reviews.map((r) => r.id));
  return reviews
    .map((r) => {
      const parsed = keyFromMarkdown(r.markdown);
      return { id: r.id, key: parsed ? parsed.key : "unknown", route: parsed ? parsed.route : null, page: r.page, receivedAt: r.receivedAt, drained: taken.has(r.id) };
    })
    .sort((a, b) => a.id - b.id);
}
