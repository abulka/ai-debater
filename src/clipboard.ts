import { writeFile } from "node:fs/promises";

/**
 * Getting text out of the TUI and onto the clipboard.
 *
 * The answer is Markdown, and a terminal pane is a bad place to copy from: the
 * text you drag over is wrapped, styled and mixed with the tool's own
 * commentary. So the answer is written to `answer.md` in the run directory
 * first — that copy always works, in every terminal — and the clipboard is
 * attempted on top of it.
 *
 * Three routes, tried in order:
 *
 * 1. the platform's own clipboard program (`pbcopy`, `clip`, `wl-copy`, …);
 * 2. OSC 52, which asks the *terminal* to set the clipboard. That is the one
 *    that works over ssh, where the program would set the wrong machine's
 *    clipboard, and inside tmux, which needs `set-clipboard on`;
 * 3. nothing but the file, reported as a path rather than as a failure.
 *
 * Nothing here throws: a copy that did not happen is a sentence on screen, not
 * a crashed run.
 */

export interface ClipboardProgram {
  cmd: string;
  args: string[];
}

export interface CopyResult {
  ok: boolean;
  via: "program" | "osc52" | "file";
  /** The program that took it, or the file that holds it. */
  detail: string;
}

/**
 * tmux refuses a longer passthrough than this by default, and a clipboard that
 * silently did nothing is worse than a file path. Above the limit, skip OSC 52.
 */
export const OSC52_LIMIT = 74_994;

/** The clipboard program for a platform, in the order worth trying. */
export function clipboardPrograms(
  platform: string,
  exists: (cmd: string) => boolean,
): ClipboardProgram[] {
  const table: Record<string, ClipboardProgram[]> = {
    darwin: [{ cmd: "pbcopy", args: [] }],
    win32: [{ cmd: "clip", args: [] }],
    linux: [
      { cmd: "wl-copy", args: [] },
      { cmd: "xclip", args: ["-selection", "clipboard"] },
      { cmd: "xsel", args: ["--clipboard", "--input"] },
    ],
  };
  return (table[platform] ?? table.linux!).filter((p) => exists(p.cmd));
}

/** The escape sequence that asks a terminal to set its clipboard. */
export function osc52(text: string): string {
  return `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`;
}

/** Run one clipboard program, feeding it the text. True when it exited clean. */
async function feed(program: ClipboardProgram, text: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([program.cmd, ...program.args], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.stdin.write(text);
    await proc.stdin.end();
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Copy `text` to the clipboard, and write it to `file`.
 *
 * The file is written first and unconditionally, so the caller always has
 * something to point at.
 */
export async function copyMarkdown(
  text: string,
  file: string,
  options: {
    platform?: string;
    exists?: (cmd: string) => boolean;
    /** OSC 52 only works if there is a terminal on the other end of stdout. */
    isTTY?: boolean;
    stdout?: { write: (chunk: string) => unknown };
    /** For tests: a real `pbcopy` would overwrite the developer's clipboard. */
    programs?: ClipboardProgram[];
  } = {},
): Promise<CopyResult> {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? ((cmd: string) => Bun.which(cmd) !== null);
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);
  const stdout = options.stdout ?? process.stdout;
  const programs = options.programs ?? clipboardPrograms(platform, exists);

  await writeFile(file, text.endsWith("\n") ? text : `${text}\n`);

  for (const program of programs) {
    if (await feed(program, text)) return { ok: true, via: "program", detail: program.cmd };
  }

  if (isTTY && Buffer.byteLength(text, "utf8") <= OSC52_LIMIT) {
    stdout.write(osc52(text));
    return { ok: true, via: "osc52", detail: "osc52" };
  }

  return { ok: false, via: "file", detail: file };
}

/**
 * The sentence the TUI shows after a copy: what happened, in one line.
 *
 * `name` is the file's name, not its path: the pane's footer already shows the
 * run directory, and a notice that wraps to three lines to spell the path out
 * again is a notice that pushed the result up the screen.
 */
export function copyNotice(result: CopyResult, chars: number, name: string): string {
  if (result.via === "program") {
    return `copied ${chars} characters to the clipboard (${result.detail}) · also ${name}`;
  }
  if (result.via === "osc52") {
    return `copied ${chars} characters — sent to the terminal's clipboard · also ${name}`;
  }
  return `no clipboard here — the markdown is in ${name}, in the run directory above`;
}
