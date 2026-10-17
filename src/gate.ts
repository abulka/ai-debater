import * as readline from "node:readline/promises";
import type { Claims, Gate, Review } from "./contracts.ts";
import { describeJudgmentCall, findingQuestion, judgmentQuestion } from "./gate-model.ts";

/**
 * The human gate. Nothing here is decided by a model: the human answers every
 * judgment call and triages every finding.
 *
 * Interactive on a TTY. Otherwise answers are read from stdin up front — which
 * makes the flow scriptable now and drivable by a UI later. If the piped
 * answers run out, it throws rather than blocking forever.
 *
 * `previous` is the gate's recorded answers, when it has been asked before
 * (`adv revise`): each prompt shows them, and an empty reply keeps the recorded
 * answer instead of being a typo to re-ask. Without `previous` the old contract
 * holds — every question must be answered.
 */
export async function collectGate(
  claims: Claims,
  review: Review,
  previous?: Gate | null,
): Promise<Gate> {
  const interactive = process.stdin.isTTY === true;

  const buffered = interactive
    ? null
    : (await new Response(process.stdin).text()).split(/\r?\n/);
  let cursor = 0;

  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    : undefined;

  const ask = async (question: string): Promise<string> => {
    if (rl) return rl.question(question);
    process.stdout.write(`${question}\n`);
    if (buffered === null || cursor >= buffered.length) {
      throw new Error("ran out of answers on stdin");
    }
    return (buffered[cursor++] ?? "").trim();
  };

  const decisions: Gate["decisions"] = [];
  const findings: Gate["findings"] = [];

  const currentDecision = (id: string) =>
    previous?.decisions.find((d) => d.id === id)?.choice;
  const currentFinding = (id: string) =>
    previous?.findings.find((f) => f.id === id)?.disposition;

  try {
    console.log("");
    for (const judgment of claims.judgment) {
      const [title, ...options] = describeJudgmentCall(judgment, review);
      console.log(`  ${title}`);
      for (const option of options) console.log(`     ${option}`);

      const current = currentDecision(judgment.id);
      for (;;) {
        const answer = (await ask(judgmentQuestion(judgment, current))).trim();
        if (answer === "") {
          if (!current) {
            console.log("     (answer with a number or 'open')");
            continue;
          }
          decisions.push({ id: judgment.id, choice: current });
          break;
        }
        if (answer === "open") {
          decisions.push({ id: judgment.id, choice: "open" });
          break;
        }
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 1 && n <= judgment.options.length) {
          decisions.push({ id: judgment.id, choice: judgment.options[n - 1] ?? "" });
          break;
        }
        console.log(
          "     (answer with a number or 'open'" + (current ? ", or Enter to keep" : "") + ")",
        );
      }
    }

    for (const finding of review.extra_findings) {
      const current = currentFinding(finding.id);
      for (;;) {
        const answer = (await ask(findingQuestion(finding, current))).trim().toLowerCase();
        if (answer === "" && current) {
          findings.push({ id: finding.id, disposition: current });
          break;
        }
        if (answer === "y" || answer === "yes" || answer === "a" || answer === "accept") {
          findings.push({ id: finding.id, disposition: "accepted" });
          break;
        }
        if (answer === "n" || answer === "no" || answer === "d" || answer === "dismiss") {
          findings.push({ id: finding.id, disposition: "dismissed" });
          break;
        }
        if (answer === "l" || answer === "later" || answer === "s") {
          findings.push({ id: finding.id, disposition: "untriaged" });
          break;
        }
        console.log(
          "     (answer 'yes', 'no', or 'later'" + (current ? " — or Enter to keep" : "") + ")",
        );
      }
    }
  } finally {
    rl?.close();
  }

  return { decisions, findings };
}
