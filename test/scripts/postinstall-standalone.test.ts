import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');

describe('scripts/postinstall.ts exits 0 on every path', () => {
  test('runs the installed package CLI even when another gbrain wins PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-postinstall-local-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      mkdirSync(join(dir, 'bin'));
      copyFileSync(join(REPO, 'scripts/postinstall.ts'), join(dir, 'scripts/postinstall.ts'));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ bin: { gbrain: 'local-cli.ts' } }));
      writeFileSync(join(dir, 'local-cli.ts'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(dir, 'args.json'))}, JSON.stringify(process.argv.slice(2)));`);
      writeFileSync(join(dir, 'bin/gbrain'), '#!/bin/sh\ntouch '+join(dir, 'wrong-cli')+'\n', { mode: 0o755 });
      const result = spawnSync(process.execPath, ['--no-env-file', join(dir, 'scripts/postinstall.ts')], {
        cwd: dir, env: { HOME: dir, GBRAIN_HOME: dir, PATH: join(dir, 'bin')+':/usr/bin:/bin' }, encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, result.stderr+result.stdout).toBe(0);
      expect(existsSync(join(dir, 'wrong-cli'))).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'))).toEqual(['apply-migrations', '--yes', '--non-interactive']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('runs from a directory holding only package.json and the script (Docker dependency layer)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-postinstall-standalone-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      copyFileSync(join(REPO, 'package.json'), join(dir, 'package.json'));
      copyFileSync(join(REPO, 'scripts', 'postinstall.ts'), join(dir, 'scripts', 'postinstall.ts'));
      const result = spawnSync(process.execPath, ['--no-env-file', join(dir, 'scripts', 'postinstall.ts')], {
        cwd: dir,
        env: { HOME: dir, GBRAIN_HOME: dir, PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stderr).toContain('postinstall skipped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
