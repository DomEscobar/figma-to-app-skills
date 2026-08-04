/**
 * Guards the portability contract every skill in this repo depends on: the same
 * SKILL.md has to load unchanged in Claude Code, OpenCode, Cursor and anything else
 * following the Agent Skills format. OpenCode in particular validates frontmatter
 * strictly and will refuse a skill whose `name` doesn't match its directory or whose
 * `description` is out of range — failures that show up as a skill silently not
 * existing, which is a miserable thing to debug from the agent side. Cheaper to
 * assert here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SKILLS_DIR = join(import.meta.dirname, "..", "skills");
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

function skillDirs() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, "SKILL.md")))
    .map((entry) => entry.name);
}

/**
 * Minimal frontmatter reader. Deliberately not a YAML library: the point is to see
 * what a *naive* consumer sees, since not every agent runtime parses frontmatter with
 * a full YAML parser. Only plain single-line `key: value` scalars are understood, so a
 * folded/quoted block that this can't read is itself the signal to simplify.
 */
function readFrontmatter(skill) {
  const raw = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, `${skill}/SKILL.md must start with a --- frontmatter block`);

  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (field) fields[field[1]] = field[2].trim();
  }
  return fields;
}

test("every skill has a SKILL.md with readable single-line frontmatter", () => {
  const skills = skillDirs();
  assert.ok(skills.length >= 1, "expected at least one skill");

  for (const skill of skills) {
    const { name, description } = readFrontmatter(skill);
    assert.ok(name, `${skill}: frontmatter is missing a 'name'`);
    assert.ok(description, `${skill}: frontmatter is missing a readable single-line 'description'`);
  }
});

test("skill names are kebab-case and match their directory name", () => {
  for (const skill of skillDirs()) {
    const { name } = readFrontmatter(skill);
    assert.equal(name, skill, `${skill}: frontmatter name must equal the directory name`);
    assert.match(name, NAME_PATTERN, `${skill}: name must be lowercase alphanumeric with single hyphens`);
    assert.ok(name.length <= MAX_NAME_LENGTH, `${skill}: name exceeds ${MAX_NAME_LENGTH} characters`);
  }
});

test("skill descriptions stay within the length every runtime accepts", () => {
  for (const skill of skillDirs()) {
    const { description } = readFrontmatter(skill);
    assert.ok(
      description.length <= MAX_DESCRIPTION_LENGTH,
      `${skill}: description is ${description.length} chars, over the ${MAX_DESCRIPTION_LENGTH} limit`,
    );
  }
});

test("reference files named in a SKILL.md actually exist", () => {
  for (const skill of skillDirs()) {
    const body = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
    const referenced = new Set([...body.matchAll(/references\/([A-Za-z0-9._-]+\.md)/g)].map((m) => m[1]));
    for (const file of referenced) {
      assert.ok(
        existsSync(join(SKILLS_DIR, skill, "references", file)),
        `${skill}/SKILL.md points at references/${file}, which does not exist`,
      );
    }
  }
});
