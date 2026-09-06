/**
 * #3661 — `gbrain config set` must reject a flag it does not implement
 * instead of dropping it and writing anyway.
 *
 * The bug: `gbrain config set models.tier.subagent <value> --dry-run` printed
 * the normal "Set <key> = <value>" confirmation and persisted the mutation to
 * the DB config plane. `--dry-run` is implemented by sync/import/extract/
 * quarantine/pages, so an operator who had learned that habit got a live
 * config write where they expected a preview.
 *
 * These tests spawn the real CLI against a throwaway PGLite brain and assert
 * on BEHAVIOR — exit code plus the value `config get` reports afterwards — not
 * on the source text of the handler. The write-didn't-happen assertion is the
 * load-bearing one: an implementation that errors AFTER `engine.setConfig`
 * would still pass an exit-code-only test.
 *
 * Pre-fix, the two rejection tests fail on exit code AND on the persisted
 * value; the control tests pass on both trees (they pin the regression).
 *
 * Serial: spawns subprocesses against a pinned GBRAIN_HOME tmpdir.
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runConfig } from '../src/commands/config.ts';
import { withEnv } from './helpers/with-env.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const KEY = 'models.tier.subagent';
const BASELINE = 'anthropic:claude-haiku-4-5';

let home: string;
let dbPath: string;

function cliEnv(): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    HOME: home,
    GBRAIN_HOME: home,
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    // Neutralize ambient routing signals from the invoking shell/CI so the
    // spawns can only ever reach the throwaway brain created below.
    GBRAIN_BRAIN_ID: '',
    GBRAIN_SOURCE: '',
    GBRAIN_DATABASE_URL: '',
    DATABASE_URL: '',
  };
}

async function runCli(
  args: string[],
  timeoutMs = 90_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: REPO,
    env: cliEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

/** Put the key back to a known value so each test starts from the same state. */
async function setBaseline(): Promise<void> {
  const r = await runCli(['config', 'set', KEY, BASELINE]);
  expect(r.exitCode).toBe(0);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-config-set-flag-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  dbPath = join(home, '.gbrain', 'brain.pglite');
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: dbPath, embedding_dimensions: 1536 }) + '\n',
  );
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dbPath });
  await engine.initSchema();
  await engine.disconnect();
}, 240_000);

