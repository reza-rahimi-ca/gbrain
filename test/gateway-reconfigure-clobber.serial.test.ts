/**
 * reconfigureGatewayWithEngine — the clobber regression suite.
 *
 * The historical bug: reconfigure resolved `models.chat` with tier
 * 'reasoning', and the key-blind tier default beat the caller fallback — an
 * explicit `chat_model: "openai:gpt-5.2"` in ~/.gbrain/config.json was
 * silently replaced with the Anthropic default on every engine connect.
 *
 * Post-fix contract: DB-plane overrides win as before; when resolution falls
 * to the tier default, the SHARED effective-model resolver consults the RAW
 * file config — a SERVABLE pin survives, an unservable pin (provider switch)
 * falls to the key-aware default with one warn.
 *
 * Hermetic: GBRAIN_HOME points at a temp dir (the file-plane read), provider
 * key envs are pinned, gateway env is injected via configureGateway.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureGateway,
  reconfigureGatewayWithEngine,
  getChatModel,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import {
  TIER_DEFAULTS,
  _resetDeprecationWarningsForTest,
  openaiStaticTierFallback,
  migrateFlatModelRoleKey,
} from '../src/core/model-config.ts';
import { permsEnforced } from './helpers/fs-perms.ts';

class StubEngine {
  readonly kind = 'pglite' as const;
  private cfg = new Map<string, string>();
  set(key: string, value: string) { this.cfg.set(key, value); }
  async getConfig(key: string) { return this.cfg.get(key) ?? null; }
  async setConfig() {}
}

/** Unlike StubEngine above, this one's setConfig actually persists — needed
 *  to exercise the flat-pin -> canonical-key migration
 *  (migrateFlatModelRoleKey), which reads back what it just wrote. The
 *  optional `initial` map and fail-injection toggles let it stand in for the
 *  migration-specific stub engine that used to live in
 *  model-role-key-migration.serial.test.ts (now consolidated here). */
class WritableStubEngine {
  readonly kind = 'pglite' as const;
  private cfg: Map<string, string>;
  private failSet = false;
  private failGet = false;
  constructor(initial: Record<string, string> = {}) {
    this.cfg = new Map(Object.entries(initial));
  }
  set(key: string, value: string) { this.cfg.set(key, value); }
  failWritesFrom(now: boolean): void { this.failSet = now; }
  failReadsFrom(now: boolean): void { this.failGet = now; }
  async getConfig(key: string) {
    if (this.failGet) throw new Error('read failed (test)');
    return this.cfg.get(key) ?? null;
  }
  async setConfig(key: string, value: string) {
    if (this.failSet) throw new Error('write failed (test)');
    this.cfg.set(key, value);
  }
}

const PINNED = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GBRAIN_MODEL', 'GBRAIN_CHAT_MODEL', 'GBRAIN_HOME'] as const;
let saved: Record<string, string | undefined>;
let tmpHome: string;
let stub: StubEngine;
let stderrCapture: string;
const origWrite = process.stderr.write.bind(process.stderr);

function writeFileConfig(cfg: Record<string, unknown>): void {
  // GBRAIN_HOME is a PARENT dir — configDir() appends '.gbrain' itself.
  mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
  writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', ...cfg }));
}

function readFileConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tmpHome, '.gbrain', 'config.json'), 'utf-8'));
}

