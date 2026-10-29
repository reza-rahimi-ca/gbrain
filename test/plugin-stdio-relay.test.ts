/**
 * Plugin launcher thin-client mode: `.agents/gbrain-launcher serve` with
 * GBRAIN_PLUGIN_REMOTE_URL relays stdio MCP to a shared Streamable HTTP
 * server instead of starting a local (full-consumer) `gbrain serve`.
 *
 * The shared server here is a real SDK McpServer over HTTP with a bearer
 * check, and the harness side is a real SDK Client over stdio spawning the
 * launcher, so the test proves a tool call round-trips end to end. HOME is a
 * tempdir in every case (no real env file, no real gbrain), and GBRAIN_BIN is
 * a stub that prints LOCAL so any fallback to a local server is observable.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readToken, remoteUrl } from '../src/mcp/stdio-relay.ts';

const ROOT = join(import.meta.dir, '..');
const LAUNCHER = join(ROOT, '.agents/gbrain-launcher');
const TOKEN = 'relay-test-token';

let home: string;
let tokenFile: string;
let stub: string;
let server: Server;
let mcpUrl: string;
const seenAuth: string[] = [];

/** One stateful SDK server transport per MCP session, as `gbrain serve --http` does. */
async function startSharedServer(): Promise<void> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    seenAuth.push(req.headers.authorization ?? '');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    const sid = req.headers['mcp-session-id'];
    let transport = typeof sid === 'string' ? sessions.get(sid) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => { sessions.set(id, transport!); },
      });
      const mcp = new McpServer({ name: 'shared-stub', version: '0.0.0' });
      mcp.registerTool('echo', { description: 'echo', inputSchema: { msg: z.string() } },
        async ({ msg }) => ({ content: [{ type: 'text', text: `shared:${msg}` }] }));
      await mcp.connect(transport);
    }
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  mcpUrl = `http://127.0.0.1:${addr.port}/mcp`;
}

function baseEnv(extra: Record<string, string>): Record<string, string> {
  return { HOME: home, PATH: '/usr/bin:/bin', GBRAIN_BIN: stub, GBRAIN_PLUGIN_REMOTE_TOKEN_FILE: tokenFile, ...extra };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-relay-home-'));
  // The launcher finds bun at ~/.bun/bin/bun; point it at the bun running this test.
  mkdirSync(join(home, '.bun', 'bin'), { recursive: true });
  symlinkSync(process.execPath, join(home, '.bun', 'bin', 'bun'));
  stub = join(home, 'gbrain-stub');
  writeFileSync(stub, '#!/bin/sh\necho LOCAL "$@"\n');
  chmodSync(stub, 0o755);
  tokenFile = join(home, 'token');
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  await startSharedServer();
});

afterAll(() => {
  server?.close();
  rmSync(home, { recursive: true, force: true });
});

describe('relay config guards', () => {
  test('refuses cleartext http to a non-loopback host', () => {
    expect(() => remoteUrl({ GBRAIN_PLUGIN_REMOTE_URL: 'http://brain.example:3131/mcp' })).toThrow(/loopback only/);
    expect(remoteUrl({ GBRAIN_PLUGIN_REMOTE_URL: 'http://127.0.0.1:3131/mcp' }).port).toBe('3131');
    expect(remoteUrl({ GBRAIN_PLUGIN_REMOTE_URL: 'https://brain.example/mcp' }).hostname).toBe('brain.example');
  });

  test('refuses a group/other-readable token file', () => {
    const loose = join(home, 'loose-token');
    writeFileSync(loose, 'x', { mode: 0o644 });
    chmodSync(loose, 0o644);
    expect(() => readToken({ GBRAIN_PLUGIN_REMOTE_TOKEN_FILE: loose })).toThrow(/chmod 600/);
    expect(readToken({ GBRAIN_PLUGIN_REMOTE_TOKEN_FILE: tokenFile })).toBe(TOKEN);
  });
});

describe('launcher relay mode (real stdio client -> launcher -> real HTTP server)', () => {
  test('tool call round-trips through the shared server with the bearer token', async () => {
    seenAuth.length = 0;
    const transport = new StdioClientTransport({
      command: LAUNCHER, args: ['serve'], env: baseEnv({ GBRAIN_PLUGIN_REMOTE_URL: mcpUrl }), stderr: 'pipe',
    });
    const client = new Client({ name: 'harness', version: '0.0.0' });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual(['echo']);
      const res = await client.callTool({ name: 'echo', arguments: { msg: 'hi' } });
      expect(res.content).toEqual([{ type: 'text', text: 'shared:hi' }]);
      expect(seenAuth.length).toBeGreaterThan(0);
      expect(seenAuth.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);

  test('a wrong token fails the MCP handshake instead of silently falling back', async () => {
    const bad = join(home, 'bad-token');
    writeFileSync(bad, 'wrong', { mode: 0o600 });
    const transport = new StdioClientTransport({
      command: LAUNCHER, args: ['serve'],
      env: baseEnv({ GBRAIN_PLUGIN_REMOTE_URL: mcpUrl, GBRAIN_PLUGIN_REMOTE_TOKEN_FILE: bad }), stderr: 'pipe',
    });
    const client = new Client({ name: 'harness', version: '0.0.0' });
    await expect(client.connect(transport, { timeout: 15_000 })).rejects.toThrow();
    await client.close().catch(() => {});
  }, 30_000);
});

describe('launcher relay mode: shared server down', () => {
  const deadUrl = 'http://127.0.0.1:1/mcp';

  test('falls back to the local gbrain serve by default', () => {
    const r = spawnSync(LAUNCHER, ['serve'], { encoding: 'utf8', env: baseEnv({ GBRAIN_PLUGIN_REMOTE_URL: deadUrl }), timeout: 20_000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('LOCAL serve');
    expect(r.stderr).toContain('falling back to a local gbrain serve');
  });

  test('GBRAIN_PLUGIN_REMOTE_FALLBACK=fail exits 75 without starting a local server', () => {
    const r = spawnSync(LAUNCHER, ['serve'], {
      encoding: 'utf8', env: baseEnv({ GBRAIN_PLUGIN_REMOTE_URL: deadUrl, GBRAIN_PLUGIN_REMOTE_FALLBACK: 'fail' }), timeout: 20_000,
    });
    expect(r.status).toBe(75);
    expect(r.stdout).not.toContain('LOCAL');
  });

  test('without GBRAIN_PLUGIN_REMOTE_URL the launcher is unchanged (local serve, no relay)', () => {
    const r = spawnSync(LAUNCHER, ['serve'], { encoding: 'utf8', env: baseEnv({}), timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('LOCAL serve');
    expect(r.stderr).not.toContain('gbrain-launcher: relay');
    expect(r.stderr).not.toContain('shared server');
  });
});
