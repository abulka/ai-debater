/**
 * Chained runs: continuing a debate by content, not by session.
 *
 * Each `--standalone` run has its own session store, so a continuation cannot
 * resume a session — it starts a new run whose task carries the previous
 * result plus the human's follow-up. That is not a workaround: a new run
 * means a fresh draft, a fresh cross-family review, and the gate again, which
 * is what "continuing the debate" means in this architecture.
 */

export interface Continuation {
  /** The new run's task: parent header, previous result, human follow-up. */
  task: string;
}

/**
 * Compose the task for a chained run. Pure, so it is testable without a run
 * on disk. Self-describing even without `state.parent`: the header names the
 * parent run, the previous result travels whole, and the follow-up is the
 * human's own words.
 */
export function composeContinuation(parentName: string, previousResult: string, followUp: string): Continuation {
  const result = previousResult.trim();
  const follow = followUp.trim();
  const task =
    `Continuing the debate from run ${parentName}.\n` +
    `\n` +
    `PREVIOUS RESULT\n` +
    `${result}\n` +
    `\n` +
    `FOLLOW-UP\n` +
    `${follow}\n`;
  return { task };
}

/** A follow-up is required: without the human's words this is a rerun, not a continuation. */
export function followUpOf(flag: unknown, rest: string[]): string | null {
  if (typeof flag === "string" && flag.trim()) return flag.trim();
  const text = rest.join(" ").trim();
  return text ? text : null;
}

/**
 * What a run asked, as one readable line.
 *
 * A continued run's task is a payload — parent header, the whole previous
 * result, then FOLLOW-UP with the human's actual words. Showing the payload
 * raw puts "PREVIOUS RESULT" and its blank lines into the past-debates list
 * and the result header. This extracts the follow-up when there is one and
 * flattens the rest to a single line.
 */
export function displayTaskOf(task: string): string {
  return questionOf(task).replace(/\s+/g, " ").trim();
}

/** The human's words: the follow-up of a continued run, else the whole task. */
export function questionOf(task: string): string {
  const followUp = /^FOLLOW-UP\n([\s\S]*?)\s*$/m.exec(task)?.[1]?.trim();
  return followUp || task.trim();
}