afterAll(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('config set rejects unknown flags instead of writing anyway', () => {
  test('control: no flags still writes and reports the value', async () => {
    const set = await runCli(['config', 'set', KEY, BASELINE]);
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain(`Set ${KEY} = ${BASELINE}`);

    const get = await runCli(['config', 'get', KEY]);
    expect(get.exitCode).toBe(0);
    expect(get.stdout.trim()).toBe(BASELINE);
  }, 180_000);

  test('the reported case: --dry-run is refused and nothing is persisted', async () => {
    await setBaseline();

    const set = await runCli(['config', 'set', KEY, 'claude-cli:probe-invalid', '--dry-run']);
    expect(set.exitCode).not.toBe(0);
    expect(set.stderr).toContain('unknown flag: --dry-run');
    // The pre-fix output — the confirmation line that made the write invisible.
    expect(set.stdout).not.toContain('Set ');

    // The load-bearing assertion: the config plane is untouched. An
    // implementation that errors after setConfig fails here.
    const get = await runCli(['config', 'get', KEY]);
    expect(get.exitCode).toBe(0);
    expect(get.stdout.trim()).toBe(BASELINE);
  }, 180_000);

  test('any unimplemented flag is refused, not just --dry-run', async () => {
    await setBaseline();

    const set = await runCli(['config', 'set', KEY, 'anthropic:claude-opus-4-1', '--bogus']);
    expect(set.exitCode).not.toBe(0);
    expect(set.stderr).toContain('unknown flag: --bogus');

    const get = await runCli(['config', 'get', KEY]);
    expect(get.exitCode).toBe(0);
    expect(get.stdout.trim()).toBe(BASELINE);
  }, 180_000);

  // Ordering follow-up: the flag can land BEFORE the value too
  // (`config set <key> --dry-run <value>`), not just after it. The original
  // #3661 gate only scanned the tail past `<key> <value>`, so a flag sitting
  // in the value slot was silently treated as a literal value and written.
  test('an unknown flag placed before the value is also refused (ordering)', async () => {
    await setBaseline();

    const set = await runCli(['config', 'set', KEY, '--dry-run', 'claude-cli:probe-invalid']);
    expect(set.exitCode).not.toBe(0);
    expect(set.stderr).toContain('unknown flag: --dry-run');
    expect(set.stdout).not.toContain('Set ');

    // The load-bearing assertion: nothing was written, including the flag
    // token itself, which pre-fix would have landed in the config plane as
    // the literal value (`value = args[2]` picked up `--dry-run` directly).
    const get = await runCli(['config', 'get', KEY]);
    expect(get.exitCode).toBe(0);
    expect(get.stdout.trim()).toBe(BASELINE);
  }, 180_000);

  // Every flag `config set` implements, so a future edit that narrows the
  // allowlist breaks here instead of silently rejecting a working command.
  const IMPLEMENTED_FLAGS: Array<[string, string]> = [
    ['--force', 'anthropic:claude-sonnet-4-6'],
    ['--coverage-override', 'anthropic:claude-sonnet-4-5'],
    ['--yes', 'anthropic:claude-opus-4-5'],
  ];

  for (const [flag, written] of IMPLEMENTED_FLAGS) {
    test(`${flag}, an implemented flag, still writes`, async () => {
      await setBaseline();

      const set = await runCli(['config', 'set', KEY, written, flag]);
      expect(set.exitCode).toBe(0);
      expect(set.stdout).toContain(`Set ${KEY} = ${written}`);

      const get = await runCli(['config', 'get', KEY]);
      expect(get.exitCode).toBe(0);
      expect(get.stdout.trim()).toBe(written);
    }, 180_000);
  }
});

// -----------------------------------------------------------------------
// Consolidated from config-model-role-keys.serial.test.ts: `gbrain config
// set/get/unset` behavior for the deprecated flat model-role keys
// (`expansion_model` / `chat_model`) and their canonical DB-plane
// replacements (`models.expansion` / `models.chat`). These call
// `runConfig()` in-process against stub engines (no CLI subprocess, no
// PGLite brain) — a different, faster harness than the spawn-based tests
// above, so it keeps its own local helpers rather than reusing runCli/
// cliEnv, which only make sense for the real-subprocess suite.
//
//   - `set expansion_model|chat_model` refuses (no --force escape) and never
//     writes an inert bare DB row.
//   - `set models.expansion|models.chat` writes the canonical key and
//     verifies it through the SAME resolver (`resolveModelDetailed`)
//     `reconfigureGatewayWithEngine` uses before printing success.
//   - `get`/`unset` on the deprecated keys stay coherent: `get` still
//     resolves (unchanged value semantics) but points at the canonical key;
//     `unset` cleans up stale rows in either plane and never touches the
//     canonical key.
// -----------------------------------------------------------------------

function writeFileConfig(home: string, cfg: Record<string, unknown>): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', ...cfg }));
}

function readFileConfig(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf-8')) as Record<string, unknown>;
}

/** A real-enough config-table stub: getConfig/setConfig/unsetConfig backed by
 *  a Map, so `resolveModelDetailed`'s config_key read-back sees writes this
 *  same stub just made — the thing a bare no-op stub can't exercise. */
function mapEngine(initial: Record<string, string> = {}): {
  engine: BrainEngine;
  setCalls: Array<[string, string]>;
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(initial));
  const setCalls: Array<[string, string]> = [];
  const engine = {
    getConfig: async (key: string) => map.get(key) ?? null,
    setConfig: async (key: string, value: string) => { setCalls.push([key, value]); map.set(key, value); },
    unsetConfig: async (key: string) => (map.delete(key) ? 1 : 0),
  } as unknown as BrainEngine;
  return { engine, setCalls, map };
}

/** A stub whose writes never land in the map `getConfig` reads — simulates a
 *  write that "succeeds" (no throw) but doesn't actually take effect. */
function ghostWriteEngine(): { engine: BrainEngine; setCalls: Array<[string, string]> } {
  const map = new Map<string, string>();
  const setCalls: Array<[string, string]> = [];
  const engine = {
    getConfig: async (key: string) => map.get(key) ?? null,
    setConfig: async (key: string, value: string) => { setCalls.push([key, value]); /* never written to map */ },
    unsetConfig: async () => 0,
  } as unknown as BrainEngine;
  return { engine, setCalls };
}

