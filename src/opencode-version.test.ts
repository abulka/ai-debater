import { describe, expect, test } from "bun:test";
import {
  OPENCODE_UPGRADE,
  opencodeMajor,
  opencodeVersionIn,
  versionProblem,
} from "./opencode-version.ts";

describe("opencodeVersionIn", () => {
  test("reads a bare version", () => {
    expect(opencodeVersionIn("1.19.3\n")).toBe("1.19.3");
  });

  test("reads a version with a prefix", () => {
    expect(opencodeVersionIn("opencode v2.0.32")).toBe("2.0.32");
  });

  test("no version is null, not zero", () => {
    expect(opencodeVersionIn("not a version")).toBeNull();
  });
});

describe("opencodeMajor", () => {
  test("the major is the first number", () => {
    expect(opencodeMajor("1.19.3")).toBe(1);
    expect(opencodeMajor("v2.0.32")).toBe(2);
  });
});

describe("versionProblem", () => {
  test("OpenCode 1 names the upgrade that crosses the major boundary", () => {
    const problem = versionProblem("1.19.3");
    expect(problem).toContain("requires OpenCode 2");
    expect(problem).toContain("1.19.3");
    expect(problem).toContain(OPENCODE_UPGRADE);
  });

  test("OpenCode 2 is accepted", () => {
    expect(versionProblem("2.0.32")).toBeNull();
  });

  test("a future major is accepted", () => {
    expect(versionProblem("3.1.0")).toBeNull();
  });

  test("an unreadable version is a problem, not an assumption of v2", () => {
    const problem = versionProblem("dev build");
    expect(problem).toContain("Could not read a version");
    expect(problem).toContain(OPENCODE_UPGRADE);
  });
});
