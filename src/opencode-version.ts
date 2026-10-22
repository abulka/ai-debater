/**
 * adv needs OpenCode 2.
 *
 * Every model call goes through `opencode run` with `--standalone`, and the
 * four agents are injected as v2 config (`agents` / `permissions` / `system`).
 * OpenCode 1 knows neither: it treats `--standalone` as an unknown argument,
 * prints its help, and exits 1. That failure used to reach the reader as the
 * tail of a help screen — the probe cache recorded `failed` with
 * `--auto auto-approve permissions…` as the reason — which reads like a model
 * or credential problem and sends people looking in the wrong place.
 *
 * So the version is checked before the first spawn, and the answer names the
 * remedy. `opencode upgrade` without `--major` stays on 1.x, which is exactly
 * how a machine can be up to date and still too old for adv.
 */

/** The major version adv is built against. */
export const OPENCODE_MIN_MAJOR = 2;

/** The command that actually crosses the major boundary. */
export const OPENCODE_UPGRADE = "opencode upgrade --major";

/** Shared prefix, so the ping's classifier can recognise every version failure. */
export const OPENCODE_REQUIREMENT =
  "adv requires OpenCode 2 (the --standalone flag and the injected agent config are v2 features)";

/** `opencode version 2.0.32` -> `2.0.32`; null when there is no version in it. */
export function opencodeVersionIn(text: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? match[0] : null;
}

/** The major number, or null when the text is not a version at all. */
export function opencodeMajor(text: string): number | null {
  const version = opencodeVersionIn(text);
  if (!version) return null;
  return Number(version.split(".")[0]);
}

/**
 * What is wrong with this `opencode --version` output, or null if nothing is.
 *
 * An unreadable version is a problem too: silently assuming v2 would turn a
 * wrapper or a changed format into the same opaque help-tail failure.
 */
export function versionProblem(raw: string): string | null {
  const version = opencodeVersionIn(raw);
  if (!version) {
    const seen = raw.trim().slice(0, 80);
    return `${OPENCODE_REQUIREMENT}. Could not read a version from \`opencode --version\`${
      seen ? ` (got "${seen}")` : ""
    }. Upgrade with: ${OPENCODE_UPGRADE}`;
  }
  const major = Number(version.split(".")[0]);
  if (major >= OPENCODE_MIN_MAJOR) return null;
  return `${OPENCODE_REQUIREMENT}. This is OpenCode ${version}. Upgrade with: ${OPENCODE_UPGRADE}`;
}

/**
 * `opencode --version`, with a bound.
 *
 * Short timeout: this runs before a model call, and a CLI that cannot say its
 * version in five seconds is a failure worth reporting rather than waiting on.
 */
export async function readOpenCodeVersion(timeoutMs = 5_000): Promise<string> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["opencode", "--version"], { stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new Error(
      `${OPENCODE_REQUIREMENT}. The \`opencode\` command was not found on PATH. ` +
        `Install it from https://opencode.ai, then run: ${OPENCODE_UPGRADE}\n` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill();
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);

  if (killed) throw new Error(`opencode --version timed out after ${timeoutMs}ms`);
  if (code !== 0) {
    const raw = (stderr || stdout).trim().slice(-240);
    throw new Error(`opencode --version exited ${code}${raw ? `\n${raw}` : ""}`);
  }
  return stdout.trim();
}

let checked: Promise<void> | null = null;

/**
 * Fail before the first model call when the installed OpenCode is not v2.
 *
 * Cached for the process: the check is one spawn, and the answer cannot change
 * without a restart of adv (which is what an upgrade requires anyway).
 */
export function assertOpenCode2(): Promise<void> {
  checked ??= (async () => {
    const raw = await readOpenCodeVersion();
    const problem = versionProblem(raw);
    if (problem) throw new Error(problem);
  })();
  return checked;
}

/** Test seam: forget the cached result. */
export function resetOpenCodeCheck(): void {
  checked = null;
}