async function runConfigCapture(
  engine: BrainEngine,
  args: string[],
  home?: string,
): Promise<{ logs: string[]; errs: string[]; exit: number | null }> {
  const logs: string[] = [];
  const errs: string[] = [];
  let exit: number | null = null;
  const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exit = code ?? 0;
    throw new Error(`EXIT:${code}`);
  }) as never);
  try {
    await withEnv(
      { GBRAIN_HOME: home, GBRAIN_CHAT_MODEL: undefined, GBRAIN_EXPANSION_MODEL: undefined, ANTHROPIC_API_KEY: undefined },
      () => runConfig(engine, args),
    );
  } catch (e) {
    if (!(e as Error).message.startsWith('EXIT:')) throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { logs, errs, exit };
}

describe('deprecated setter refusal: `config set expansion_model|chat_model`', () => {
  test('refuses expansion_model, names models.expansion, writes nothing', async () => {
    const { engine, setCalls } = mapEngine();
    const { errs, exit } = await runConfigCapture(engine, ['set', 'expansion_model', 'openai:gpt-4o-mini']);
    expect(exit).toBe(1);
    expect(errs.join('\n')).toContain('deprecated');
    expect(errs.join('\n')).toContain('models.expansion');
    expect(setCalls).toEqual([]);
  });

  test('refuses chat_model, names models.chat, writes nothing', async () => {
    const { engine, setCalls } = mapEngine();
    const { errs, exit } = await runConfigCapture(engine, ['set', 'chat_model', 'openai:gpt-5']);
    expect(exit).toBe(1);
    expect(errs.join('\n')).toContain('deprecated');
    expect(errs.join('\n')).toContain('models.chat');
    expect(setCalls).toEqual([]);
  });

  test('refuses even with --force (no escape hatch, unlike the generic unknown-key gate)', async () => {
    const { engine, setCalls } = mapEngine();
    const { exit } = await runConfigCapture(engine, ['set', 'chat_model', 'openai:gpt-5', '--force']);
    expect(exit).toBe(1);
    expect(setCalls).toEqual([]);
  });
});

describe('verified canonical set: `config set models.expansion|models.chat`', () => {
  test('writes the canonical key and verifies through resolveModelDetailed before printing success', async () => {
    const { engine, setCalls } = mapEngine();
    const { logs, errs, exit } = await runConfigCapture(engine, ['set', 'models.chat', 'anthropic:claude-opus-4-7']);
    expect(exit).toBeNull();
    expect(setCalls).toEqual([['models.chat', 'anthropic:claude-opus-4-7']]);
    expect(logs.join('\n')).toContain('Set models.chat');
    expect(logs.join('\n')).toContain('verified');
    expect(errs.join('\n')).not.toContain('ERROR');
  });

  test('accounts for alias normalization: "opus" verifies against its resolved id, not a literal mismatch', async () => {
    const { engine, setCalls } = mapEngine();
    const { logs, exit } = await runConfigCapture(engine, ['set', 'models.chat', 'opus']);
    expect(exit).toBeNull();
    expect(setCalls).toEqual([['models.chat', 'opus']]);
    expect(logs.join('\n')).toContain('anthropic:claude-opus-4-7');
  });

  test('models.expansion writes + verifies independently of models.chat', async () => {
    const { engine, setCalls } = mapEngine();
    const { logs, exit } = await runConfigCapture(engine, ['set', 'models.expansion', 'openai:gpt-4o-mini']);
    expect(exit).toBeNull();
    expect(setCalls).toEqual([['models.expansion', 'openai:gpt-4o-mini']]);
    expect(logs.join('\n')).toContain('Set models.expansion');
  });

  test('read-back mismatch (write does not stick): non-zero exit, no false "Set" line', async () => {
    const { engine, setCalls } = ghostWriteEngine();
    const { logs, errs, exit } = await runConfigCapture(engine, ['set', 'models.chat', 'anthropic:claude-opus-4-7']);
    expect(exit).toBe(1);
    expect(setCalls).toEqual([['models.chat', 'anthropic:claude-opus-4-7']]);
    expect(logs.join('\n')).not.toContain('Set models.chat');
    expect(errs.join('\n')).toContain('did not verify');
  });

  test('DB write failure: non-zero exit, no false "Set" line', async () => {
    const engine = {
      getConfig: async () => null,
      setConfig: async () => { throw new Error('connection terminated unexpectedly'); },
    } as unknown as BrainEngine;
    const { logs, errs, exit } = await runConfigCapture(engine, ['set', 'models.expansion', 'openai:gpt-4o-mini']);
    expect(exit).toBe(1);
    expect(logs.join('\n')).not.toContain('Set models.expansion');
    expect(errs.join('\n')).toContain('connection terminated unexpectedly');
  });
});