beforeEach(() => {
  saved = {};
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-reconf-'));
  process.env.GBRAIN_HOME = tmpHome;
  stub = new StubEngine();
  resetGateway();
  _resetDeprecationWarningsForTest();
  stderrCapture = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrCapture += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = origWrite;
  rmSync(tmpHome, { recursive: true, force: true });
  for (const k of PINNED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// Shard hygiene (same pattern as facts-extract-silent-no-op.test.ts): restore
// the legacy embedding pin so later fresh-schema files in this shard's
// process don't size vector columns from this file's leftover gateway state.
afterAll(() => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

describe('reconfigureGatewayWithEngine — no-clobber', () => {
  test('servable file pin survives reconnect (THE regression)', async () => {
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    configureGateway({ chat_model: 'openai:gpt-5.2', env: { OPENAI_API_KEY: 'sk-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    expect(getChatModel()).toBe('openai:gpt-5.2');
  });

  test('DB-plane models.chat still wins over everything', async () => {
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    configureGateway({ chat_model: 'openai:gpt-5.2', env: { OPENAI_API_KEY: 'sk-test' } });
    stub.set('models.chat', 'anthropic:claude-opus-4-7');
    await reconfigureGatewayWithEngine(stub as never);
    expect(getChatModel()).toBe('anthropic:claude-opus-4-7');
  });

  test('provider switch: unservable openai pin + anthropic-only key → key-aware default + one warn', async () => {
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    configureGateway({ chat_model: 'openai:gpt-5.2', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    expect(getChatModel()).toBe(TIER_DEFAULTS.reasoning);
    expect(stderrCapture).toContain('openai:gpt-5.2');
    expect(stderrCapture).toContain('no usable');
  });

  test('keyless + no pin → tier default (today\'s shape, honest downstream)', async () => {
    writeFileConfig({});
    configureGateway({ env: {} });
    await reconfigureGatewayWithEngine(stub as never);
    expect(getChatModel()).toBe(TIER_DEFAULTS.reasoning);
  });

  test('openai-only, no pin → key-aware tier default routes chat to openai', async () => {
    writeFileConfig({ openai_api_key: 'sk-file-plane' });
    configureGateway({ env: { OPENAI_API_KEY: 'sk-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    expect(getChatModel()).toBe(openaiStaticTierFallback().reasoning);
  });
});

describe('reconfigureGatewayWithEngine — flat model-role pin migration wiring', () => {
  test('THE user scenario: flat chat_model pin + a DIFFERENT models.chat already set — canonical wins and the flat pin is migrated away', async () => {
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    configureGateway({ chat_model: 'openai:gpt-5.2', env: { OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant-test' } });
    const writable = new WritableStubEngine();
    writable.set('models.chat', 'anthropic:claude-opus-4-7');

    await reconfigureGatewayWithEngine(writable as never);
    expect(getChatModel()).toBe('anthropic:claude-opus-4-7');

    expect(readFileConfig().chat_model).toBeUndefined();
  });

  test('absent canonical: the flat pin migrates onto models.chat and survives a second reconnect', async () => {
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    configureGateway({ chat_model: 'openai:gpt-5.2', env: { OPENAI_API_KEY: 'sk-test' } });
    const writable = new WritableStubEngine();

    await reconfigureGatewayWithEngine(writable as never);
    expect(getChatModel()).toBe('openai:gpt-5.2');

    expect(readFileConfig().chat_model).toBeUndefined();

    // Second reconnect: nothing left to migrate, canonical key keeps answering.
    await reconfigureGatewayWithEngine(writable as never);
    expect(getChatModel()).toBe('openai:gpt-5.2');
  });
});

describe('expansion-side effective resolution (review-army addition)', () => {
  test('servable expansion_model file pin survives reconnect', async () => {
    writeFileConfig({ expansion_model: 'openai:gpt-4o-mini' });
    configureGateway({ expansion_model: 'openai:gpt-4o-mini', env: { OPENAI_API_KEY: 'sk-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    const { getExpansionModel } = await import('../src/core/ai/gateway.ts');
    expect(getExpansionModel()).toBe('openai:gpt-4o-mini');
  });

  test('unservable expansion pin falls to the key-aware utility default + warn', async () => {
    writeFileConfig({ expansion_model: 'openai:gpt-4o-mini' });
    configureGateway({ expansion_model: 'openai:gpt-4o-mini', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    const { getExpansionModel } = await import('../src/core/ai/gateway.ts');
    expect(getExpansionModel()).toBe(TIER_DEFAULTS.utility);
    expect(stderrCapture).toContain('expansion_model');
  });
});

// Consolidated from model-role-key-migration.serial.test.ts: direct
// migrateFlatModelRoleKey coverage (the function reconfigureGatewayWithEngine
// above calls internally). GBRAIN_HOME is already pinned to tmpHome by the
// outer beforeEach, so these call the migration function directly without a
// separate withEnv wrapper.
describe('migrateFlatModelRoleKey (direct)', () => {
  test('THE regression: canonical already set to a different value — canonical wins, flat pin removed', async () => {
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    const engine = new WritableStubEngine({ 'models.chat': 'anthropic:claude-opus-4-7' });
    await migrateFlatModelRoleKey(engine as never, 'chat_model');

    expect(await engine.getConfig('models.chat')).toBe('anthropic:claude-opus-4-7');
    expect(readFileConfig().chat_model).toBeUndefined();
  });

  test('absent-canonical migration: flat pin copied verbatim, read back to confirm, then removed from file', async () => {
    writeFileConfig({ expansion_model: 'openai:gpt-4o-mini' });
    const engine = new WritableStubEngine();
    await migrateFlatModelRoleKey(engine as never, 'expansion_model');

    expect(await engine.getConfig('models.expansion')).toBe('openai:gpt-4o-mini');
    expect(readFileConfig().expansion_model).toBeUndefined();
  });

  test('idempotent: re-running after a successful migration is a no-op (nothing left to migrate)', async () => {
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    const engine = new WritableStubEngine();
    await migrateFlatModelRoleKey(engine as never, 'chat_model');
    await migrateFlatModelRoleKey(engine as never, 'chat_model'); // second pass: flat pin already gone
    expect(await engine.getConfig('models.chat')).toBe('openai:gpt-5.2');
  });

  test('preserves a provider with no key-aware tier default by copying the pin verbatim', async () => {
    writeFileConfig({ expansion_model: 'groq:llama-3.1-8b-instant' });
    const engine = new WritableStubEngine();
    await migrateFlatModelRoleKey(engine as never, 'expansion_model');
    expect(await engine.getConfig('models.expansion')).toBe('groq:llama-3.1-8b-instant');
  });

  test('failed migration (write does not stick): flat pin retained, canonical left unset, warns', async () => {
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    const engine = new WritableStubEngine();
    engine.failWritesFrom(true);
    await migrateFlatModelRoleKey(engine as never, 'chat_model');

    expect(readFileConfig().chat_model).toBe('openai:gpt-5.2'); // NOT lost
    expect(await engine.getConfig('models.chat')).toBeNull(); // NOT half-written
    expect(stderrCapture).toContain('chat_model');
    expect(stderrCapture).toContain('models.chat');
  });

  test('failed migration (canonical unreadable): flat pin retained, warns loudly instead of throwing', async () => {
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    const engine = new WritableStubEngine();
    engine.failReadsFrom(true);
    // Never throws — a migration bug must not break reconfigure.
    await migrateFlatModelRoleKey(engine as never, 'chat_model');

    expect(readFileConfig().chat_model).toBe('openai:gpt-5.2');
    expect(stderrCapture).toContain('could not read');
  });

  // skipIf: asserts a write MUST fail on a 0o500 dir — unrunnable on hosts
  // that don't enforce permission bits (FUSE/overlay sandboxes, root).
  test.skipIf(!permsEnforced())('cleanup save failure: flat pin is retained (not lost) and a warning is emitted, never thrown', async () => {
    // Canonical already answers — migrateFlatModelRoleKey takes the
    // "dead weight" cleanup branch, which is exactly the removeFlatFileKey
    // call this test forces to fail (saveConfig's tmp-file write into the
    // read-only .gbrain dir throws EACCES).
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    const engine = new WritableStubEngine({ 'models.chat': 'anthropic:claude-opus-4-7' });
    const gbrainDir = join(tmpHome, '.gbrain');
    chmodSync(gbrainDir, 0o500);
    try {
      await expect(
        migrateFlatModelRoleKey(engine as never, 'chat_model'),
      ).resolves.toBeUndefined(); // never throws — a migration/cleanup bug must not break reconfigure
    } finally {
      chmodSync(gbrainDir, 0o700);
    }

    // The flat pin is NOT lost: saveConfig's atomic tmp+rename write failed
    // before touching the live file, so the original value is exactly as it
    // was.
    expect(readFileConfig().chat_model).toBe('openai:gpt-5.2');
    // The canonical key is unaffected by the failed cleanup.
    expect(await engine.getConfig('models.chat')).toBe('anthropic:claude-opus-4-7');
    // A loud, deduplicated warning fires instead of the failure being
    // silently discarded.
    expect(stderrCapture).toContain('chat_model');
    expect(stderrCapture).toContain('models.chat');
  });

  test('no flat pin on disk: no-op, no warning, nothing written', async () => {
    writeFileConfig({});
    const engine = new WritableStubEngine();
    await migrateFlatModelRoleKey(engine as never, 'chat_model');
    expect(await engine.getConfig('models.chat')).toBeNull();
    expect(stderrCapture).toBe('');
  });

  test('a whitespace-only flat pin is treated as absent (nothing to migrate)', async () => {
    writeFileConfig({ expansion_model: '   ' });
    const engine = new WritableStubEngine();
    await migrateFlatModelRoleKey(engine as never, 'expansion_model');
    expect(await engine.getConfig('models.expansion')).toBeNull();
  });
});
