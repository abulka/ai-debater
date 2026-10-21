import { describe, expect, test } from "bun:test";
import { nameTakesInLearned } from "./prompts.ts";

const two = [{ ref: "lead/a" }, { ref: "peer/b" }];

describe("nameTakesInLearned", () => {
  test("take numbers become model refs in any capitalisation", () => {
    expect(nameTakesInLearned("Take 1 says X, but take 2 says Y.", two)).toBe(
      "`lead/a` says X, but `peer/b` says Y.",
    );
  });

  test("an out-of-range take number is left alone", () => {
    expect(nameTakesInLearned("take 9 is not a take.", two)).toBe("take 9 is not a take.");
  });

  test("the peer model becomes its ref with exactly one peer", () => {
    expect(nameTakesInLearned("The peer model's point stands.", two)).toBe(
      "`peer/b`'s point stands.",
    );
    expect(nameTakesInLearned("The peer model stayed silent.", two)).toBe(
      "`peer/b` stayed silent.",
    );
  });

  test("the other take becomes the peer with exactly one peer", () => {
    expect(nameTakesInLearned("The other take is thinner.", two)).toBe(
      "The `peer/b` is thinner.",
    );
  });

  test("peer phrasing is left alone with two peers — ambiguous", () => {
    const three = [...two, { ref: "peer/c" }];
    expect(nameTakesInLearned("The peer model disagrees; take 3 agrees.", three)).toBe(
      "The peer model disagrees; `peer/c` agrees.",
    );
  });

  test("first-person prose passes through untouched", () => {
    expect(nameTakesInLearned("Two corrections to my earlier take.", two)).toBe(
      "Two corrections to my earlier take.",
    );
  });
});
