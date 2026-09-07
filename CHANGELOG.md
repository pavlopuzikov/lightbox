# Changelog

## Unreleased

The tool was used to run a front-end audit across 42 projects, and the audit is
what produced this list. Everything here is a defect the pass found in the tool
itself rather than in the projects it was pointed at.

### Nothing that was not measured reports as zero any more

This was the organising defect, and it was measurable in the audit data on
disk: one project's sweep recorded 36 of 36 failed loads and reported
`contrast 0`, the same string a clean page produces.

- Every check a sweep makes is now pass, fail, or unmeasured. Each sweep JSON
  carries a `coverage` block: how many cells produced a measurement, per check,
  and why the rest did not.
- An axe run that threw reports `null` contrast, not `0`.
- A stylesheet the page could not read makes motion unmeasured, rather than
  "this page declares no motion", which is what a CDN stylesheet used to mean.
- A `DESIGN.md` row whose value cell did not parse is reported as unread. It
  used to be skipped, and a skipped row read exactly like a matching one.
- `tokens` on a machine where no configured directory resolves exits 2 instead
  of printing "0 tokens drifted" and exiting 0.
- `handover` prints `not comparable` instead of an improvement claim when
  either side of a comparison has unmeasured cells. That note previously had to
  be written by hand, twice.
- Exit codes: 1 is a finding, 2 is "this run could not measure what you asked
  for". `sweep run` exits 2 on incomplete coverage unless `--allow-partial`.

### Evidence, so the next person does not guess

- **Contrast provenance.** For each `color-contrast` node the sweep records the
  ancestor that actually painted the background, the authored declaration
  behind it (read from the stylesheets, since the computed style has resolved
  every `var()` away), and whether anything was mid-fade or still animating
  when the reading was taken. Chasing one white card without this cost five
  browser probes and a reverted patch.
- **`lightbox tokens --runtime`.** Compares each token against what a browser
  computes, rather than against another file. Both sides go through the same
  CSS property so that `rgba(0,0,0,.45)` and `#00000073` compare equal. A
  static prediction that a shared library was overriding 32 tokens in one app
  measured as 0; the same run finds the one token that genuinely differs.
- The static token scan is block-aware. It keeps the at-rule and selector each
  declaration sits in, so a token redeclared across a responsive ladder is no
  longer read as an override, and a declaration inside a comment is no longer a
  declaration.

### Operability

- `Supervisor.restart` and `POST /api/restart/<key>`, with a button on the hub
  row. It refuses to claim it restarted a server it did not start.
- A dead dev server stops reporting `ready`. `ready` was a one-time latch set by
  a single TCP connect; an adopted server has no child process, so its death
  fired no exit event and the hub reported it running while the proxy returned
  503 for every request. There is now a periodic port probe, with two
  consecutive misses before calling it dead.
- Adoption is surfaced. lightbox still proxies to whatever answers the upstream
  port, because a TCP connect cannot tell you what is listening, but `adopted`
  and a note saying so are in `/api/state` and on the hub row.
- `portConflict` is read. When lightbox cannot bind a review port, the hub says
  so instead of offering an Open link to a port it does not own.
- The route cache is invalidated on restart, so a page added while `serve` is
  running appears. `clearRouteCache` was exported and called from nowhere.

### One CLI, one working directory

- `sweep`, `diff`, `summary`, `login`, `tokens`, `handover` and `reviews` are
  subcommands of `lightbox`, and every one of them resolves config and
  `.lightbox/` from the current working directory. They used to resolve both
  from the package directory, so an installed copy would have read its config
  out of `node_modules` and tried to write state in there.
- They also ship now. `files` covers `bin/` and `src/`, the commands lived in
  `scripts/`, and so `npm pack` produced a tarball with none of them while the
  README documented all four. `npm run check:pack` asserts this cannot recur.
- `lightbox --help` exists. It previously exited 1 with `Unknown command
  "--help"`.
- Playwright resolves normally from your working directory. `--playwright
  <dir>` and `LIGHTBOX_PLAYWRIGHT` still work, for borrowing another project's
  browser rather than installing a second one.
- `auditBranch` in the config replaces a hardcoded date-stamped branch name,
  and group ordering follows the config's own `groups` rather than a list
  compiled into the script.

## 0.1.0

First cut: the hub, the review ports, the proxy and overlay injection, route
discovery for Next, Vite, Astro, Nuxt, Remix, CRA and static directories, the
supervisor, the review bridge, and the audit loop (`sweep`, `handover`,
`reviews drain`).
