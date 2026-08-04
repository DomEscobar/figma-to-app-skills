# Findings & status

What was learned building these skills that isn't obvious from the code, plus an
honest account of what is verified and what isn't. Endpoint-level API detail lives in
[`figma-rest-api.md`](skills/figma-design-context/references/figma-rest-api.md); this
file is the operational summary and the record of what's been proven.

Findings are marked **measured** (observed against a real file and token) or
**documented** (from Figma's docs, not independently confirmed here).

## 1. The rate limit is the dominant constraint on a free plan

**Measured.** On a Starter-plan file, the Tier 1 endpoints — `GET file`,
`GET file nodes`, and image rendering — allow only a handful of requests per month.
After roughly a dozen calls, Figma answered `429` with `Retry-After: 395866`: **4.6
days**. Verified to be seconds by polling twice 20s apart and watching the value drop
by exactly 20.

Three properties make this worse than a normal throttle:

- **It's per token, across all files.** The lockout applied to an unrelated file the
same token could reach. It is not per-file.
- **It does not clear early.** There is no way to buy out of it mid-task.
- **`Retry-After` can exceed any sane process lifetime.** Figma's own documented
backoff example sleeps for whatever the header says, which here would hang a process
for days. `lib/client.mjs` therefore caps its wait and treats anything longer as
terminal, reporting the reset time instead.

**What counts is the number of requests, not their size.** Figma documents a
leaky bucket over request counts and does *not* document any weighting by response
size. An earlier draft of these docs claimed a whole-file fetch costs "orders of
magnitude more budget" than a single frame — that was inference, and it's been
removed. Preferring `--node-id` is still right, but for payload size, `400`/`500`
timeout avoidance, and because it answers the question in *one* call rather than an
exploratory sequence.

**Measured:** the header reports `X-Figma-Plan-Tier: starter` together with
`X-Figma-Rate-Limit-Type: high`. Figma's published table leaves the Starter+Dev/Full
cell blank, so `high` here has no documented number — and it plainly isn't the
10/min that `high` means on Professional. Treat Starter as an undocumented, very long
window.

**Measured:** Tier 2 (`GET image fills`) and Tier 3 (`GET file metadata`,
components, styles) kept returning `200` throughout the lockout. Asset image fills
and metadata survive; rendered SVG/PNG exports do not, because rendering is Tier 1.

Practical consequence: the on-disk cache is not a performance nicety, it is what
makes the skill usable at all. During the lockout, extracting the cached frame —
including its interaction data — still worked end to end.

## 2. What the API gives you on a free plan, and what it doesn't

- **Variables (design tokens) are Enterprise-only** (*documented*). On lower plans,
`boundVariables` still appears on nodes but resolves to ids with no way to look up
name or value. Named styles are the recoverable substitute, which is why the
extractor hoists them by name.
- **`componentPropertyDefinitions` is frequently absent** on `COMPONENT_SET` nodes
(*measured*, on a 360-variant button kit). Variant axes therefore have to be derived
by parsing the `Axis=Value` convention out of child component names. Both paths are
implemented, declared definitions winning when present.
- **`GET /v1/files/:key/components` returned zero components** for a duplicated
community file (*measured*). It lists only *published team-library* components, so it
is not a substitute for reading the component set out of the file itself.

## 3. Interactive states come for free, in the same payload

There is no separate endpoint or cost for states: `interactions` and
`variantProperties` ride along in the same node payload as layout, fills and text.
The two express different things and both are needed — prototype `interactions` say
what *triggers* a change, a component set's variant axes say which states *exist*.

The load-bearing distinction is `reverts`: a trigger that reverts (Figma's
`ON_HOVER`, `ON_PRESS`) is a CSS pseudo-class, while a non-reverting one
(`MOUSE_ENTER`, `ON_CLICK`) is real application state. Getting this backwards
produces hover effects that stick. Details in
[`interactive-states.md`](skills/figma-design-context/references/interactive-states.md).

Unit note: Figma expresses durations in **seconds**, CSS in milliseconds. The
extractor normalizes to `"150ms"` strings so this can't be missed.

## 4. The YAML output had to be hardened against YAML 1.1

The emitter is hand-rolled to keep the scripts dependency-free, which made it the
riskiest untested component: its output *is* the product. Round-trip testing it
against a real parser found ten defects, two of them serious:

- **A layer named `Email:` produced unparseable YAML.** A trailing colon ends a plain
scalar early. Entirely ordinary name in a form design.
- **Node ids were silently corrupted under YAML 1.1.** `1:23` is the API's node id
format and appears on every node; YAML 1.1 resolves it as sexagesimal **83**. YAML
1.2 doesn't — but PyYAML and libyaml implement 1.1, so anyone parsing the output with
a script rather than a model got wrong ids.

Also fixed: hex/octal/binary-looking names coerced to numbers, single-letter `y`/`N`
coerced to booleans (1.1), CR silently dropped from CRLF text, leading spaces eaten
by block scalars, and trailing newlines lost to unconditional `|-` chomping.

Quoting is now deliberately conservative — the union of 1.1 and 1.2 resolution rules
— and every test asserts the round trip under **both** versions. Cost on a real
frame: **1.4%** more bytes. Worth it, since the alternative is silent corruption.

## 5. The installer was shipping things it shouldn't

**Measured.** A copy install carried `node_modules` (18.6 MB) *and*
`scripts/.figma-cache/` — the cached API responses for whichever Figma file was last
fetched. On a `--project` install that would have landed one user's design data in
someone else's repository, and a stale cache would have answered requests for a file
it didn't belong to. Both are now excluded; the payload dropped to **256 KB**.

The trade-off is that a copied `visual-fidelity-loop` needs its own `npm install`
where it now lives, which the installer prints. `--link` avoids this by sharing the
repo's dependencies.

## 6. Verification status

| Component | Status |
| --- | --- |
| `figma-design-context` extraction, layout, paint, text, styles | Unit-tested |
| YAML emitter | Round-tripped against a real parser under YAML 1.1 and 1.2 |
| Prototype interactions, variant axes | Unit-tested; variant name parsing checked against real button-kit names |
| Rate-limit retry / fail-fast logic | Unit-tested, and the 429 path observed live |
| `visual-fidelity-loop` image normalization, CLI parsing | Unit-tested |
| `capture.mjs`, `check-styles.mjs`, `diff.mjs` end to end | Run against a live page: capture succeeded, 20/20 style checks passed, diff ratio 0.43% |
| Full pipeline on a real design | Done once, on a portfolio frame: fetch → YAML → asset export → hand-written HTML → screenshot → diff |
| Cross-agent frontmatter rules | Enforced by a repo-level test |
| Install / delivery path | Verified into a scratch project: 256 KB payload, no dependencies or API cache copied |
| Determinism injection (`lib/determinism.mjs`) | Exercised by the demo runs only; no unit test (needs a browser) |
| Whole component-set extraction (360 variants) | **Not done** — blocked by the rate limit until ~9 Aug |

62 tests pass. On a fresh clone, tests whose dependencies aren't installed are
skipped with instructions rather than failing.

## 7. Known gaps

- **The 360-variant component set has never been extracted end to end.** The variant
parsing is unit-tested against real names taken from that kit, but the full
fetch → YAML path for a component set is unproven. This is the one item genuinely
waiting on the rate-limit reset.
- **No unit test for `injectDeterminism`.** It needs a real browser; it has only been
exercised by the demo runs.
- **`position: absolute` doesn't model Figma's `constraints`.** A node pinned to the
right or centre in Figma is emitted with a left/top offset, which won't reflow the
same way. Noted in `output-schema.md`.
- **Smart Animate has no CSS equivalent.** It's reported as-is and needs a judgement
call at codegen time.
- **The pipeline has been proven on one frame, one stack (hand-written HTML/CSS).**
Stack detection for React/Vue/Tailwind projects is documented but has not been run
against a real project of each kind.
