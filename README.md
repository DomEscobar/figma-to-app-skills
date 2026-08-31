# Figma → App skills

Four [Agent Skills](https://github.com/anthropics/skills) that replace the paid
Figma Dev Mode MCP with a free, scriptable pipeline: read a Figma design over the
plain REST API, generate code in whatever stack your project already uses, and
verify the result against the design with an automated visual-fidelity loop instead
of eyeballing screenshots.

No MCP server, no Dev Mode seat, no vendor lock-in — just a `SKILL.md` per skill
plus Node scripts, following the same open format Claude Code, OpenCode, Cursor, and
most other coding agents already discover skills from. Any one agent can run this end
to end; nothing here is written against a specific agent's tool-calling API. The
Figma-side scripts need nothing but Node itself; only the browser-based verification
step pulls in dependencies.

## Why this exists

The official Figma MCP server requires a paid Dev Mode seat per user. A personal
access token and the REST API get you the design data for free, and the visual
fidelity loop verifies the result more rigorously than Dev Mode's static annotations
do.

"Free" has two real limits worth knowing before you start rather than after:
**[rate limits](#rate-limits--read-this-before-your-first-fetch)** are severe on a
Free/Starter plan, and **[some data is plan-gated](#whats-plan-gated)** — notably
Variables, i.e. design tokens.

## The four skills

| Skill | Does |
| --- | --- |
| [`figma-to-app`](skills/figma-to-app/SKILL.md) | Orchestrator. Detects your project's stack, then runs the other two in sequence. Trigger this one for the end-to-end task. |
| [`figma-design-context`](skills/figma-design-context/SKILL.md) | Fetches a Figma file/frame via REST API + personal access token, simplifies it to compact YAML (layout, colors, type, components, interactive states), and exports referenced icons/images as real files. |
| [`visual-fidelity-loop`](skills/visual-fidelity-loop/SKILL.md) | Deterministically screenshots a running implementation, pixel-diffs it against the Figma reference, and runs structured CSS-property assertions — so an agent can iterate to a real match instead of guessing when it's "close enough." |
| [`figma-responsive-implementation`](skills/figma-responsive-implementation/SKILL.md) | Production-oriented acceptance harness for structured Figma or screenshot-only implementation: responsive probes, design-scale and geometry checks, localized pixel diffs, accessibility/state gates, protected contracts, adversarial evals, and optional DINOv2 diagnostics. |

Each skill works standalone too — e.g. use `figma-design-context` alone to audit a
design system's colors and spacing without building anything.

## Quick start

After [installing](#install) and exporting a token, just ask your agent, with a link
to the **specific frame** you want (select the frame in Figma → Copy link to
selection, so the URL carries a `node-id`):

> Build this in my app: https://www.figma.com/design/KEY/File?node-id=43-44

The agent picks up `figma-to-app` and runs extract → generate → verify. To use the
extraction on its own:

```bash
cd skills/figma-design-context/scripts
node get-context.mjs "https://www.figma.com/design/KEY/File?node-id=43-44" --out frame.yaml
# or, when you have the key and id separately:
node get-context.mjs KEY --node-id 43-44 --out frame.yaml
```

Why a frame link and not a file link: a whole-file fetch costs the same scarce budget
as the one frame you needed, returns far more than you can use, and is the request
most likely to time out. See below.

## Rate limits — read this before your first fetch

On a **Free/Starter** plan the file-reading endpoints (`GET file`, `GET file nodes`,
and image rendering) allow only a handful of requests **per month**. The budget is
per token and shared across every file that token can reach, so exhausting it locks
you out of all of them at once. Measured on a Starter file, Figma answered
`Retry-After: 395866` — **4.6 days** — and it does not clear early.

What follows from that:

- **Fetch one frame, once.** Pass a `node-id`. What the budget counts is the *number*
of requests, not their size, so the thing to avoid is exploring a file across several
calls.
- **Leave the on-disk `.figma-cache/` alone.** It is why the skills keep working after
a lockout; `--no-cache` while iterating is the fastest way to lose access for the rest
of the month.
- **Not everything is blocked.** Image fills, components, styles and metadata sit in
separate, far more generous buckets and keep working through a lockout.
- **Don't sleep through a 429.** Figma's own documented backoff example waits for
whatever `Retry-After` says, which here would hang a process for days. The bundled
client caps its wait and reports the real reset time instead.

Paid plans are not in the same league: a Dev or Full seat on Professional gets 10
requests **per minute**. The full tier table is in
[`references/figma-rest-api.md`](skills/figma-design-context/references/figma-rest-api.md),
and the measured findings are in [`FINDINGS.md`](FINDINGS.md).

## What's plan-gated

- **Variables (design tokens) are Enterprise-only.** On lower plans `boundVariables`
still appears on nodes but resolves to bare ids with no way to look up a name or
value. Named styles are the recoverable substitute, so the extractor hoists those by
name.
- **`GET /v1/files/:key/components` lists only *published* team-library components.**
For a normal or duplicated file it returns nothing, which is why variant axes are read
out of the component set in the file itself.
- **Prototype interactions and variant states need no extra call or scope** — they are
part of the same node payload as layout and fills, so hover/pressed states cost
nothing on top of the frame you already fetched.

## Install

```bash
node install.mjs          # copy each skill into every location below
node install.mjs --link   # or symlink, so edits in this repo take effect immediately
```

By default this installs into all four locations coding agents read skills from,
so it doesn't matter which one you're using:

| Target | Path | Read by |
| --- | --- | --- |
| `agents` | `~/.agents/skills/` | the vendor-neutral Agent Skills standard; anything that follows it |
| `claude` | `~/.claude/skills/` | Claude Code (and OpenCode, which also reads this path) |
| `opencode` | `~/.config/opencode/skills/` | OpenCode's own skill directory |
| `cursor` | `~/.cursor/skills-cursor/` | Cursor |

Narrow it to specific agents with `--targets`, or install into a project instead of
your home directory with `--project` (useful if you want the skills committed
alongside one specific app rather than available globally):

```bash
node install.mjs --targets claude,opencode
node install.mjs --project ../my-app        # writes <path>/.claude/skills/, etc.
node install.mjs --uninstall                # mirrors whatever --targets/--project you pass
```

A copy install deliberately leaves out `node_modules` and the API response cache, so
`visual-fidelity-loop` needs its own `npm install` wherever it was copied to. `--link`
shares this repo's dependencies instead and avoids that.

## Requirements

- Node.js ≥ 20 — the Figma-side scripts use only built-in `fetch` and have no
dependencies. `visual-fidelity-loop` additionally needs Playwright; see that skill's
Prerequisites section.
- A Figma **personal access token** (Settings → Security → Personal access tokens),
scoped at minimum to `file_content:read`. Works on every plan, including Free — this
is not the same thing as a Dev Mode seat, but do read the rate limits above.

```bash
export FIGMA_API_KEY="figd_..."
```

## Repo layout

```
skills/
  figma-to-app/            orchestrator: stack detection + workflow
  figma-design-context/    Figma REST API -> simplified YAML + asset export
  visual-fidelity-loop/    deterministic capture, pixel diff, structured CSS checks
  figma-responsive-implementation/  protected responsive acceptance contract + eval harness
install.mjs                deploys skills to every agent's skill directory (see Install)
FINDINGS.md                measured API behaviour, verification status, known gaps
```

[`FINDINGS.md`](FINDINGS.md) is worth reading before relying on this: it records what
has actually been verified against a real file and token versus what is only taken
from Figma's docs, and lists the known gaps.

## Tests

```bash
npm install   # dev-only: a YAML parser, used to round-trip the emitter's output
npm test
```

`npm test` runs every skill's suite with Node's built-in test runner. The skills
themselves stay dependency-free — the dev dependency exists only so the hand-rolled
YAML emitter can be checked against a real parser instead of against itself, under
both YAML 1.1 and 1.2.

Tests whose dependencies aren't installed are skipped with a message naming what to
install and where, so this works on a fresh clone. `visual-fidelity-loop`'s image
tests need that skill's own `npm install` and are skipped until then.
