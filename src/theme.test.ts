import { describe, expect, test } from "bun:test";
import { toAnsi } from "./markdown.ts";
import { ANSI_CODES, THEME } from "./theme.ts";

describe("the palette", () => {
  test("every colour it names can be printed as ANSI", () => {
    // Otherwise the TUI shows a colour the CLI drops, and the two front ends
    // describe one run differently.
    for (const [role, colour] of Object.entries(THEME)) {
      expect(`${role}=${colour}`).toBeTruthy();
      expect(ANSI_CODES[colour]).toBeGreaterThan(0);
    }
  });

  test("a role realises as its code, end to end", () => {
    expect(toAnsi([[{ text: "x", color: THEME.danger }]])).toBe("\u001b[31mx\u001b[0m");
    expect(toAnsi([[{ text: "x", color: THEME.accent }]])).toBe("\u001b[36mx\u001b[0m");
    expect(toAnsi([[{ text: "x", color: THEME.code }]])).toBe("\u001b[32mx\u001b[0m");
  });
});
