import type { AuditRecord, Changelog, Claims, Gate, Review } from "./contracts.ts";
import type { DiffAssessment } from "./diff.ts";
import { verdictCounts } from "./gate-model.ts";

const rule = (n: number) => "─".repeat(n);

export function renderResult(a: {
  plan: string;
  changelog: Changelog;
  patch: string;
  assessment: DiffAssessment;
  gate: Gate;
  claims: Claims;
  review: Review;
  checks?: AuditRecord[];
}): string {
  const out: string[] = [];
  const counts = verdictCounts(a.claims, a.review);
  const claimText = (id: string) => a.claims.verifiable.find((c) => c.id === id)?.text ?? "";
  const refuted = a.review.verdicts.filter((v) => v.verdict === "refuted");
  const accepted = a.review.extra_findings.filter(
    (f) => a.gate.findings.find((g) => g.id === f.id)?.disposition === "accepted",
  );

  // Lead with what the review actually did. The plan is the product, but the
  // reason to run two models is the catch, and it should not be buried under
  // fifty lines of plan. Findings count: the real 04-08 run's caught URL typo
  // arrived as an accepted finding, not a refuted claim, so a summary that only
  // counted refutations reported "nothing caught" about a run that caught one.
  out.push(`── review ${rule(50)}`);
  out.push(
    `  ${counts.claims} verifiable claim(s) · ${counts.confirmed} confirmed · ` +
      `${counts.refuted} refuted · ${counts.unverifiable} unverifiable` +
      (counts.noVerdict ? ` · ${counts.noVerdict} without a verdict` : ""),
  );
  if (refuted.length === 0 && accepted.length === 0) {
    out.push("  nothing caught — the reviewer upheld every claim it could check and raised no findings");
  }
  for (const v of refuted) {
    if (v.verdict !== "refuted") continue;
    out.push(`  refuted   ${v.id}  ${claimText(v.id)}`);
    out.push(`            [${v.evidence}]${v.note ? ` — ${v.note}` : ""}`);
  }
  for (const f of accepted.slice(0, 3)) {
    out.push(`  accepted  ${f.id}  ${f.text}`);
    if (f.evidence) out.push(`            [${f.evidence}]`);
  }
  if (accepted.length > 3) out.push(`            … and ${accepted.length - 3} more accepted finding(s)`);
  out.push(
    `  ${counts.findings} finding(s) · ${accepted.length} accepted` +
      (counts.unverifiable
        ? `  ·  ${counts.unverifiable} claim(s) could not be settled from files — the honest answer`
        : ""),
  );
  const checks = a.checks ?? [];
  if (checks.length) {
    const ran = checks.filter((c) => c.outcome !== "not-run");
    const disagreed = checks.filter((c) => c.outcome === "mismatched");
    out.push(
      `  ${ran.length} check(s) run · ${disagreed.length} disagreed` +
        (ran.length < checks.length ? ` · ${checks.length - ran.length} not run` : ""),
    );
    for (const c of disagreed) {
      out.push(`  disagreed: ${c.argv.join(" ")}${c.exitCode !== undefined ? ` (exit ${c.exitCode})` : ""}`);
    }
  }
  out.push("");

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
  out.push(`  diff: ${a.assessment.hunks} hunk(s), ${a.assessment.claimedChanges} claimed change(s)`);
  if (a.assessment.outOfScope) {
    out.push("  !! the plan changed but the changelog claims nothing — possible out-of-scope edit");
  } else if (a.assessment.unexplained > 0) {
    out.push(`  !  ${a.assessment.unexplained} hunk(s) not accounted for in the changelog`);
  }
  if (a.patch) {
    out.push("");
    out.push(a.patch.split("\n").map((line) => `  ${line}`).join("\n"));
  }

  const untriaged = a.review.extra_findings.filter(
    (f) => a.gate.findings.find((g) => g.id === f.id)?.disposition === "untriaged",
  );
  if (untriaged.length) {
    out.push("");
    out.push(`── findings, not triaged ${rule(33)}`);
    for (const f of untriaged) {
      out.push(`  ${f.id}  ${f.text}`);
      if (f.evidence) out.push(`      [${f.evidence}]`);
    }
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
