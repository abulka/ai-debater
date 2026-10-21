import type { Mode } from "./runner.ts";

/* ------------------------------------------------------------------ *
 * Prompts.
 *
 * Two modes:
 *   "plan"   — an implementation plan for a repository (reads files).
 *   "answer" — a general question. No repo assumed; facts are checked
 *              against URLs, and the model may search the web.
 *
 * Each call asks for ONE thing: a take, or the synthesis, as prose.
 * ------------------------------------------------------------------ */

/* --- council: parallel takes plus one synthesis ------------------- */

const SCOPE = `- The subject is the working directory you are in. It may sit inside a larger git
  repository: treat this directory as the whole subject, and cite only files
  under it.`;

export function takePrompt(i: { mode: Mode; task: string; criteria: string; decisions: string }): string {
  if (i.mode === "answer") {
    return `Answer the question below, thoroughly and concretely.

RULES
- Answer in your own voice, succinctly. No mention of the process or of other models.
- Lead with the answer in one sentence, then the detail. No preamble.
- If the question asks which option is best, RECOMMEND ONE and say why. Never hand the choice back.
- Prefer short prose: the answer, the reasoning, then sources. Bullets only when the answer is genuinely a list. Aim for about 300 words.
- Every factual assertion should be checkable. Put sources at the END as numbered footnotes, with markers such as [1] in the text. Verify current facts with websearch/webfetch where it matters.
- Never invent a source.
- The criteria below are fixed — they describe what a good answer looks like for this person. Do not invent criteria.

CRITERIA
${i.criteria}

SETTLED DECISIONS
${i.decisions || "(none yet)"}

QUESTION
${i.task}

Write the answer as Markdown.`;
  }
  return `You are working in the repository you are in.

What the task asks for decides the deliverable:

- If it asks for a CHANGE — add, fix, refactor, migrate, remove — produce an
  implementation PLAN: steps, risks, what to verify. Do not write code and do
  not modify any file.
- If it asks a QUESTION about the code — how something works, where something
  lives, why it behaves this way — ANSWER it, citing file and line. Lead with
  the answer in a few sentences.

RULES
${SCOPE}
- Every statement about the codebase must come from a file you actually read.
  Do not guess. You have no shell: do not run commands, and do not write notes
  about what you could not run.
- Answer succinctly, in your own voice. Pick sensible defaults and recommend
  one approach. Do not pad the answer with "open decisions" sections, option
  lists, or tours of candidates you did not choose.
- The criteria below are fixed. Do not invent criteria.
- The settled decisions below are closed. Do not reopen them, and do not recite
  them — cite one by id only where it bears on a choice.
- Keep it as short as the task allows. Do not describe the process or these
  instructions; the plan or answer stands on its own.

CRITERIA
${i.criteria}

SETTLED DECISIONS
${i.decisions || "(none yet)"}

TASK
${i.task}

Write the plan as Markdown.`;
}

export function synthesizePrompt(i: {
  mode: Mode;
  task: string;
  takes: { model: string; text: string }[];
}): string {
  const peerBlock = i.takes
    .map((t, n) => `--- take ${n + 1} (${t.model}) ---\n${t.text}`)
    .join("\n\n");
  const peers = i.takes.slice(1).map((x) => x.model).join(", ");
  return `You answered the task below (your take is listed first). ${i.takes.length - 1} other model${i.takes.length - 1 === 1 ? "" : "s"} answered the same prompt independently. What can we learn from ${peers}, if anything? Their takes are labelled below.

RULES
- Produce the best, most succinct final response to the user's task. Keep what was already right in your take; incorporate anything the peers caught, verified, or explained more simply; fix any factual errors.
- Do not pad the answer or turn it into a committee compromise — if one approach is clearly better, recommend it.
- Write the final response as Markdown, in your own voice, with no mention of the process.
- The answer stands on its own: never narrate your own drafting process — no corrections to an earlier take, no 'I previously said', no mention of takes.
- At the very end, under a \`## What we learned\` heading, add 2–4 concise bullets noting what changed because of the other model(s), or where the models genuinely disagreed.
- Name each model by its ref, never as take 1, take 2 or the other take. The reader knows the models, not the take numbers.

TASK
${i.task}

${peerBlock}

Write the final response as Markdown, ending with the \`## What we learned\` section.`;
}

/** Split the trailing "## What we learned" section from the final answer. */
export function splitLearned(text: string): { final: string; learned: string } {
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => /^\s*##\s+what we learned\s*$/i.test(l));
  if (idx === -1) return { final: text.trim(), learned: "" };
  return {
    final: lines.slice(0, idx).join("\n").trim(),
    learned: lines.slice(idx).join("\n").trim(),
  };
}

/**
 * Name the takes in synthesis output.
 *
 * "What we learned" is model prose, and the prompt's naming rule is advice
 * the model may ignore — "the peer model" three times in a row has been
 * observed despite it. The mechanical cases are unambiguous (take N is the
 * Nth take), so they are renamed deterministically: take 1 becomes the lead
 * ref, take 2 the first peer, and with exactly one peer, "the peer model"
 * and "the other take" become its ref. Anything vaguer ("the two answers")
 * is left to the prompt.
 */
export function nameTakesInLearned(
  text: string,
  models: { ref: string }[],
): string {
  const ticked = models.map((m) => `\`${m.ref}\``);
  let out = text;
  // "Take 2" in any capitalisation becomes the model's ref. An out-of-range
  // number ("take 9" with two models) is left alone: that is the model
  // confused, not a take to name.
  out = out.replace(/\btake (\d+)\b/gi, (match: string, n: string) => {
    const ref = ticked[Number(n) - 1];
    return ref ?? match;
  });
  if (models.length === 2) {
    const peer = ticked[1]!;
    out = out
      .replace(/\bthe peer model's\b/gi, peer + "'s")
      .replace(/\bthe peer model\b/gi, peer)
      .replace(/\bpeer takes?\b/gi, peer + "'s take")
      .replace(/\bthe other takes?\b/gi, (m: string) => (m[0] === 'T' ? 'The ' : 'the ') + peer);
  }
  return out;
}

/* --- retry -------------------------------------------------------- */

/**
 * Recovery when the provider rejected the model's whole turn, before any reply:
 * it called a tool that was not in the tool list it was given.
 */
export function toolRetryPrompt(): string {
  return `A previous attempt was rejected by the provider before you produced any text: it called a tool that does not exist, or that was not among the tools you were offered.

Do not invent tools. Use only the tools you have actually been given. If none of them fits, answer in plain text instead of calling one.`;
}
