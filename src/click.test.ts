import { describe, expect, test } from "bun:test";
import { rowAt, type RowRect } from "./click.ts";

const rects: RowRect[] = [
  { index: 0, top: 10, height: 1 },
  { index: 1, top: 11, height: 1 },
  // A group header sits at row 12: no rectangle, so a click there is a miss.
  { index: 2, top: 13, height: 1 },
];

describe("rowAt", () => {
  test("hits the row whose band holds the click", () => {
    expect(rowAt(rects, 10)).toBe(0);
    expect(rowAt(rects, 11)).toBe(1);
    expect(rowAt(rects, 13)).toBe(2);
  });

  test("a shared boundary belongs to the row below", () => {
    const tall: RowRect[] = [
      { index: 0, top: 5, height: 2 },
      { index: 1, top: 7, height: 1 },
    ];
    expect(rowAt(tall, 7)).toBe(1);
  });

  test("gaps and out-of-range clicks miss", () => {
    expect(rowAt(rects, 12)).toBeNull();
    expect(rowAt(rects, 9)).toBeNull();
    expect(rowAt(rects, 14)).toBeNull();
    expect(rowAt([], 10)).toBeNull();
  });
});
