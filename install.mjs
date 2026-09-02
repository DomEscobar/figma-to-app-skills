#!/usr/bin/env node
/**
 * Installs (or symlinks) every skill in `skills/` into the skill directories that
 * coding agents actually read. These skills are plain Anthropic-style SKILL.md
 * packages — no agent-specific format — so "installing" just means copying them
 * to the right folder(s) for whichever agent(s) you use:
 *
 *   agents   ~/.agents/skills/<name>/        the vendor-neutral Agent Skills standard
 *   claude   ~/.claude/skills/<name>/        Claude Code (also read by OpenCode)
 *   opencode ~/.config/opencode/skills/<name>/   OpenCode's own directory
 *   cursor   ~/.cursor/skills-cursor/<name>/ this environment's Cursor-specific path
 *
 * By default all four are installed, since they're cheap to keep in sync and you
 * may switch agents later. Use `--targets` to narrow it down.
 *
 * Usage:
 *   node install.mjs                        # copy into every target above (global)
 *   node install.mjs --link                 # symlink instead, so edits here take effect immediately
 *   node install.mjs --targets claude,opencode
 *   node install.mjs --project ./my-app     # install into <project>/.claude/skills etc.
 *                                            # instead of the home-directory locations
 *   node install.mjs --uninstall [--targets ...] [--project ...]
 */

import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm, symlink, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SKILLS_DIR = resolve(import.meta.dirname, "skills");

/**
 * Never copied into an installed skill. `node_modules` because it's ~19 MB of
 * reinstallable content that also embeds absolute paths, and `.figma-cache` because
 * it holds cached API responses for whatever Figma file was last fetched — shipping
 * that would leak one user's design data into every agent directory, and into version
 * control on a `--project` install.
 */
const EXCLUDED_FROM_COPY = new Set(["node_modules", ".figma-cache"]);

// Each target's `dir(root)` receives either the home directory (global install)
// or the `--project` path (project-scoped install), so the same table drives both.
const TARGETS = {
  agents: { label: "Agent Skills standard (~/.agents/skills)", dir: (root) => join(root, ".agents", "skills") },
  claude: { label: "Claude Code (~/.claude/skills)", dir: (root) => join(root, ".claude", "skills") },
  opencode: {
    label: "OpenCode (~/.config/opencode/skills)",
    dir: (root, isProject) => (isProject ? join(root, ".opencode", "skills") : join(root, ".config", "opencode", "skills")),
  },
  cursor: {
    label: "Cursor (~/.cursor/skills-cursor)",
    dir: (root, isProject) => (isProject ? null : join(root, ".cursor", "skills-cursor")),
  },
};
const DEFAULT_TARGET_IDS = Object.keys(TARGETS);

async function listSkillNames() {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(SKILLS_DIR, name, "SKILL.md")));
}

async function removeExisting(targetPath) {
  if (!existsSync(targetPath)) return;
  const stat = await lstat(targetPath);
  if (stat.isSymbolicLink()) await rm(targetPath, { force: true });
  else await rm(targetPath, { recursive: true, force: true });
}

function resolveTargets(ids) {
  const unknown = ids.filter((id) => !TARGETS[id]);
  if (unknown.length) {
    throw new Error(`Unknown target(s): ${unknown.join(", ")}. Valid targets: ${DEFAULT_TARGET_IDS.join(", ")}`);
  }
  return ids.map((id) => ({ id, ...TARGETS[id] }));
}

async function install({ link, targetIds, projectRoot }) {
  const names = await listSkillNames();
  if (!names.length) {
    console.error(`No skills with a SKILL.md found under ${SKILLS_DIR}`);
    process.exitCode = 1;
    return;
  }

  const root = projectRoot ?? homedir();
  const isProject = Boolean(projectRoot);
  const targets = resolveTargets(targetIds);

  for (const target of targets) {
    const targetRoot = target.dir(root, isProject);
    if (!targetRoot) {
      console.log(`skip     ${target.label} — no project-scoped convention, use a global install instead`);
      continue;
    }

    await mkdir(targetRoot, { recursive: true });
    for (const name of names) {
      const source = join(SKILLS_DIR, name);
      const dest = join(targetRoot, name);
      await removeExisting(dest);

      if (link) {
        // 'junction' works for directories on Windows without elevated privileges,
        // unlike a real symlink; on POSIX it behaves like a normal directory symlink.
        await symlink(source, dest, "junction");
      } else {
        await cp(source, dest, {
          recursive: true,
          filter: (from) => !from.split(/[\\/]/).some((segment) => EXCLUDED_FROM_COPY.has(segment)),
        });
      }
    }
    console.log(`${link ? "linked" : "copied"}   ${names.length} skill(s) -> ${targetRoot}  (${target.label})`);
  }

  if (!link) {
    console.log("\nRe-run this script after editing a skill in this repo — copies don't auto-update.");
    // Dependencies are deliberately not copied, so copied browser skills need a
    // local install before their scripts can run.
    console.log(
      "Browser skills need dependencies installed in each copied location:\n" +
        "  cd <skills-dir>/visual-fidelity-loop/scripts && npm install && npx playwright install chromium\n" +
        "  cd <skills-dir>/figma-browser-capture/scripts && npm install && npx playwright install chromium\n" +
        "Use --link instead to share this repo's already-installed dependencies.",
    );
  }
}

async function uninstall({ targetIds, projectRoot }) {
  const names = await listSkillNames();
  const root = projectRoot ?? homedir();
  const isProject = Boolean(projectRoot);
  const targets = resolveTargets(targetIds);

  for (const target of targets) {
    const targetRoot = target.dir(root, isProject);
    if (!targetRoot) continue;
    for (const name of names) {
      const dest = join(targetRoot, name);
      if (existsSync(dest)) {
        await removeExisting(dest);
        console.log(`removed  ${dest}`);
      }
    }
  }
}

function parseArgs(argv) {
  const args = { link: false, uninstall: false, targetIds: DEFAULT_TARGET_IDS, projectRoot: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--link") args.link = true;
    else if (arg === "--uninstall") args.uninstall = true;
    else if (arg === "--targets") args.targetIds = argv[++i].split(",").map((s) => s.trim());
    else if (arg === "--project") args.projectRoot = resolve(argv[++i]);
    else if (arg === "--help") {
      console.log(
        `Usage: node install.mjs [--link] [--targets ${DEFAULT_TARGET_IDS.join(",")}] [--project <dir>] [--uninstall]`,
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.uninstall) {
  await uninstall(args);
} else {
  await install(args);
}
