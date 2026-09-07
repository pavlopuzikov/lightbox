# Security

## What lightbox is, in security terms

It starts dev servers on your machine, proxies them, and injects a script into
every HTML response. That is a lot of trust, so it is worth being precise about
where the boundaries are.

- **Everything binds to loopback.** The hub, the review ports and the dev
  servers listen on `127.0.0.1`. There is no authentication on any of them,
  because there is nothing to authenticate: anything that can reach the port is
  already running as you. Do not put lightbox behind a tunnel or a reverse
  proxy on a shared machine.
- **It runs the commands in your config.** `lightbox serve` executes each
  project's dev command, resolved from that project's `node_modules/.bin` or
  taken verbatim from a `command` entry in `lightbox.config.json`. A config
  file is executable input. Treat one you did not write the way you would treat
  a shell script you did not write.
- **It adopts whatever answers the port.** If something is already listening on
  a project's upstream port, lightbox proxies to it. A TCP connect tells you
  something answered and nothing more, so there is no identity check to make.
  The state and the hub row both say `adopted` when this happens.
- **`lightbox login` stores a real session.** The storage state it writes holds
  cookies for a logged-in account. It goes where you point `--out`; it is not
  encrypted, and it should not be committed.
- **`.lightbox/` holds your notes and screenshots**, including full-page
  captures of authenticated pages. It is local state, not something to publish.
  `lightbox.config.json` names every directory on your disk that you audit.
  Neither is in this repository, and neither should be in yours.

## Dependencies

There are none at runtime. `npm run check` fails the build if that changes.
Playwright and axe-core are optional peers used by `sweep` and
`tokens --runtime`, resolved from your own project when those commands run.
This is not a security feature by itself, but it does mean the attack surface
of an install is the code in this repository and nothing else.

## Reporting something

Open a private security advisory on the GitHub repository
(<https://github.com/pavlopuzikov/lightbox/security/advisories/new>), or open a
normal issue if it is not sensitive.

This is a personal tool maintained in spare time. There is no SLA. Expect a
reply in days rather than hours, and no backports: fixes land on the current
version.
