import { describe, expect, test } from "bun:test";
import { decodeMouse, MOUSE_OFF, MOUSE_ON, wheelDirection, wheelRows, WHEEL_STEP } from "./mouse.ts";

describe("decodeMouse", () => {
  test("reads a wheel report", () => {
    expect(decodeMouse("\u001b[<64;10;5M")).toEqual([{ button: 64, x: 10, y: 5, press: true }]);
    expect(decodeMouse("\u001b[<65;3;20M")).toEqual([{ button: 65, x: 3, y: 20, press: true }]);
  });

  test("a release report is told apart from a press", () => {
    expect(decodeMouse("\u001b[<0;4;4m")[0]?.press).toBe(false);
  });

  test("finds every report in a chunk that also holds keystrokes", () => {
    // A terminal batches: a wheel notch and the letter after it can arrive in
    // one read, and both matter.
    const chunk = "\u001b[<65;1;1M\u001b[<65;1;1Mq";
    expect(decodeMouse(chunk)).toHaveLength(2);
    expect(wheelRows(chunk)).toBe(2 * WHEEL_STEP);
  });

  test("plain typing is not a mouse report", () => {
    expect(decodeMouse("hello \u001b[A world")).toEqual([]);
    expect(wheelRows("hello")).toBe(0);
  });
});

describe("the wheel is told apart from the buttons", () => {
  test("a notch has a direction, a click does not", () => {
    expect(wheelDirection({ button: 64, x: 1, y: 1, press: true })).toBe(-1);
    expect(wheelDirection({ button: 65, x: 1, y: 1, press: true })).toBe(1);
    expect(wheelDirection({ button: 0, x: 1, y: 1, press: true })).toBe(0);
  });
});

describe("wheelRows", () => {
  test("up is negative, down is positive, a notch is a few rows", () => {
    expect(wheelRows("\u001b[<64;1;1M")).toBe(-WHEEL_STEP);
    expect(wheelRows("\u001b[<65;1;1M")).toBe(WHEEL_STEP);
    expect(wheelRows("\u001b[<64;1;1M\u001b[<65;1;1M")).toBe(0);
  });

  test("clicks and drags move nothing", () => {
    for (const button of [0, 1, 2, 32, 34]) {
      expect(wheelRows(`\u001b[<${button};5;5M`)).toBe(0);
    }
  });
});

describe("the reporting sequences", () => {
  test("are a matched pair, so the terminal is handed back as it was found", () => {
    expect(MOUSE_ON).toContain("1000h");
    expect(MOUSE_ON).toContain("1006h");
    expect(MOUSE_OFF).toContain("1000l");
    expect(MOUSE_OFF).toContain("1006l");
  });
});
