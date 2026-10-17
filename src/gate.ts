import * as readline from "node:readline/promises";
import type { Claims, Gate, Review } from "./contracts.ts";

/**
 * The human gate. Nothing here is decided by a model: the human answers every
 * judgment call and triages every finding.
 *
 * Interactive on a TTY. Otherwise answers are read from stdin up front — which
 * makes the flow scriptable now and drivable by a UI later. If the piped
 * answers run out, it throws rather than blocking forever.
 */
export async function collectGate(claims: Claims, review: Review): Promise<Gate> {
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

  try {
    console.log("");
    for (const judgment of claims.judgment) {
      const tradeoffs = review.tradeoffs.find((t) => t.id === judgment.id);
      console.log(`  ${judgment.id}  ${judgment.text}`);
      judgment.options.forEach((option, i) => {
        const against = tradeoffs?.per_option.find((p) => p.option === option)?.against ?? [];
        console.log(`     ${i + 1}. ${option}${against.length ? `   — ${against.join("; ")}` : ""}`);
      });

      for (;;) {
        const answer = (await ask(`  ${judgment.id}: 1-${judgment.options.length}, or "open": `)).trim();
        if (answer === "open") {
          decisions.push({ id: judgment.id, choice: "open" });
          break;
        }
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 1 && n <= judgment.options.length) {
          decisions.push({ id: judgment.id, choice: judgment.options[n - 1] ?? "" });
          break;
        }
        console.log("     (answer with a number or 'open')");
      }
    }

    for (const finding of review.extra_findings) {
      for (;;) {
        const answer = (await ask(`  ${finding.id}: [a]ccept / [d]ismiss — ${finding.text} `))
          .trim()
          .toLowerCase();
        if (answer === "a" || answer === "accept") {
          findings.push({ id: finding.id, disposition: "accepted" });
          break;
        }
        if (answer === "d" || answer === "dismiss") {
          findings.push({ id: finding.id, disposition: "dismissed" });
          break;
        }
        console.log("     (answer 'accept' or 'dismiss')");
      }
    }
  } finally {
    rl?.close();
  }

  return { decisions, findings };
}
