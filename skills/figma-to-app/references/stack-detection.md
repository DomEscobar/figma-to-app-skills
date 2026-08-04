# Detecting the target stack before generating code

The goal is to make the generated UI indistinguishable from code a team member
already familiar with this repo would have written — not to showcase a preferred
framework. Read this checklist before writing a single component.

## Signals to check, roughly in order of reliability

1. **`package.json` dependencies/devDependencies** — the strongest signal.
   Look for `react`, `react-dom`, `vue`, `svelte`, `solid-js`, `next`, `nuxt`,
   `astro`, `@angular/core`. Also check the `type` field (`module` vs absent) and
   `engines` for the Node version, since it affects what syntax is safe to use.

2. **Config files at the repo root**, each implying a build tool and often a
   framework: `vite.config.*`, `next.config.*`, `nuxt.config.*`,
   `svelte.config.js`, `astro.config.*`, `angular.json`, `webpack.config.js`,
   `remix.config.js`. If more than one project lives in the repo (monorepo),
   check the config nearest the package you're actually editing, not the root.

3. **Styling approach** — inspect a few existing components before assuming:
   - `tailwind.config.*` present + utility classes in existing JSX/HTML → Tailwind.
   - `*.module.css` / `*.module.scss` imports → CSS Modules.
   - `styled-components` or `@emotion/*` in dependencies → CSS-in-JS.
   - Plain `*.css`/`*.scss` imported per-component with BEM-ish class names →
     hand-written CSS; match the existing naming convention, don't introduce
     Tailwind or a CSS-in-JS library into a codebase that doesn't use one.
   - A design-system/component library already in dependencies (MUI, Chakra,
     Radix, shadcn/ui, Ant Design) → build with its primitives instead of raw
     HTML elements wherever a matching primitive exists (button, dialog, input).

4. **TypeScript vs JavaScript** — `tsconfig.json` present, or `.ts`/`.tsx` files
   in the existing component directory, means new files should match.

5. **Component/file conventions** — open two or three existing components in the
   likely target directory (usually `src/components/`, `app/`, or similar) and
   match: default vs named exports, function declaration style, prop typing
   style, where types live, and file naming (`PascalCase.tsx` vs `kebab-case.jsx`).

6. **Monorepo indicators** — `pnpm-workspace.yaml`, `turbo.json`, `nx.json`,
   `lerna.json`. If present, confirm which package/app the user actually wants
   the new UI in before generating anything; don't guess.

## No existing project (greenfield)

If there is no `package.json` at all, this is a new project, not a stack to
detect. Ask the user what they want (or state a sensible default and let them
correct it) rather than silently picking a stack — a wrong guess here means
regenerating everything later. A reasonable default when the user has no
preference: Vite + React + TypeScript, plain CSS modules (fewer dependencies to
install than Tailwind, easiest to review). Only reach for Tailwind, Next.js, or a
component library by default if the user's phrasing implies it (e.g. "make it a
Next.js app," "use shadcn").

## What NOT to do

Do not introduce a second styling system, a second component library, or a second
state-management approach alongside ones already present, even if you personally
find them cleaner — the cost of an inconsistent codebase outweighs any local
tidiness gain, and it is not what "build this Figma design" was asking for.
