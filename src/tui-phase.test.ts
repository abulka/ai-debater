import { describe, expect, test } from "bun:test";

/**
 * Every phase draws something.
 *
 * The clarify phase once shipped its type member, its input handler and its
 * routing — but no render branch. Answering "that reads like a general
 * question" then drew a blank frame with only the mouse line on it, while the
 * invisible handler kept answering keys. A phase the render chain never
 * matches is a screen that can never be seen, so the union and the chain are
 * pinned together here: adding a member to `Phase` without a branch fails
 * this test.
 *
 * What counts as a branch is the render chain's own shape — `if (phase ===
 * "x")` / `else if (phase === "x" …)` where `content` is assigned. Handlers
 * (`{ isActive: phase === "x" }`), guards (`phase === "x" && …` in any other
 * position) and status ternaries do not count: none of them draws anything.
 */
const source = await Bun.file(new URL("./tui.tsx", import.meta.url)).text();

function phaseMembers(): string[] {
  const block = /type Phase =((?:\s*\|\s*"[^"]+")+)\s*;/.exec(source)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

function renderBranchCount(phase: string): number {
  // An `if`/`else if` whose condition starts with this phase. A shared branch
  // (`phase === "running" || phase === "working"`) counts for both members,
  // which is why this is a count of matches rather than of branches.
  const re = new RegExp(`(?:if|else if)\\s*\\(\\s*phase === "${phase}"`, "g");
  return [...source.matchAll(re)].length;
}

describe("every Phase member has a render branch", () => {
  const members = phaseMembers();

  test("the union parses — the test reads the type, not a copy of it", () => {
    // Twenty members at the time of writing; the exact number is not the
    // contract (a new phase extends both lists), but an empty parse would
    // make every assertion below vacuous, so the parse itself is asserted.
    expect(members.length).toBeGreaterThan(10);
    expect(members).toContain("result");
    expect(members).not.toContain("gate");
    expect(members).not.toContain("setup");
    expect(members).not.toContain("working");
    // clarify was retired 20 Oct: the desk's subject switch is the choice,
    // and asking again after Enter was the same question twice.
    expect(members).not.toContain("clarify");
  });

  for (const phase of phaseMembers()) {
    test(`"${phase}" is matched by the render chain`, () => {
      expect(renderBranchCount(phase)).toBeGreaterThan(0);
    });
  }
});