describe('coherent `get` behavior for deprecated keys', () => {
  test('config get chat_model still resolves (unchanged value semantics) but notes the canonical key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-config-role-get-'));
    writeFileConfig(home, { chat_model: 'anthropic:claude-sonnet-4-6' });
    const { engine } = mapEngine();
    const { logs, errs, exit } = await runConfigCapture(engine, ['get', 'chat_model'], home);
    expect(exit).toBeNull();
    expect(logs).toContain('anthropic:claude-sonnet-4-6');
    expect(errs.join('\n')).toContain('deprecated');
    expect(errs.join('\n')).toContain('models.chat');
  });

  test('canonical-present: after migration removes the flat pin, get chat_model still resolves via models.chat (not "not found")', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-config-role-get-migrated-'));
    // No flat pin left in the file plane (as migrateFlatModelRoleKey leaves
    // it once migration succeeds) — only the canonical DB row answers.
    writeFileConfig(home, {});
    const { engine } = mapEngine({ 'models.chat': 'anthropic:claude-opus-4-7' });
    const { logs, errs, exit } = await runConfigCapture(engine, ['get', 'chat_model'], home);
    expect(exit).toBeNull();
    expect(logs).toContain('anthropic:claude-opus-4-7');
    expect(errs.join('\n')).toContain('deprecated');
    expect(errs.join('\n')).toContain('models.chat');
  });

  test('legacy-only: no canonical row yet, an as-yet-unmigrated flat file pin still answers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-config-role-get-legacy-'));
    writeFileConfig(home, { expansion_model: 'openai:gpt-4o-mini' });
    const { engine } = mapEngine(); // models.expansion NOT set — migration hasn't run
    const { logs, errs, exit } = await runConfigCapture(engine, ['get', 'expansion_model'], home);
    expect(exit).toBeNull();
    expect(logs).toContain('openai:gpt-4o-mini');
    expect(errs.join('\n')).toContain('deprecated');
    expect(errs.join('\n')).toContain('models.expansion');
  });

  test('config get models.chat does NOT print a deprecation note', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-config-role-get-canon-'));
    writeFileConfig(home, {});
    const { engine } = mapEngine({ 'models.chat': 'anthropic:claude-opus-4-7' });
    const { logs, errs, exit } = await runConfigCapture(engine, ['get', 'models.chat'], home);
    expect(exit).toBeNull();
    expect(logs).toContain('anthropic:claude-opus-4-7');
    expect(errs.join('\n')).not.toContain('deprecated');
  });
});

describe('coherent `unset` behavior for deprecated keys', () => {
  test('cleans a stale bare DB row and directs to the canonical key, without touching it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-config-role-unset-'));
    writeFileConfig(home, {});
    const { engine, map } = mapEngine({ chat_model: 'openai:gpt-5', 'models.chat': 'anthropic:claude-opus-4-7' });
    const { logs, errs, exit } = await runConfigCapture(engine, ['unset', 'chat_model'], home);
    expect(exit).toBeNull();
    expect(logs.join('\n')).toContain('Unset chat_model');
    expect(errs.join('\n')).toContain('models.chat');
    expect(map.has('chat_model')).toBe(false);
    expect(map.get('models.chat')).toBe('anthropic:claude-opus-4-7'); // canonical untouched
  });

  test('also cleans a stale file-plane flat pin', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-config-role-unset-file-'));
    writeFileConfig(home, { expansion_model: 'openai:gpt-4o-mini' });
    const { engine } = mapEngine();
    const { logs, exit } = await runConfigCapture(engine, ['unset', 'expansion_model'], home);
    expect(exit).toBeNull();
    expect(logs.join('\n')).toContain('file plane');
    expect(readFileConfig(home).expansion_model).toBeUndefined();
  });

  test('neither plane has it: not-found exit 1, still shows canonical-key guidance', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-config-role-unset-missing-'));
    writeFileConfig(home, {});
    const { engine } = mapEngine();
    const { errs, exit } = await runConfigCapture(engine, ['unset', 'chat_model'], home);
    expect(exit).toBe(1);
    expect(errs.join('\n')).toContain('Config key not found: chat_model');
    expect(errs.join('\n')).toContain('models.chat');
  });
});
