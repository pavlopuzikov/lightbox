# lightbox

[![CI](https://github.com/pavlopuzikov/lightbox/actions/workflows/ci.yml/badge.svg)](https://github.com/pavlopuzikov/lightbox/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![no dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

Every front end you have ever built, running at once, each page carrying the
same review overlay. Open the hub, walk a project's routes one at a time, mark
what you have seen, and comment on elements with
[inspect-comment](https://github.com/pavlopuzikov/inspect-comment). The notes
land in a folder a coding agent can read, tagged with the repository they came
from.

Named for the light table: a sheet of slides, looked through one frame at a
time.

No dependencies. Runs from a clone with nothing installed, which is the whole
point of a tool whose job is booting other people's projects.

## The loop

1. `lightbox serve` starts a hub on `:4000` and one review port per project
   (`:4001`, `:4002`, ...). Nothing heavier starts until you open something.
2. Open a project from the hub. lightbox starts its dev server on demand
   (`next dev`, `vite`, `astro dev`, `storybook dev`, or a command you give it),
   waits for it to answer, and proxies it with the overlay injected into every
   HTML response. A dev server that is already listening is adopted, not
   duplicated. Plain HTML folders are served directly, with `Range` support so
   video and audio still seek.
3. Walk the routes with `Alt`+`]` and `Alt`+`[`. Routes are grouped into
   families by first path segment, so `Alt`+`Shift`+`]` skips to the next
   template when fifty pages are one layout with different data in it.
4. `Alt`+`C` selects an element with inspect-comment. Say what should change,
   `Ctrl`+`Enter` queues it. Copy sends the review to the MCP bridge with the
   project key and directory written into its header, so the agent knows which
   repository to open.
5. `Alt`+`M` marks the page done. Progress survives restarts.

## Install

```bash
git clone https://github.com/pavlopuzikov/lightbox
cd lightbox
node bin/lightbox.mjs init ~/projects      # writes lightbox.config.json
node bin/lightbox.mjs serve                # http://localhost:4000
```

`npm link` makes that `lightbox init` and `lightbox serve`. Node 18 or later.

inspect-comment is optional. It is found in `node_modules/inspect-comment`, in a
sibling clone at `../inspect-comment`, or wherever `inspectComment` in the
config points. Without it, pages carry the route walker and no element
inspector, and `serve` says so once at start-up.

## Commands

| Command | Does |
| --- | --- |
| `lightbox init <dir...>` | Scans each directory two levels deep (`apps/` and `packages/` included) and writes `lightbox.config.json` |
| `lightbox list` | What the config resolves to: port, runner, page count, and which projects still need `npm install` |
| `lightbox serve` | The hub and every review port. Dev servers start when a project is opened |
| `lightbox --help` | All of the above, plus what the exit codes mean |

### The audit loop

One CLI, and every command resolves `lightbox.config.json` and `.lightbox/`
from the directory you run it in, never from wherever lightbox is installed.

`sweep` and `tokens --runtime` need Playwright and axe-core. lightbox does not
depend on them: they are resolved when the command runs, from your own project
(`npm i -D playwright axe-core && npx playwright install chromium`), or from a
directory you name with `--playwright <dir>` or `LIGHTBOX_PLAYWRIGHT` if you
would rather borrow another project's copy than install a second browser.

| Command | Does |
| --- | --- |
| `lightbox sweep --key <key>` | Loads every route at 390, 768 and 1440 through the review port with the walker left out (the proxy honours an `x-lightbox-bare` request header) and records status, console errors, failed requests, horizontal overflow with its culprits, axe WCAG AA violations and where each contrast failure's background came from, `lang`/title/description/viewport/`h1`, first Tab stop and its focus ring, declared motion against `prefers-reduced-motion`, and a full-page screenshot with its hash. Writes `.lightbox/audit/<key>.json` and `.lightbox/shots/<key>/before/`. `--label after` writes the second set |
| `lightbox diff before.json after.json` | Check by check, route by route: what got worse, what got better, which screenshots changed. Exits 1 on anything worse |
| `lightbox summary *.json` | One markdown table across projects |
| `lightbox login --key <key>` | Opens a headed browser on the project's login page, waits for you to sign in, and saves the storage state to reuse with `--storage-state` |
| `lightbox tokens` | Compares each project's `DESIGN.md` token table against the values in its own stylesheets. Exits 1 on drift |
| `lightbox tokens --runtime` | Loads a route in a browser and compares what each token computes to against what the project declares. Answers the question the file comparison cannot: is something outside this project overriding it |
| `lightbox handover` | Refreshes `.lightbox/handover.json` from git (the `auditBranch`, and its commits above its base) and the sweep totals, then writes `.lightbox/HANDOVER.md`. Hand-written fields survive: notes, proposals, Lighthouse numbers, approval |
| `lightbox reviews drain` | Copies every review the bridge holds into `.lightbox/reviews/<key>/` with its screenshots. The bridge keeps only its last twenty, so run this at the start of every coding batch |

The hub shows the handover line under each project (branch, commit count,
sweep totals, proposals waiting) and an **Approve** action. `approved: true` in
`handover.json` is the one signal a push step is meant to read.

### Nothing measured is reported as zero

Every check a sweep makes is three-valued: it passed, it failed, or it was
never measured. A route that 500s, an axe run that threw, a stylesheet the
page could not read: each of those used to produce the same output as a clean
page, because the counter it would have incremented stayed at zero.

So each sweep carries a `coverage` block saying how many of its cells actually
produced a measurement, per check, and the summary line says so out loud:

```
coverage: INCOMPLETE. Unmeasured cells: contrast 13/15, axe 13/15
(13 loads failed). A zero on those checks is not a measurement.
```

`lightbox diff` will not call a check improved when either side of it was
unmeasured, and `handover` prints `not comparable` rather than `1034 to 0`.

Exit codes follow from that. **1** means a real finding: token drift, or a
regression against the previous sweep. **2** means the run could not measure
what it was asked to measure, which is not a pass. `sweep run` exits 2 on
incomplete coverage unless you pass `--allow-partial`.

## Config

`lightbox.config.json` (or `.mjs`) sits in the directory you run from.
[lightbox.config.example.json](lightbox.config.example.json) is the annotated
version.

```json
{
  "scan": [{ "dir": "C:/Users/you/projects", "depth": 2, "group": "projects" }],
  "projects": [
    {
      "key": "marketing",
      "name": "Marketing site",
      "dir": "C:/Users/you/projects/marketing",
      "note": "Check the pricing table at 380px.",
      "routes": ["/", "/pricing"],
      "params": { "slug": "launch" }
    },
    {
      "key": "ui",
      "name": "Component library",
      "dir": "C:/Users/you/projects/ui",
      "command": ["storybook", "dev", "-p", "{port}", "--no-open"]
    }
  ],
  "groups": [{ "id": "projects", "title": "Projects", "blurb": "" }]
}
```

`scan` finds projects by looking at them: `package.json` names the runner, an
`.html` file makes it a static site, anything else is skipped. `projects`
entries win over a scanned entry with the same key, and are where a project gets
a proper name, a note for the reviewer, a fixed `port`, the `routes` that should
lead the walk, `params` to fill dynamic segments, `"kind": "static"` for a folder
that carries a `package.json` but is really plain HTML, or a `command` for a
runner lightbox does not know. `{port}` in a command is replaced with the
upstream port, and `PORT` is set in the environment either way.

### Route discovery

- Next App Router: every `app/**/page.*`. Route groups `(name)` vanish from the
  URL, `@slot` directories are not routes, `api/` is not a page.
- Next Pages Router: every file under `pages/` that is not `_app`, `_document`
  or `api/`.
- Vite, Astro, CRA: `src/pages/**`, else just `/`.
- Static: every `.html` under the root, `index.html` as its directory.

Dynamic segments keep their brackets, so a `[person]` route with no value is
still listed, and `params` fills in the ones you have real values for. An
unfilled one stays in the sheet, tagged dynamic, but `Alt`+`]` steps over it:
`/people/[person]` is a literal request, and a dev server answers it by
compiling for several seconds and then rendering a 404.

One param name can mean two unrelated things in one project. Where it does, key
an entry by the route pattern itself and it overrides the flat map for that
route and nothing else:

```json
"params": {
  "slug": "atlas",
  "/creative/[slug]": { "slug": "avanhard" }
}
```

A route pattern always begins with `/` and a param name never can, so the two
kinds of key cannot collide.

## Keyboard

| Key | Does |
| --- | --- |
| `Alt`+`]` / `Alt`+`[` | Next / previous page |
| `Alt`+`Shift`+`]` / `Alt`+`Shift`+`[` | Next / previous family |
| `Alt`+`M` | Mark this page done |
| `Alt`+`H` | Back to the hub |
| `Alt`+`C` | Inspect and comment (inspect-comment) |
| `Alt`+`F` | Focus-order overlay (inspect-comment) |

The bar at the bottom of every page shows where you are in the walk and opens
the full route list, grouped by family.

## What is written to disk

Everything lives under `.lightbox/` in the directory you serve from, and all of
it is gitignored:

| Path | Holds |
| --- | --- |
| `progress.json` | Which routes are marked done, per project |
| `reviews/reviews.json` | Reviews received by the bridge, plus their screenshots |
| `reviews/<key>/inbox.md` | Every review for that project, appended as it arrives, before the bridge's twenty-review cap can lose it |
| `reviews/<key>/review-<id>.md` | What `reviews.mjs drain` copied out, with the screenshots beside it; `reviews/drained.json` lists the ids taken |
| `audit/<key>.json`, `shots/<key>/` | The sweep's measurements and full-page screenshots |
| `handover.json`, `HANDOVER.md` | Per project: base, audit branch, commits, sweep totals, proposals, approval |
| `logs/<key>.log` | Each dev server's output |
| `logs/bridge.log` | The MCP bridge's output, one section per start |

The bridge is inspect-comment's MCP server, started by lightbox when nothing is
listening on `127.0.0.1:7391` and pointed at that reviews directory. Its
`/health` endpoint is checked by name, so a stranger on the port is reported
rather than trusted.

## How it works

One `http` server per project. Paths under `/__lb/` are the tool's own
(overlay, config, progress, bridge forwarding, start and state); everything else
is forwarded to the dev server, including the WebSocket upgrade so hot reload
keeps working. Two script tags go in right after `<head>`: the config as
`window.__LIGHTBOX`, and the overlay, deferred.

The supervisor starts a dev server with the project's own `node_modules/.bin`,
tails its output into the hub, and on Windows stops the whole process tree
rather than the shell wrapper alone.

## How it looks, and why

lightbox is drawn as a letterpress broadside: cream stock, two inks, condensed
capitals, and horizontal rules where another tool would put cards and badges.

That is not a flourish. The overlay sits in the corner of somebody else's site
all day and the hub is the page you flip back to between them, so the chrome
cannot afford to look like a product UI. If you cannot tell the tool from the
work at a glance, the tool is quietly editing your judgement of the work.

One stylesheet decides all of it, [`src/design.css`](src/design.css), and both
surfaces read it from there: the hub inlines it, and the proxy hands the same
values to the overlay's shadow root, which inherits nothing on its own. Neither
file is allowed to name a colour directly and a test fails if one does.

[DESIGN.md](DESIGN.md) is the full system, with the measured contrast of every
ink. It is also a fixture: `lightbox tokens --key lightbox` runs the same drift
check against this repo that it runs against every project in your catalogue.

## Zero dependencies, checked

`npm run check` fails if `package.json` grows a `dependencies` block or if
`src/` or `bin/` import anything that is not a `node:` builtin. Playwright and
axe-core are optional peers, resolved when a command runs rather than imported,
so they do not break that.

`npm run check:pack` asserts that `npm pack` ships every module the CLI
dispatches. That check exists because for the whole life of 0.1.x it did not:
the audit commands lived in `scripts/`, which `files` does not ship, so an
installed copy had no `sweep`, no `tokens` and no `handover` while this README
documented all three.

`npm test` runs the `node --test` suite: route discovery on a fixture tree, port
assignment, injection placement, `Range` handling, coverage accounting, the
supervisor's health checks and adoption, and the hub's POST allowlist.

## License

MIT.
