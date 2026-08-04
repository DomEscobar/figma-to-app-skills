/**
 * Shared CLI parsing for this skill's scripts.
 *
 * Hand-rolled, to keep the dependency footprint at Playwright and two image
 * libraries — but centralized, because all three scripts need the same two
 * guarantees and got them wrong independently:
 *
 * 1. An unrecognized flag must fail loudly. These scripts decide whether an
 *    implementation "matches" the design, and a typo'd `--max-diff-ration` that is
 *    silently ignored means the default threshold quietly renders the verdict
 *    instead — the worst possible failure for a verification tool.
 * 2. A flag declared numeric must actually be a number. `Number(true)` is 1 and
 *    `Number("abc")` is NaN, so a flag given no value or a bad one used to sail
 *    through into a threshold comparison.
 */

/** A user-fixable invocation problem, as opposed to a bug worth a stack trace. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    // Subclassing Error otherwise leaves `name` as "Error", which hides the
    // distinction from anything that reports errors by name.
    this.name = "UsageError";
  }
}

/**
 * @param {string[]} argv
 * @param {{ flags: Record<string, "string"|"number"|"boolean">, required?: string[] }} spec
 */
export function parseArgs(argv, { flags, required = [] }) {
  const args = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === "-h" || token === "--help") {
      args.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new UsageError(`Unexpected argument "${token}" — every value must follow its flag.`);
    }

    const key = token.slice(2);
    const kind = flags[key];
    if (!kind) throw new UsageError(`Unknown option "--${key}". Run with --help for the supported ones.`);

    if (kind === "boolean") {
      args[key] = true;
      continue;
    }

    const value = argv[++i];
    // A following `--flag` means the value was omitted; a bare negative number is fine.
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`Option "--${key}" needs a value.`);
    }
    if (kind === "number") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new UsageError(`Option "--${key}" needs a number, but got "${value}".`);
      }
      args[key] = parsed;
    } else {
      args[key] = value;
    }
  }

  if (args.help) return args;

  const missing = required.filter((key) => args[key] === undefined);
  if (missing.length) {
    throw new UsageError(`Missing required option(s): ${missing.map((key) => `--${key}`).join(", ")}.`);
  }
  return args;
}

/**
 * Wraps a script's `main` so a UsageError prints the help text and exits 1, while a
 * genuine bug still surfaces its stack.
 */
export function runCli(main, printHelp) {
  main().catch((error) => {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n`);
      printHelp();
    } else {
      console.error(error?.stack || error?.message || error);
    }
    process.exitCode = 1;
  });
}
