/**
 * stdio <-> Streamable HTTP MCP relay for the plugin launcher (thin-client mode).
 *
 * A stdio `gbrain serve` always starts a full persistence consumer
 * (consumer-election.ts), so every harness session that spawns the plugin's
 * server adds one more consumer on the host (doctor: two_consumers_on_host).
 * When GBRAIN_PLUGIN_REMOTE_URL is set, `.agents/gbrain-launcher serve` runs
 * this relay instead: the harness still talks stdio to "the plugin's gbrain
 * server", while every message is forwarded verbatim to one shared
 * `gbrain serve --http`, which is the host's only consumer.
 *
 * Pure JSON-RPC passthrough: no tool catalog, surface or source logic lives
 * here, so the remote server's grant (scopes, sources, surface ceiling) is
 * the whole authority. The relay only tracks the initialize exchange to set
 * the negotiated protocol version on the HTTP transport (the SDK Client does
 * that itself; a raw transport needs it done by hand).
 *
 * Usage (from the launcher; not a user-facing CLI):
 *   bun src/mcp/stdio-relay.ts --probe   exit 0 if <origin>/health is 2xx, else 75
 *   bun src/mcp/stdio-relay.ts           relay until stdin or the remote closes
 *
 * Env:
 *   GBRAIN_PLUGIN_REMOTE_URL         MCP endpoint, e.g. http://127.0.0.1:3131/mcp
 *   GBRAIN_PLUGIN_REMOTE_TOKEN_FILE  file holding the bearer token (mode 0600;
 *                                    default ~/.gbrain/serve/plugin-client-token)
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** sysexits EX_TEMPFAIL: the launcher reads this as "remote unavailable, fall back". */
export const EXIT_REMOTE_UNAVAILABLE = 75;
const PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_TOKEN_FILE = join(homedir(), '.gbrain', 'serve', 'plugin-client-token');

function log(msg: string): void {
  process.stderr.write(`gbrain-relay: ${msg}\n`);
}

export function remoteUrl(env: NodeJS.ProcessEnv = process.env): URL {
  const raw = env.GBRAIN_PLUGIN_REMOTE_URL;
  if (!raw) throw new Error('GBRAIN_PLUGIN_REMOTE_URL is not set');
  const url = new URL(raw);
  // A bearer token must never cross a non-loopback hop in cleartext.
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`refusing ${url.protocol}//${url.hostname}: use https, or http on loopback only`);
  }
  return url;
}

export function readToken(env: NodeJS.ProcessEnv = process.env): string {
  const file = env.GBRAIN_PLUGIN_REMOTE_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  const mode = statSync(file).mode & 0o077;
  if (mode !== 0) throw new Error(`token file ${file} is readable by group/other; chmod 600 it`);
  const token = readFileSync(file, 'utf8').trim();
  if (!token) throw new Error(`token file ${file} is empty`);
  return token;
}

/** Liveness only: /health is unauthenticated, so a bad token still surfaces later as an MCP error, not a silent fallback. */
export async function probe(url: URL, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(new URL('/health', url), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

function isRequest(m: JSONRPCMessage): m is JSONRPCMessage & { id: string | number; method: string } {
  return 'method' in m && 'id' in m && m.id !== undefined;
}

export async function relay(url: URL, token: string): Promise<void> {
  const local = new StdioServerTransport();
  const remote = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  let initializeId: string | number | null = null;
  let closing = false;

  const shutdown = async (code: number, why: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`closing (${why})`);
    // Best effort: release the server-side session so it does not linger until idle expiry.
    await remote.terminateSession().catch(() => {});
    await remote.close().catch(() => {});
    await local.close().catch(() => {});
    process.exit(code);
  };

  local.onmessage = (msg) => {
    if (isRequest(msg) && msg.method === 'initialize') initializeId = msg.id;
    remote.send(msg).catch((err: unknown) => {
      const text = err instanceof Error ? err.message : String(err);
      log(`remote send failed: ${text}`);
      // Answer the request so the harness gets an error instead of hanging until its own timeout.
      if (isRequest(msg)) {
        void local.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `gbrain shared server unreachable: ${text}` } });
      }
    });
  };
  remote.onmessage = (msg) => {
    if (initializeId !== null && 'id' in msg && msg.id === initializeId && 'result' in msg) {
      const version = (msg.result as { protocolVersion?: unknown }).protocolVersion;
      if (typeof version === 'string') remote.setProtocolVersion(version);
      initializeId = null;
    }
    void local.send(msg);
  };
  remote.onerror = (err) => log(`remote error: ${err.message}`);
  local.onerror = (err) => log(`stdio error: ${err.message}`);
  local.onclose = () => void shutdown(0, 'stdin closed');
  remote.onclose = () => void shutdown(1, 'remote closed');
  process.on('SIGTERM', () => void shutdown(0, 'SIGTERM'));
  process.on('SIGINT', () => void shutdown(0, 'SIGINT'));

  await remote.start();
  await local.start();
  log(`relaying stdio to ${url.href}`);
}

if (import.meta.main) {
  try {
    const url = remoteUrl();
    if (process.argv.includes('--probe')) {
      process.exit((await probe(url)) ? 0 : EXIT_REMOTE_UNAVAILABLE);
    }
    await relay(url, readToken());
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    process.exit(EXIT_REMOTE_UNAVAILABLE);
  }
}
