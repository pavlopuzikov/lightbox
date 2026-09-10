# Pending

Blocked or deferred work, carried between sessions. Delete an entry when it lands.

## The always-on hub loop still crash-loops. One word fixes it.

Opened 2026-09-10. **Blocked on a tool restriction, not on a decision.**

`scripts/hub-loop.cmd:25` guards its restart with

```
s.listen(4000,'127.0.0.1')
```

while `src/index.mjs:33` binds the hub with `server.listen(port, "0.0.0.0")`. On Windows
those are different addresses and both can be held at once, so the guard passes while the
hub is already up, `serve` then fails `EADDRINUSE`, and the loop retries every ten seconds
forever. Reproduced live against the running hub: the `127.0.0.1` probe returned BOUND OK
and the `0.0.0.0` probe returned `EADDRINUSE` at the same moment.

**The fix is `'127.0.0.1'` to `'0.0.0.0'` on that one line.** Claude Code's auto-mode
classifier refuses to edit a `.cmd` file, so it needs a human hand or a session in a
different permission mode.

Half of this is already done and shipped: `serve()` exits **3** on a port clash so the loop
can tell "someone else holds the hub, wait" from "the hub crashed, restart", and
`.lightbox/serve.log` now carries a readable one-line reason instead of a stack. The loop
just cannot act on it yet, because it never gets that far.

`serve.log` recorded **82** consecutive failures when this was found and **645** by the end
of that day. The loop went quiet at 10:37 and has not written since, so nothing is burning
right now, but the next trigger starts it again.

Suggested follow-on once the probe matches: exponential backoff in the `.cmd`, capped
around five minutes after three consecutive failures, and a case in
`test/supervisor.test.mjs` asserting a `0.0.0.0`-bound server reads as occupied.
