import type { DraftInput, Mode, RebutInput, ReviewInput } from "./runner.ts";

/* ------------------------------------------------------------------ *
 * Prompts.
 *
 * Two modes:
 *   "plan"   — an implementation plan for a repository (reads files).
 *   "answer" — a general question. No repo assumed; facts are checked
 *              against URLs, and the reviewer may search the web.
 *
 * Each call asks for ONE thing: prose, or a single JSON block. Mixing them
 * is where models get flaky — a drafter will write a good plan and forget
 * the JSON block entirely.
 * ------------------------------------------------------------------ */

const fmt = (v: unknown) => JSON.stringify(v, null, 2);

const EVIDENCE =
  "Evidence is a URL, or a file path optionally with a line (e.g. src/http.ts:88). " +
  "It is never a command or its output: nothing is executed, so command output cannot be checked.";

const CLAIM_SHAPE = `{"verifiable":[{"id":"V1","text":"..."}],"judgment":[{"id":"J1","text":"...","options":["...","..."]}]}`;

const claimsInstruction = (subject: string) => `Below is ${subject}. List what it claims.

Produce exactly two categories:
- "verifiable": factual assertions that can be checked against a URL, or against
  a file in the working directory.
- "judgment": choices where reasonable alternatives exist. List the options, at
  least two. Do NOT choose between them.

Reply with ONLY a fenced \`\`\`json block, nothing before or after it:

${CLAIM_SHAPE}`;

/* --- draft -------------------------------------------------------- */

export function draftPrompt(i: DraftInput): string {
  return i.mode === "answer" ? answerPrompt(i) : planPrompt(i);
}

export function claimsPrompt(i: { mode: Mode; body: string }): string {
  return `${claimsInstruction(i.mode === "answer" ? "an answer" : "an implementation plan")}

${i.mode === "answer" ? "ANSWER" : "PLAN"}
${i.body}`;
}

function planPrompt(i: DraftInput): string {
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

function answerPrompt(i: DraftInput): string {
  return `Answer the question below, thoroughly and concretely.

RULES
- Every factual assertion must be checkable. Cite a URL for it where you can.
- Answer from what you know. Do NOT browse, fetch or search to do it yourself:
  a separate reviewer checks your facts against sources, and it has the tools for
  that. Mark anything you are unsure of plainly rather than asserting it.
- Never invent a source, and never call a tool by a name you were not given.
- Do not choose between options where reasonable people could differ. Name the
  decision and the options, and leave it open for the human.
- The criteria below are fixed — they describe what a good answer looks like for
  this person. Do not invent criteria.

CRITERIA
${i.criteria}

SETTLED DECISIONS
${i.decisions || "(none yet)"}

QUESTION
${i.task}

Write the answer as Markdown. A separate step will list the claims it makes — do
not include a JSON block.`;
}

/* --- review ------------------------------------------------------- */

export function reviewPrompt(i: ReviewInput): string {
  const subject = i.mode === "answer" ? "an answer" : "an implementation plan";
  const verifyRule =
    i.mode === "answer"
      ? `- For every factual claim, give exactly one verdict:
  - "confirmed": you checked the cited URL, or otherwise verified the fact. Give "evidence" (a URL).
  - "refuted":   you checked and it is wrong. Give "evidence" (a URL) and a "note".
  - "unverifiable": you could not check it. Give a short "note" saying why, and no evidence.
- Use websearch and webfetch to check claims. Do not confirm a claim you have not checked.
- Watch for claims that are true but misleading, stale numbers, and unsupported
  certainty. These are the common failures in a confident answer.`
      : `- For every verifiable claim, give exactly one verdict:
  - "confirmed": you inspected the evidence and it supports the claim. Give "evidence".
  - "refuted":   you inspected the evidence and it contradicts the claim. Give "evidence".
  - "unverifiable": it cannot be settled by reading a file or a URL. Give a short "note" saying why, and no evidence.
- ${EVIDENCE}`;

  const taskBlock = i.mode === "answer" ? "QUESTION" : "TASK";

  return `You are an adversarial reviewer of ${subject}${i.mode === "plan" ? " for the repository you are in" : ""}.

RULES
- Verify. Do not rewrite. NEVER propose an alternative answer${i.mode === "plan" ? " or plan" : ""}.
${verifyRule}
- For every judgment call, list trade-offs for each option against the criteria.
  Do not recommend one, and do not resolve it.
- You may add problems the author did not list. Give them ids E1, E2, ...
- A judgment call must have at least TWO real options. If the text already picked
  one, that is not a judgment call — say so instead.

CRITERIA
${i.criteria}

${taskBlock}
${i.task}

${i.mode === "answer" ? "ANSWER UNDER REVIEW" : "PLAN UNDER REVIEW"}
${i.plan}

CLAIMS TO VERIFY
${fmt(i.claims)}

Reply with ONLY a single fenced \`\`\`json block, nothing else:

{"verdicts":[{"id":"V1","verdict":"confirmed","evidence":"https://…"},
             {"id":"V2","verdict":"unverifiable","note":"needs a benchmark I cannot run"}],
 "tradeoffs":[{"id":"J1","per_option":[{"option":"...","against":["..."]}]}],
 "extra_findings":[{"id":"E1","kind":"verifiable","text":"...","evidence":"https://…"}]}`;
}

/* --- rebuttal ----------------------------------------------------- */

export function rebutPrompt(i: RebutInput): string {
  const subject = i.mode === "answer" ? "answer" : "plan";
  return `You wrote the ${subject} below. It has been reviewed and a human has decided.
Rewrite the ${subject} so that it applies exactly the authorised items and changes
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
- Do not reopen settled decisions. ${EVIDENCE}

CURRENT ${subject.toUpperCase()}
${i.plan}

Return the full revised ${subject} as Markdown. A separate step will record the
changelog — do not include a JSON block.`;
}

export function changelogPrompt(a: {
  before: string;
  after: string;
  items: { id: string; note: string }[];
}): string {
  return `A document was revised. Give the changelog: one entry per authorised item.

Dispositions: "fixed" or "rebutted" for a refuted claim, "applied" for an accepted
finding or a human decision, "no-op" if it required no change.

AUTHORISED ITEMS
${fmt(a.items)}

Reply with ONLY a fenced \`\`\`json block, nothing else:

{"changes":[{"item":"V2","disposition":"fixed","summary":"..."},
            {"item":"V4","disposition":"rebutted","summary":"...","evidence":"https://…"},
            {"item":"J1","disposition":"applied","summary":"..."}]}

BEFORE
${a.before}

AFTER
${a.after}`;
}

/* --- retry -------------------------------------------------------- */

export function retryPrompt(error: string): string {
  return `Your previous reply failed schema validation:

${error}

Reply again with ONLY the corrected fenced \`\`\`json block, and nothing else.`;
}

/**
 * Recovery when the provider rejected the model's whole turn, before any reply:
 * it called a tool that was not in the tool list it was given.
 */
export function toolRetryPrompt(): string {
  return `A previous attempt was rejected by the provider before you produced any text: it called a tool that does not exist, or that was not among the tools you were offered.

Do not invent tools. Use only the tools you have actually been given. If none of them fits, answer in plain text instead of calling one.`;
}
