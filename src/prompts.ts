import type { Claims } from "./contracts.ts";
import type { DraftInput, RebutInput, ReviewInput } from "./runner.ts";

/* ------------------------------------------------------------------ *
 * Prompts.
 *
 * Each call asks for ONE thing: either prose, or a single JSON block.
 * Mixing them in one reply is where models get flaky — a drafter will
 * happily write a good plan and forget the JSON block entirely.
 * ------------------------------------------------------------------ */

const fmt = (v: unknown) => JSON.stringify(v, null, 2);

export const EVIDENCE_HINT =
  "evidence must be `path:line` (e.g. src/http.ts:88) or a URL — command output is not " +
  "acceptable evidence. If a claim can only be settled by running a command, return " +
  '"unverifiable".';

/* --- draft, part 1: the plan -------------------------------------- */

export function draftPlanPrompt(i: DraftInput): string {
  return `You are drafting an implementation plan for a task in the repository you are in.

RULES
- Produce a PLAN. Do not write code and do not modify any file.
- Every statement about the codebase must come from a file you actually read, or a
  git command you actually ran. Do not guess.
- Do not choose between options where reasonable people could differ. Name the
  decision and the options, and leave it open for the human.
- The criteria below are fixed. Do not invent criteria.
- The settled decisions below are closed. Do not reopen them.

CRITERIA
${i.criteria}

SETTLED DECISIONS
${i.decisions || "(none yet)"}

TASK
${i.task}

Write the plan as Markdown. A separate step will list the claims it makes — do not
include a JSON block.`;
}

/* --- draft, part 2: the claims ------------------------------------ */

export function claimsPrompt(plan: string): string {
  return `Below is an implementation plan. List what it claims.

Produce exactly two categories:
- "verifiable": statements about code, APIs, library behaviour, or math that can
  be checked by reading a file or a URL.
- "judgment": decisions where reasonable options exist. List the options. Do NOT
  choose between them.

Reply with ONLY a fenced \`\`\`json block, nothing before or after it:

{"verifiable":[{"id":"V1","text":"..."}],"judgment":[{"id":"J1","text":"...","options":["...","..."]}]}

PLAN
${plan}`;
}

/* --- review ------------------------------------------------------- */

export function reviewPrompt(i: ReviewInput): string {
  return `You are an adversarial reviewer of an implementation plan for the repository you are in.

RULES
- Verify. Do not rewrite. NEVER propose an alternative plan.
- For every verifiable claim, give exactly one verdict:
  - "confirmed": you inspected the evidence and it supports the claim.
  - "refuted":   you inspected the evidence and it contradicts the claim.
  - "unverifiable": it cannot be settled by reading a file or a URL. Do not guess.
- ${EVIDENCE_HINT}
- For every judgment call, list trade-offs for each option against the criteria.
  Do not recommend one, and do not resolve it.
- You may add findings the drafter did not list. Give them ids E1, E2, ...

CRITERIA
${i.criteria}

TASK
${i.task}

PLAN UNDER REVIEW
${i.plan}

CLAIMS TO VERIFY
${fmt(i.claims)}

Reply with ONLY a single fenced \`\`\`json block, nothing else:

{"verdicts":[{"id":"V1","verdict":"confirmed","evidence":"src/x.ts:42"}],
 "tradeoffs":[{"id":"J1","per_option":[{"option":"...","against":["..."]}]}],
 "extra_findings":[{"id":"E1","text":"...","kind":"verifiable","evidence":"src/x.ts:42"}]}`;
}

/* --- rebuttal, part 1: the revised plan --------------------------- */

export function rebutPlanPrompt(i: RebutInput): string {
  return `You drafted the plan below. It has been reviewed and a human has decided.
Rewrite the plan so that it applies exactly the authorised items and changes
NOTHING else.

AUTHORISED ITEMS

Refuted claims (fix, or rebut with evidence):
${fmt(i.refuted)}

Findings the human accepted:
${fmt(i.accepted)}

Human decisions (settled: apply them):
${fmt(i.decisions)}

RULES
- Do not touch anything not listed.
- Do not reopen settled decisions. ${EVIDENCE_HINT}

CURRENT PLAN
${i.plan}

Return the full revised plan as Markdown. A separate step will record the
changelog — do not include a JSON block.`;
}

/* --- rebuttal, part 2: the changelog ------------------------------ */

export function changelogPrompt(a: {
  before: string;
  after: string;
  items: { id: string; note: string }[];
}): string {
  return `A plan was revised. Give the changelog: one entry per authorised item.

Dispositions: "fixed" or "rebutted" for a refuted claim, "applied" for an accepted
finding or a human decision, "no-op" if it required no change.

AUTHORISED ITEMS
${fmt(a.items)}

Reply with ONLY a fenced \`\`\`json block, nothing else:

{"changes":[{"item":"V2","disposition":"fixed","summary":"..."},
            {"item":"V4","disposition":"rebutted","summary":"...","evidence":"src/x.ts:88"},
            {"item":"J1","disposition":"applied","summary":"..."}]}

PLAN BEFORE
${a.before}

PLAN AFTER
${a.after}`;
}

/* --- retry -------------------------------------------------------- */

export function retryPrompt(error: string): string {
  return `Your previous reply failed schema validation:

${error}

Reply again with ONLY the corrected fenced \`\`\`json block, and nothing else.`;
}

export type { Claims };
