# Changelog

## Unreleased

The tool was used to run a front-end audit across 42 projects, and the audit is
what produced this list. Everything here is a defect the pass found in the tool
itself rather than in the projects it was pointed at.

### The review surface could not be seen, and the walk could not finish

Four defects, all found by using the tool on pavlopuzikov.com and all measured
there before and after.

- **The bar was translucent, so the page came through it.** It sat at
  `opacity: .62` and came up to `1` on hover, on the theory that a see-through
  strip recedes politely. Park it over the seam where a light section meets a
  dark one, which is where the bottom of a landing page usually is, and the
  cream goes muddy grey-green, the ink border goes grey and the vermilion rule
  goes pink. It is opaque now. Cream stock with a hard offset already sits
  quietly against someone else's page.
- **inspect-comment's dock was drawn and then buried.** It mounts on a 0x0
  `position: fixed` div and puts `z-index: 2147483001` on the dock inside it. A
  fixed element with `z-index: auto` is itself a stacking context, so that
  number only ever competed with inspect-comment's own layers while the host
  competed with the page at `auto` and lost to any positioned section after it.
  Measured on the portfolio: 35px tall, fully opaque, and only the top ten
  pixels reached the screen. The overlay now gives the host the z-index its
  contents already assume. lightbox's own bar had been dodging this by
  accident, because its host is `all: initial` and therefore static.
- **The dock is drawn in the design system now.** It was the one part of the
  review surface still in inspect-comment's own look, a near-black rounded pill
  under a blurred shadow, two corners away from a letterpress bar. It is
  restyled from `overlay.js` into inspect-comment's open shadow root rather
  than in inspect-comment itself, which is used outside lightbox and should
  keep its own look there. The panel is left alone on purpose: it is a tool
  that appears while you use it, not chrome that sits in the frame while you
  judge someone's colours.
- **`next` walked in a circle.** The position was derived from `location` alone,
  so any route that redirects threw the walk back to wherever the landing page
  sits in the list. `/about` 308s to `/#about`, whose pathname is `/`, which
  reads as route 1, so the walk ran 1,2,3,4,5,6,1,2,... and pages 7 to 15 were
  unreachable. The intended index is now carried across the navigation, and the
  bar says `/about → /` in vermilion when a route did not serve itself.

### An unfilled dynamic route is not a page

`/work/[slug]` is a literal request. A dev server answers it by compiling for
several seconds and then rendering a 404, which made the three dynamic routes on
the portfolio the slowest clicks in the walk for the least return.

- The walk steps over any route still holding a `[segment]`. The sheet still
  lists it, tagged dynamic, so it is visibly skipped rather than quietly
  dropped.
- `params` takes a route-keyed override, because one param name can mean two
  unrelated things in one project: `/work/[slug]` and `/creative/[slug]` have
  disjoint slug sets, and one flat map fills the second with a value that 404s.

  ```json
  "params": {
    "slug": "atlas",
    "/creative/[slug]": { "slug": "avanhard" }
  }
  ```

  A route pattern always begins with `/` and a param name never can, so the two
  kinds of key cannot collide. With this the portfolio goes from 15 routes, 3 of
  them unvisitable and 1 of them a redirect, to 14 that all return 200.

### The pages you land on when something is wrong look like the tool now

The hub and the overlay went on the design system first. The three pages the
proxy serves itself did not, and they are the ones a reader actually hits: a
directory with no `index.html`, a dev server that is not answering, a route
that does not exist. All three were still drawn from hex literals in the dark
palette nothing else uses.

- The directory index is now ruled tabular matter with a `KIND / NAME` head,
  matching the hub.
- The 503 names the ports it is talking about, sets the failure in vermilion,
  and puts the dev server's own output in the margin the way the hub does.
- The 404 carries two ways out, the project index and the hub. It had none,
  which made it a dead end inside a site with no navigation of its own.
- `test/design.test.mjs` now guards `src/proxy.mjs` alongside the other two, so
  none of the three can go back to naming a colour. It would have caught the 19
  literals this change removed.

### The chrome has a design system of its own

Both surfaces used to be styled from hex literals typed inline, the same accent
colour written out in eleven places across two files, and no way to change any
of it in one edit. The look that produced was the generic light-grey-panel
default, which is the worst possible choice for a tool whose whole job is to sit
on top of forty other design systems while you judge them.

- Added `src/design.css`, the single source for every colour, face, rule weight
  and duration, and `src/design.mjs`, which parses it and hands the values to
  both surfaces. The overlay's shadow root gets them through the injected
  config, because `all: initial` means it inherits nothing.
- Redrew the hub and the overlay as a letterpress broadside: cream stock, black
  and vermilion, condensed capitals in the display sizes, three rule weights,
  and one engraved ornament band per surface. See `DESIGN.md`.
- State is carried by the fill of a square rather than by a palette, so red is
  spent only on the tally and on failures.
- `test/design.test.mjs` fails if either surface hardcodes a colour, if the
  chrome references an undefined token, or if `DESIGN.md` drifts from the
  stylesheet. The last of those is `lightbox tokens` pointed at lightbox.
- Fixed along the way: the progress bar had no upper bound, so a project whose
  stored progress outran its current route list drew an element 19,000px wide
  and gave the whole hub a horizontal scrollbar. The status dot styles referred
  to `--line`, `--dim` and `--fg`, three variables this stylesheet has never
  defined, so the dot painted transparent.
- `npm run check:pack` now also asserts the two files the code reads from disk
  rather than imports, `src/overlay.js` and `src/design.css`. Following imports
  can never find those, which is the same blind spot that shipped 0.1.0 without
  its audit commands.

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
