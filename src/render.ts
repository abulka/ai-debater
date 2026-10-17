import type { Changelog, Claims, Gate } from "./contracts.ts";
import type { DiffAssessment } from "./diff.ts";

const rule = (n: number) => "─".repeat(n);

export function renderResult(a: {
  plan: string;
  changelog: Changelog;
  patch: string;
  assessment: DiffAssessment;
  gate: Gate;
  claims: Claims;
}): string {
  const out: string[] = [];

  out.push(`── plan.v2 ${rule(50)}`);
  out.push(a.plan.trim());
  out.push("");

  out.push(`── changes ${rule(50)}`);
  if (a.changelog.changes.length === 0) {
    out.push("  (none claimed)");
  } else {
    for (const c of a.changelog.changes) {
      out.push(`  ${c.item.padEnd(4)} ${c.disposition.padEnd(9)} ${c.summary}`);
    }
  }
  out.push("");
  out.push(
    `  diff: ${a.assessment.hunks} hunk(s), ${a.assessment.claimedChanges} claimed change(s)`,
  );
  if (a.assessment.outOfScope) {
    out.push("  !! the plan changed but the changelog claims nothing — possible out-of-scope edit");
  } else if (a.assessment.unexplained > 0) {
    out.push(`  !  ${a.assessment.unexplained} hunk(s) not accounted for in the changelog`);
  }

  out.push("");
  out.push(`── open decisions ${rule(43)}`);
  const open = a.gate.decisions.filter((d) => d.choice === "open");
  out.push(
    open.length
      ? open
          .map((d) => `  ${d.id}  ${a.claims.judgment.find((j) => j.id === d.id)?.text ?? ""}`)
          .join("\n")
      : "  none",
  );

  return out.join("\n");
}
