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
still listed, and `params` fills in the ones you have real values for.

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

## Zero dependencies, checked

`npm run check` fails if `package.json` grows a `dependencies` block or if
`src/` or `bin/` import anything that is not a `node:` builtin. `npm test` runs
the `node --test` suite: route discovery on a fixture tree, port assignment,
injection placement, and `Range` handling.

## License

MIT.
