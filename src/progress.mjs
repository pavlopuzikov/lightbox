/**
 * Which pages you have finished with.
 *
 * Kept on the server rather than in the browser on purpose. A review that spans
 * forty origins would otherwise scatter its progress across forty separate
 * localStorage buckets, and lose the lot the first time you opened a second
 * browser to check something.
 */

import fs from "node:fs";
import path from "node:path";

export class Progress {
  constructor(file) {
    this.file = file;
    /** @type {Record<string, string[]>} */
    this.data = {};
    this.dirty = false;
    try {
      this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.data = {};
    }
    // Batched, because marking a page done should not cost a synchronous write.
    this.timer = setInterval(() => this.flush(), 4000);
    this.timer.unref?.();
  }

  get(key) {
    return this.data[key] || [];
  }

  set(key, route, reviewed) {
    const list = new Set(this.data[key] || []);
    if (reviewed) list.add(route);
    else list.delete(route);
    this.data[key] = [...list];
    this.dirty = true;
  }

  clear(key) {
    delete this.data[key];
    this.dirty = true;
  }

  countFor(key) {
    return (this.data[key] || []).length;
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch {
      /* progress is a convenience; a failed write must not take the run down */
    }
  }
}
