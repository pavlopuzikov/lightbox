# Contributing

lightbox boots other people's projects for a living, so the bar for what it
depends on and what it claims is higher than the size of the codebase suggests.

## Running it

```bash
git clone https://github.com/pavlopuzikov/lightbox
cd lightbox
node bin/lightbox.mjs init ~/projects
node bin/lightbox.mjs serve
```

No install step. Node 18 or later. `npm test` and `npm run check` both run from
a bare clone, and that is deliberate.

For `sweep` and `tokens --runtime` you also need Playwright and axe-core, in
the project you are auditing or in a directory you pass with `--playwright`.

## The two rules that are not style preferences

**No runtime dependencies.** `npm run check` fails on a `dependencies` block in
`package.json`, and on any bare import specifier under `src/`, `bin/` or
`scripts/`. Playwright and axe-core are optional peers, resolved when a command
runs rather than imported, which is why they do not count. If you need a
library, make the case in the issue before writing the code.

**Nothing that was not measured may report as zero.** This is the defect the
tool was rebuilt around. A route that never loaded, an axe run that threw, a
stylesheet the browser could not read, a `DESIGN.md` row that did not parse:
each of those once produced output identical to a clean pass. Every check is
now pass, fail, or unmeasured, and unmeasured is counted and printed. Any new
check has to say which of the three it produced, and why.

Exit codes carry the same distinction. **1** is a finding. **2** is "this run
could not measure what you asked for". Do not collapse them.

## Touching the chrome

Colours, type, rules and spacing live in [`src/design.css`](src/design.css) and
nowhere else. `src/hub.mjs` and `src/overlay.js` may only reference them through
`var()`; `test/design.test.mjs` fails the build if either file names a colour
directly, or references a token the stylesheet does not define.

Read [DESIGN.md](DESIGN.md) before changing a value. Most of the constraints in
it are decisions with a reason attached rather than preferences, and two of them
will break the tool silently if ignored: no semicolon may appear inside a token
value, and colours have to stay literal hex.

## Before you open a pull request

```bash
npm run check        # no dependencies, no bare imports
npm run check:pack   # npm pack ships every module the CLI dispatches
npm test             # node --test
```

CI runs those on Node 18, 20 and 22, on Linux and Windows. Windows is not
optional: the tool is developed there, and path handling has broken in both
directions.

## Tests

`node --test`, no framework. A test should pin behaviour that a reasonable
change could break, and say in a sentence why the behaviour matters. Several
of the existing tests carry the story of the bug they were written for, which
is more useful to the next person than a name like `handles edge case`.

Two bugs in the current suite were found by writing the test rather than by
looking: `stop()` not clearing an adopted server's state, and the hub hanging
on an unset bridge. That is the standard worth aiming at.

## Commit messages

Say what was wrong, not what you did. `fix(supervisor): a dev server that died
went on reporting ready` is the shape. The body is where the reasoning goes,
including what you tried that did not work, because the next person will
otherwise try it too.

No em dashes.

## Things that are out of scope on purpose

- Auto-restarting a dev server that died. Detect it and report it. Resurrecting
  it hides the failure an audit exists to surface.
- Framework support in route discovery for frameworks nobody here uses. Remix
  and SvelteKit route directories are genuinely unhandled; that is a real gap,
  and a real piece of work, not a one-line addition.
- Anything that makes a partial run look complete.
