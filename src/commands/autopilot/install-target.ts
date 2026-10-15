import { existsSync } from 'node:fs';
import { execSync } from '../../core/spawn.ts';
import { detectExecutionEnvironment } from '../../core/execution-env.ts';

export type InstallTarget = 'macos' | 'linux-systemd' | 'ephemeral-container' | 'linux-cron';

/** Injectable probe signals for {@link detectInstallTarget} /
 *  {@link systemdUserSessionAvailable} — same DI shape as execution-env.ts's
 *  `EnvProbeSignals`, so the systemd/cron branches are unit-testable without
 *  touching the real systemd/loginctl/crontab on the test host. */
export interface InstallTargetProbeSignals {
  env?: Record<string, string | undefined>;
  fileExists?: (p: string) => boolean;
  exec?: (cmd: string) => string;
}

/**
 * Is a systemd --user instance reachable for this uid? `XDG_RUNTIME_DIR` is
 * the standard marker systemd itself sets for a live session; `loginctl
 * enable-linger` provisions the same runtime dir for a lingering user even
 * without an active login session, so a login-less cron/CI shell with linger
 * enabled still reports available here.
 *
 * Deliberately does NOT shell out to `systemctl --user is-system-running` —
 * that command returns non-zero (and can time out) for perfectly viable
 * sessions in a "degraded" state (some unrelated user unit failed), which is
 * exactly the false-negative this function exists to avoid propagating into
 * install-target selection.
 */
export function systemdUserSessionAvailable(signals: InstallTargetProbeSignals = {}): boolean {
  const env = signals.env ?? process.env;
  if (env.XDG_RUNTIME_DIR) return true;
  const user = (env.USER || env.LOGNAME || '').trim();
  if (!user) return false;
  const exec = signals.exec ?? ((cmd: string) => execSync(cmd, { stdio: 'pipe', timeout: 3000, encoding: 'utf-8' }) as string);
  try {
    const q = (s: string) => s.replace(/'/g, "'\\''");
    const out = exec(`loginctl show-user '${q(user)}' -p Linger`);
    return /Linger=yes/.test(out);
  } catch {
    return false;
  }
}

/**
 * Detect the right supervisor for this host.
 *
 *   - macos   → launchd (always, when platform === 'darwin').
 *   - ephemeral-container → Render / Railway / Fly / Docker. Crontab is
 *                           unreliable here (wiped on deploy); we hand
 *                           the user a start script instead.
 *   - linux-systemd → a systemd user session is confirmed available (see
 *                     systemdUserSessionAvailable above) — sufficient on its
 *                     own, whether or not a gbrain unit is already
 *                     installed. Does NOT re-probe `systemctl --user
 *                     is-system-running`: a transient "degraded" report
 *                     there must not steer a reachable session onto
 *                     crontab.
 *   - linux-cron  → fallback: no systemd user session available at all.
 */
export function detectInstallTarget(signals: InstallTargetProbeSignals = {}): InstallTarget {
  const env = signals.env ?? process.env;
  const fileExists = signals.fileExists ?? existsSync;
  const exec = signals.exec ?? ((cmd: string) => execSync(cmd, { stdio: 'pipe', timeout: 3000, encoding: 'utf-8' }) as string);

  if (process.platform === 'darwin') return 'macos';

  // Shared detector (execution-env.ts): covers the original Render/Railway/
  // Fly//.dockerenv signals AND the cloud-sandbox signature — both get the
  // start-script treatment here (no reliable scheduler in either).
  if (detectExecutionEnvironment({ env, fileExists }) !== 'local') return 'ephemeral-container';

  if (fileExists('/run/systemd/system') && systemdUserSessionAvailable({ env, exec })) {
    return 'linux-systemd';
  }

  return 'linux-cron';
}

