/**
 * Viewport frames captured while a review is being written.
 *
 * Why lightbox holds these rather than the inspector's own bridge. The bridge
 * keeps the last twenty reviews and deletes a review's image files when it
 * evicts one, so images stored only there quietly disappear after twenty
 * sittings. It also caps a request body at 4 MB, which nine full-width frames
 * would breach on their own. These land next to inbox.md, which is the uncapped
 * record, and only their paths are ever forwarded.
 *
 * Why the viewport and not the element. Roughly half the notes in a real review
 * are comparative: "width doesnt match the other links", "all elements in this
 * section need to be the same size". A tight crop of the one element cannot
 * answer any of those. The element's rectangle is recorded as coordinates
 * instead of drawn into the pixels, so the frame stays the frame.
 */

import fs from "node:fs";
import path from "node:path";

/** Only what the browser's canvas actually produces. */
const KIND = { "image/jpeg": ".jpg", "image/png": ".png" };

export class Shots {
  /**
   * @param {string} reviewDir .lightbox/reviews
   * @param {number} max most frames to hold for one project between reviews
   */
  constructor(reviewDir, max = 40) {
    this.dir = reviewDir;
    this.max = max;
    /** @type {Record<string, object[]>} */
    this.pending = {};
    /** Frames already on disk this session, so nine notes on one screen are
     *  one file. Keyed by whatever the browser says identifies the frame. */
    this.byFrame = {};
  }

  /**
   * Record one capture. `dataUrl` writes a file; `ref` reuses one already
   * written, which is how a second note on an unscrolled page costs nothing.
   * @returns {{file: string|null, frame: string|null}}
   */
  save(key, shot) {
    const list = (this.pending[key] = this.pending[key] || []);
    let file = null;

    if (shot.ref && this.byFrame[shot.ref]) {
      file = this.byFrame[shot.ref];
    } else if (typeof shot.dataUrl === "string") {
      file = this.write(key, shot.dataUrl);
      if (file && shot.frame) this.byFrame[shot.frame] = file;
    }

    list.push({
      selector: shot.selector || null,
      page: shot.page || null,
      rect: shot.rect || null,
      viewport: shot.viewport || null,
      file,
    });
    // Bounded: an armed tab left open all afternoon must not grow without
    // limit. The oldest go first, which are also the least likely to belong to
    // the review about to be submitted.
    while (list.length > this.max) list.shift();
    return { file, frame: shot.frame || null };
  }

  write(key, dataUrl) {
    const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
    if (!m || !KIND[m[1]]) return null;
    const dir = path.join(this.dir, key, "shots");
    const name = new Date().toISOString().replace(/[:.]/g, "-") + KIND[m[1]];
    const file = path.join(dir, name);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, Buffer.from(m[2], "base64"));
      return file;
    } catch {
      /* out of disk, or a locked directory. The review still goes through
         without the image, which is what it did before any of this existed. */
      return null;
    }
  }

  /** Everything captured for this project since the last review, and clear. */
  take(key) {
    const list = this.pending[key] || [];
    this.pending[key] = [];
    return list;
  }
}

/**
 * Write each captured frame into the note it belongs to.
 *
 * Matched on selector rather than position, because the reviewer can delete a
 * queued note between capturing it and submitting, and a positional pairing
 * would then attach every remaining image to the wrong note. Each frame is
 * used once. A note with no frame is left exactly as it was.
 */
export function linkShots(markdown, shots) {
  if (typeof markdown !== "string" || !shots.length) return markdown;
  const left = shots.filter((s) => s.file);
  if (!left.length) return markdown;

  // Notes are "## 1. Component > Path" sections. Keeping the delimiter on the
  // block means the text can be rebuilt by joining, with no separator to guess.
  const blocks = markdown.split(/(?=^## )/m);
  const used = new Set();

  const out = blocks.map((block) => {
    const sel = /^- Selector: `(.+)`$/m.exec(block);
    const at = block.indexOf("**Comment:**");
    if (!sel || at === -1) return block;

    const i = left.findIndex((s, n) => !used.has(n) && s.selector === sel[1]);
    if (i === -1 || used.has(i)) return block;
    used.add(i);

    const s = left[i];
    const where = s.rect
      ? ` · element at ${Math.round(s.rect.x)},${Math.round(s.rect.y)} ` +
        `${Math.round(s.rect.width)}x${Math.round(s.rect.height)}`
      : "";
    const vp = s.viewport ? ` · viewport ${s.viewport.width}x${s.viewport.height}` : "";
    return block.slice(0, at) + `- Shot: ${s.file}${where}${vp}\n\n` + block.slice(at);
  });

  return out.join("");
}
