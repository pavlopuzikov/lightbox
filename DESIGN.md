# Broadside

lightbox's design system. One stylesheet decides it: **`src/design.css`** is the
source of truth, and `src/design.mjs` reads it at import so the hub and the
overlay draw from the same values. If a colour here disagrees with that file,
the file is right and this page is stale. `lightbox tokens --key lightbox`
checks that for you.

## Why it looks like this

lightbox spends its whole working life on top of somebody else's design system.
The overlay sits in the corner of forty different sites and the hub is the page
you flip back to between them, so the one thing the chrome cannot afford to be
is tasteful-and-generic. A neutral grey panel with rounded corners and a blue
primary button is indistinguishable from the thing being reviewed, and once you
cannot tell the tool from the work, the tool is quietly editing your judgement.

So: a letterpress broadside. Cream stock, two inks, condensed wood type in the
display sizes, and horizontal rules carrying the structure that cards and badges
would carry elsewhere. It is nobody's product UI. You always know which pixels
are lightbox's.

## Ink and paper

Two inks on one sheet. Black does all the ordinary work. Vermilion is the shout
and it is spent on exactly two things: the number you came to read, and the
thing that is broken. If red starts turning up on ordinary rows, the system has
stopped working and should be pulled back.

| Token | Value | Role |
| --- | --- | --- |
| `--paper` | `#f7f3e0` | The stock. Every surface, both tools. |
| `--paper-2` | `#fcfaf0` | Log panels and keycaps, one shade brighter. |
| `--paper-tint` | `#efe9cf` | Row hover and the current route. |
| `--ink` | `#17140f` | Body text, heavy rules, solid state marks. |
| `--ink-2` | `#3a342b` | Notes, secondary actions. |
| `--ink-3` | `#6b6459` | Muted labels, unit words, disabled text. |
| `--vermilion` | `#c4161c` | The tally, failures, focus rings, the OPEN action. |
| `--vermilion-2` | `#8e1014` | Pressed and hovered red. |
| `--rule-ink` | `#d6ceb0` | Hairlines between rows. |
| `--rule-ink-2` | `#e6e0c8` | The lighter hairline, between fields in a row. |

Contrast against `--paper`, measured in the browser on the rendered hub rather
than calculated by hand: `--ink` 16.49:1, `--ink-2` 11.05:1, `--ink-3` 5.25:1,
`--vermilion` 5.42:1, `--vermilion-2` 8.44:1. Every one clears WCAG AA for body
text at any size, so no ink in the system is decorative-only.

The hovered ground matters too, because it moves every row under the cursor:
against `--paper-tint`, `--ink` is 15.07:1, `--vermilion` 4.95:1 and `--ink-3`
4.80:1. The last of those is the tightest pair in the system and it is the one
to watch. Darkening `--paper-tint` any further would push it under 4.5:1.

`--rule-ink` (1.42:1) and `--paper-tint` (1.09:1) never carry text and are not
held to a text threshold.

## Type

No webfont, ever. lightbox proxies other people's pages and reports their
network dependencies; opening a connection to a font CDN to draw its own chrome
would be both hypocritical and a new way for the tool to fail offline. The
display voice is built from condensed grotesques that ship with the OS.

| Role | Token | Stack |
| --- | --- | --- |
| Display | `--display` | Bahnschrift, Haettenschweiler, Franklin Gothic Demi Cond, Arial Narrow, Impact |
| Slab | `--slab` | Rockwell, Roboto Slab, Bookman Old Style, Georgia |
| Body | `--sans` | system UI stack |
| Data | `--mono` | system monospace |

Display is always uppercase and always condensed: the masthead, section heads,
project names, the OPEN action. Slab appears exactly once per page, on the
tally. Mono carries everything countable, plus every small-capital label, which
is what keeps ports, counts and paths aligned in a column.

Tracking follows the press rule: wood type is set tight and large, small
capitals are set wide, and the smaller they get the wider they go.

| Token | Value | Used on |
| --- | --- | --- |
| `--track-display` | `0.005em` | Masthead and other large caps. |
| `--track-caps` | `0.09em` | Section heads, labels, buttons. |
| `--track-micro` | `0.16em` | The colophon lines, top and bottom. |

## Rules

Three weights, and hierarchy is carried by weight alone. A fourth would mean the
first three had stopped meaning anything.

| Token | Value | Meaning |
| --- | --- | --- |
| `--rule-heavy` | `5px` | Closes a block. Under the masthead, above the colophon. |
| `--rule-mid` | `2px` | Opens a section. Also the progress gauge. |
| `--rule-hair` | `1px` | Separates two rows. |

