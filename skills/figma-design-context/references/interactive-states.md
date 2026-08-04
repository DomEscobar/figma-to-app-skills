# Interactive states: hover, pressed, focus, and prototype behavior

A Figma file expresses interactivity in two independent places, and a design can use
either without the other. Both are extracted; you usually need to read both to
generate a component that actually behaves:

| Source                | Extracted as                        | Answers                        |
| --------------------- | ----------------------------------- | ------------------------------ |
| Variant axes of a component set | `variantProperties` on the `COMPONENT_SET` node | *Which states exist* (`State: [default, hover, pressed]`) |
| Prototype interactions | `interactions` on any node          | *What triggers a change, and what it changes to* |

A designer who built a hover variant but never wired a prototype connection to it
produces `variantProperties` with no `interactions`. That is still a hover state
worth generating — do not treat a missing prototype connection as "no hover state."

## The distinction that decides your implementation

Figma has two categories of trigger that look identical in the Figma UI but mean
categorically different things in code. This extractor surfaces it as `reverts`:

- **`reverts: true`** (`ON_HOVER`, `ON_PRESS`) — the change is undone when the
  trigger ends. This is a CSS pseudo-class. Generate `:hover` / `:active`, not state.
- **no `reverts`** (`MOUSE_ENTER`, `MOUSE_LEAVE`, `MOUSE_DOWN`, `MOUSE_UP`,
  `ON_CLICK`) — the change is permanent one-way navigation. This needs real
  application state (a `useState`, a class toggle, a route change).

Getting this backwards produces the two classic failures: a hover style that sticks
after the pointer leaves, or a toggle that reverts the instant you stop pressing it.

## Mapping variant states to CSS

Figma's own guidance maps variant state names onto CSS selectors as follows, and
generated code should follow the same convention so the result is idiomatic rather
than JS-driven for things CSS already does:

| Variant value      | CSS                     |
| ------------------ | ----------------------- |
| `State=Default`    | the base rule           |
| `State=Hover`      | `:hover`                |
| `State=Pressed`    | `:active`               |
| `State=Focused`    | `:focus-visible`        |
| `State=Disabled`   | `:disabled` / `[aria-disabled]` |

Two notes on doing this well:

**Emit the delta, not the whole variant.** A `changeTo` action names a destination
variant node (`to`, plus `toVariant: "State=hover"` when component metadata was
available). Diff that variant's styles against the default variant and put only what
differs in the `:hover` rule. Re-emitting every property of the hover variant
produces rules that fight the base rule and drift the moment someone edits the
default.

**Expect the destination node to be missing from your extraction.** Component sets
usually live on a separate page from the screens that use them, so a `to` id often
points outside the frame you fetched. That is normal, not a bug — fetch it directly
by node id, which is cheap because you know exactly which node you need:

```bash
node scripts/get-context.mjs "https://www.figma.com/design/<fileKey>/x?node-id=<to-id>"
```

Do this once per state you need rather than re-fetching the whole file.

**A state variant that only differs in fill does not need a separate component.**
Variant axes are how Figma models what CSS models with pseudo-classes and props —
one component with a `variant`/`size` prop plus pseudo-class rules, not one
component per variant combination. A 120-variant button set is 3 types x 2 sizes x 5
states, not 120 components.

## Transitions

A `changeTo`/`navigate` action may carry a `transition`, already normalized to CSS
vocabulary:

```yaml
transition: { type: smartAnimate, duration: "150ms", easing: ease-out }
```

`duration` and `easing` translate directly into a CSS `transition`. Two caveats:

- `type: smartAnimate` means Figma interpolated *matched layers* between the two
  variants (position, size, corner radius, color). CSS can reproduce this only for
  properties that are actually animatable on the same element — it is not a
  general-purpose morph. Animate the properties that differ; don't try to reproduce
  smart-animate's layer matching.
- Spring easings (`GENTLE_SPRING`, custom springs) have no CSS timing-function
  equivalent and come through as `easing: { figmaEasing: GENTLE_SPRING }` rather
  than being silently flattened to something wrong. Approximate with a
  `cubic-bezier()` or a spring library, and say which you chose.

## Units: trust the value, not the docs

Figma's REST documentation states that trigger `timeout`, trigger `delay`, and
transition `duration` are in milliseconds. Observed responses return **seconds**
(a real `AFTER_TIMEOUT` trigger came back as `0.800000011920929` for an 800ms
delay). This extractor assumes seconds and emits normalized `"800ms"` strings. If
you ever see an implausible duration (`"0ms"`, or something in the minutes), that
assumption is what to check first.

## What is dropped, and why

- **Triggers whose actions are all `null` or empty.** Real files contain these: a
  designer deletes an action and the orphaned trigger stays behind. It describes an
  intent with no effect, so there is nothing to generate. (Observed in the wild, so
  this is not a hypothetical case.)
- **Unknown trigger types** are skipped; **unknown action types** are passed through
  by name so you can look them up rather than wonder why a button does nothing.

## What the REST API cannot give you

- **Variable-driven states.** `setVariable` / `setVariableMode` actions come through
  as opaque variable/collection ids. Resolving those ids to names and values needs
  the Variables REST API, which is Enterprise-only (see `figma-rest-api.md`). On
  Free/Professional you can see *that* a variable is set, not *what* it becomes.
- **Focus and disabled states that were never designed.** If the file has no
  `State=Focused` variant, nothing in the API invents one — but shipped UI still
  needs a visible focus style for accessibility. Add one and tell the user you did,
  rather than shipping a component that is only reachable by mouse.
