#!/usr/bin/env bun
// scripts/postinstall.ts
//
// Postinstall hook: after `bun install`, apply any pending schema migrations so
// a freshly-installed gbrain is immediately usable. Wired via package.json
// ("postinstall": "bun run scripts/postinstall.ts") as a real Bun script rather
// than an inline `node -e` one-liner.
//
// Why a script file and not an inline command:
//   Embedding a program inside the package.json postinstall string lets the
//   lifecycle shell mangle it. Bun's Windows script-runner expands `\n` in the
//   hint string into a REAL newline before node sees it, producing
//   `SyntaxError: Invalid or unexpected token` and aborting the whole install.
//   `node` is also not guaranteed present under a Bun install (bun is the
//   guaranteed runtime), and `shell: win32` re-opens a quoting surface. A
//   checked-in .ts run by `bun run` sidesteps all three.
//
// Why the CLI entrypoint is resolved from THIS script's own location, not
// `which('gbrain')`: a PATH lookup answers "what would a bare `gbrain`
// invocation resolve to" — which can be a completely different install (a
// stale global copy from a prior version, or an unrelated npm-squatted
// package) than the one `bun install` just wrote to disk. Migrating a
// freshly-installed schema through the WRONG binary's `apply-migrations` is
// exactly the failure this hook exists to avoid, so it reads `bin.gbrain`
// out of its own package.json (sibling of this script) and spawns THAT path
// directly via an argv array (no shell, nothing to quote) with an explicit
// script-file argument — never a bare command name whose meaning depends on
// PATH. It never fails the install: every path exits 0.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HINT =
  '[gbrain] postinstall skipped. If installed via bun install -g github:...: ' +
  'run `gbrain doctor` and `gbrain apply-migrations --yes` manually. ' +
  'See https://github.com/garrytan/gbrain/issues/218';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Read the CLI entrypoint from this package's own package.json (`bin.gbrain`)
// rather than hardcoding "src/cli.ts", so this stays correct if the entry
// point ever moves. Falls back to the current convention on any read/parse
// failure — this hook must never throw.
let cliRel = 'src/cli.ts';
try {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8')) as {
    bin?: Record<string, string>;
  };
  if (typeof pkg.bin?.gbrain === 'string') cliRel = pkg.bin.gbrain;
} catch {
  // Keep the fallback.
}

const cliPath = join(pkgRoot, cliRel);

if (!existsSync(cliPath)) {
  // Vendored/partial tree missing its own entrypoint entirely: skip cleanly.
  console.error(HINT);
  process.exit(0);
}

try {
  // process.execPath is the bun binary running THIS script; passing cliPath
  // as an explicit argv element (never folded into a shell string) makes bun
  // run it directly, the same as `bun run <cliPath>` — unambiguous regardless
  // of what (if anything) `gbrain` resolves to on PATH.
  const r = Bun.spawnSync({
    cmd: [process.execPath, cliPath, 'apply-migrations', '--yes', '--non-interactive'],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (r.exitCode !== 0) console.error(HINT);
} catch {
  console.error(HINT);
}

process.exit(0); // never abort the install