No cards, no boxes, no shadows on the hub. Forty projects have to fit in two
screens, and rules cost no vertical space where padding does. The one exception
is the overlay, which floats over an arbitrary page and needs a hard edge: it
gets a 2px border and a solid 4px offset with no blur, which is a second
impression slightly off register rather than a drop shadow.

Ruled one way, a list is rows. The hub is ruled both ways, the way a broadside
sets tabular matter: heavy horizontals separate the entries, light verticals
separate the fields inside one. Without the verticals a project row is five
different kinds of fact set in one ink at one size, and you have to read it to
find out where one ends and the next begins.

The two directions are deliberately unequal. Horizontals are `--rule-ink`,
verticals are `--rule-ink-2`, which is lighter, so the eye still reads the list
as rows first and columns second. The verticals start at Notes: the state mark
and the project name are one field, and everything to the right of them is a
different kind of fact from the one before it.

Each section carries the column names once, in 9.5px mono micro-caps, and never
repeats them between rows. That head pays for itself twice: it says what the
columns are, and it lets the cells drop the unit words they used to carry, so
`6 of 15 pages` in forty rows became `6 of 15` under a heading that already
says PAGES. The head and the rows share one grid template declared in one
place, because two copies of a grid template is how a head and its body stop
agreeing.

The progress gauge belongs to the count it measures and sits directly under it,
inside the Pages cell. Floated at the bottom edge of the row it underlined the
project name instead and read as a stray rule; run the full width, a finished
project drew a 2px black line the width of the sheet and cut the list in half
in the wrong place.

Below 900px the row falls to three columns carrying six fields. The verticals
no longer line up with anything, so they go, and the head goes with them.

## The pages the tool serves itself

Five surfaces carry this system, and the last three are the ones that matter
most:

| Surface | Where |
| --- | --- |
| The hub | `src/hub.mjs` |
| The overlay | `src/overlay.js` |
| Starting a dev server | `src/hub.mjs`, the wait page |
| A directory with no index | `src/proxy.mjs` |
| A dead dev server, and a 404 | `src/proxy.mjs` |

The last two are the pages you land on when something is wrong, and they were
the last surfaces still styled from hex literals in a dark palette the rest of
the tool had stopped using. A reader who hits a 404 four levels into somebody
else's static site should still know whose chrome they are looking at, so they
carry the same stock, the same masthead and the same rules, cut down.

The 404 also carries two ways out, the project index and the hub. Without them
it was a dead end: the reader is inside a site with no navigation of its own,
which is exactly the moment they need the hub.

`test/design.test.mjs` guards all three source files, so none of them can go
back to naming a colour.

## Ornament

One engraved band, `--ornament`, a zigzag with two diamonds, repeated on the x
axis at `--ornament-height` (`9px`). It closes the masthead and opens the list
on the hub, and separates the sheet header from the route list in the overlay.

| Token | Value | Role |
| --- | --- | --- |
| `--ornament-height` | `9px` | The band, both surfaces. |

That is the whole ornament budget. It appears once per surface, which is what
keeps it a signature instead of a texture. `--ornament-red` exists for a red
impression and is currently unused; it is there so a future alert state has
something to reach for that is already in the system.

## State, without a third ink

State is carried by the fill of one square, not by a palette:

| Mark | State |
| --- | --- |
| Hollow, hairline | Stopped |
| Half filled | Starting, or installing |
| Solid black | Running |
| Solid red | Failed |

The route dots in both the hub and the overlay use the same square with the same
meaning: filled is reviewed, hollow is not. Adding a green for "healthy" was the
obvious move and it is the wrong one. It would spend the loudest thing in the
system on the most ordinary state on the page, and leave failure competing with
it for attention.

## Motion

A press does not animate. The only transitions are colour and background over
`--tap`, and nothing in the system moves anything.

| Token | Value | Role |
| --- | --- | --- |
| `--tap` | `120ms` | Every transition there is. |

`--ease` is `cubic-bezier(0.2, 0, 0, 1)`. Reduced motion removes the overlay's
fade entirely; there is nothing else to remove.

## Editing this system

Two constraints on `src/design.css`, both load-bearing and both documented in
its header:

1. **No semicolon inside a value.** `src/tokens.mjs` splits declarations on
   `;`, so a `data:image/svg+xml;base64,` URI reads as two broken declarations.
   The ornaments are percent-encoded for that reason.
2. **Colours stay literal hex**, because this table quotes them and the checker
   compares the two.

Neither surface may hardcode a colour. `test/design.test.mjs` fails if either
one does, and fails if the chrome references a `var()` this file does not
define.
