import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clipboardPrograms,
  copyMarkdown,
  copyNotice,
  osc52,
  OSC52_LIMIT,
} from "./clipboard.ts";

const always = () => true;
const never = () => false;

describe("clipboardPrograms", () => {
  test("darwin uses pbcopy", () => {
    expect(clipboardPrograms("darwin", always).map((p) => p.cmd)).toEqual(["pbcopy"]);
  });

  test("linux prefers wayland, then xclip, then xsel", () => {
    expect(clipboardPrograms("linux", always).map((p) => p.cmd)).toEqual([
      "wl-copy",
      "xclip",
      "xsel",
    ]);
  });

  test("only programs that are actually installed are offered", () => {
    const programs = clipboardPrograms("linux", (cmd) => cmd === "xclip");
    expect(programs.map((p) => p.cmd)).toEqual(["xclip"]);
    expect(programs[0]!.args).toContain("clipboard");
  });

  test("an unknown platform falls back to the linux list", () => {
    expect(clipboardPrograms("plan9", always).map((p) => p.cmd)).toContain("xclip");
  });
});

describe("osc52", () => {
  test("is the escape sequence with the text base64 encoded", () => {
    expect(osc52("hi")).toBe("\u001b]52;c;aGk=\u0007");
  });
});

describe("copyMarkdown", () => {
  const withTemp = async (run: (file: string) => Promise<void>) => {
    const dir = await mkdtemp(path.join(tmpdir(), "adv-clip-"));
    try {
      await run(path.join(dir, "answer.md"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test("always writes the file, so a failed clipboard is still a copy", async () => {
    await withTemp(async (file) => {
      const result = await copyMarkdown("the answer", file, {
        programs: [],
        isTTY: false,
      });
      expect(result).toEqual({ ok: false, via: "file", detail: file });
      expect(await readFile(file, "utf8")).toBe("the answer\n");
    });
  });

  test("does not double a trailing newline", async () => {
    await withTemp(async (file) => {
      await copyMarkdown("the answer\n", file, { programs: [], isTTY: false });
      expect(await readFile(file, "utf8")).toBe("the answer\n");
    });
  });

  test("uses the first program that exits clean", async () => {
    await withTemp(async (file) => {
      const result = await copyMarkdown("text", file, {
        programs: [
          { cmd: "false", args: [] },
          { cmd: "cat", args: [] },
        ],
        isTTY: false,
      });
      expect(result).toEqual({ ok: true, via: "program", detail: "cat" });
    });
  });

  test("a program that is not installed falls through instead of throwing", async () => {
    await withTemp(async (file) => {
      const result = await copyMarkdown("text", file, {
        programs: [{ cmd: "adv-no-such-program", args: [] }],
        isTTY: false,
      });
      expect(result.via).toBe("file");
    });
  });

  test("falls back to OSC 52 for a terminal with no clipboard program", async () => {
    await withTemp(async (file) => {
      const written: string[] = [];
      const result = await copyMarkdown("text", file, {
        programs: [],
        isTTY: true,
        stdout: { write: (chunk: string) => written.push(chunk) },
      });
      expect(result.via).toBe("osc52");
      expect(written.join("")).toBe(osc52("text"));
    });
  });

  test("a payload too large for a terminal passthrough goes to the file instead", async () => {
    await withTemp(async (file) => {
      const written: string[] = [];
      const result = await copyMarkdown("x".repeat(OSC52_LIMIT + 1), file, {
        programs: [],
        isTTY: true,
        stdout: { write: (chunk: string) => written.push(chunk) },
      });
      expect(result.via).toBe("file");
      expect(written).toHaveLength(0);
    });
  });
});

describe("copyNotice", () => {
  test("says what took it, and where the file is", () => {
    expect(copyNotice({ ok: true, via: "program", detail: "pbcopy" }, 42, "answer.md")).toBe(
      "copied 42 characters to the clipboard (pbcopy) · also answer.md",
    );
  });

  test("says when the terminal took it", () => {
    expect(copyNotice({ ok: true, via: "osc52", detail: "osc52" }, 42, "answer.md")).toContain(
      "terminal's clipboard",
    );
  });

  test("a failed clipboard is a file to read, not an error", () => {
    expect(copyNotice({ ok: false, via: "file", detail: "/run/answer.md" }, 42, "answer.md")).toBe(
      "no clipboard here — the markdown is in answer.md, in the run directory above",
    );
  });

  test("the notice is short enough not to wrap the pane", () => {
    expect(copyNotice({ ok: false, via: "file", detail: "x" }, 12_345, "answer.md").length)
      .toBeLessThan(80);
  });
});
