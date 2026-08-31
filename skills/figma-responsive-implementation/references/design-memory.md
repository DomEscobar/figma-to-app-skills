# Design memory

The application code and its token files remain authoritative. `design-system.snapshot.json` is a deterministic, regenerable index that lets later agents reuse what has already been discovered.

## Files

- `design-memory.config.json` defines scanned roots, design-bearing properties, and universally permitted structural literals.
- `design-system.snapshot.json` records source hashes, detected stack, token definitions, component files, breakpoints, Figma-to-code mappings, and scanner findings.
- `design-decisions.json` stores reviewed mappings and narrowly scoped exceptions with provenance. It is not a dumping ground for arbitrary values.
- `responsive-contract.json` remains the protected acceptance contract for one screen and its states/viewports.

## Value policy

1. Reuse an existing semantic token when one fits.
2. Add a token through the application's existing token mechanism when a value is semantic or repeated.
3. Keep a truly unique illustration or component geometry value local as a custom property or constant.
4. Use `approvedLiterals` only when a literal cannot reasonably be expressed through the existing system. Scope it to a property and file, explain why, and record provenance.

The scanner rejects a literal that duplicates a known token (`raw-token-value`), a new unexplained literal (`unknown-design-value`), unresolved token references/mappings, and a snapshot whose token/stack/config/decision hash no longer matches (`design-memory-stale`). Ordinary component edits that only reuse known tokens do not stale the snapshot.

## Trust boundary

The implementation agent may read the snapshot but may not regenerate it, edit decisions, relax scanner configuration, or change schemas. A trusted setup/review step creates those inputs before implementation. After an approved token-system change, the trusted runner regenerates and re-seals the snapshot. CI verifies hashes and runs `check`, so editing the snapshot alone cannot hide a token-system or reviewed-policy change.

The scanner is deliberately conservative and does not replace framework-native linting. Configure the real source roots and design-bearing properties during setup, then keep that configuration protected.
