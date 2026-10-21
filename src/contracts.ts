import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Evidence — v1 accepts `path:line` or a URL only.
 *
 * Nothing is executed in v1, so command output cannot be real evidence:
 * a reviewer citing it could only be inventing it. Claims that need a
 * command to settle must come back `unverifiable`.
 * ------------------------------------------------------------------ */

const URL_RE = /^https?:\/\/\S+$/;
// A path, optionally with a line or line range. It must look like a path — it
// has to contain a separator or a dot — which is what stops invented command
// output ("npm test fails") from passing as evidence. The orchestrator also
// checks that the file exists; see pipeline.ts. Note that a string such as
// "./scripts/test.sh --all" does satisfy this shape: the validator is not a
// command filter, which is why commands never travel in `evidence`.
const PATH_RE = /^\S*[/.][^\n]*?(?::\d+(?:-\d+)?)?$/;
// A reference to a recorded execution. Only the orchestrator assigns these, and
// only against records that exist in audit.json — see resolveAuditRef.
const AUDIT_RE = /^audit:A\d+$/;

export const EVIDENCE_RULE =
  "evidence must be a file path (e.g. src/http.ts:88), a URL, or an audit:<id> reference — " +
  "a model may not claim command output as evidence";

export const Evidence = z
  .string()
  .refine((v) => URL_RE.test(v) || AUDIT_RE.test(v) || PATH_RE.test(v), { message: EVIDENCE_RULE });

/** Claim ids: V1.. verifiable, J1.. judgment, E1.. extra findings. */
const Id = z.string().regex(/^[VJE]\d+$/, "id must look like V1, J2, or E3");

export const Claims = z.object({
  verifiable: z.array(z.object({ id: Id, text: z.string().min(1) })),
  judgment: z.array(
    z.object({
      id: Id,
      text: z.string().min(1),
      options: z
        .array(z.string().min(1))
        .min(
          2,
          "a judgment call needs at least two real options — if the plan already " +
            "chose one and lists only that, it is not a judgment call",
        ),
    }),
  ),
});

/**
 * A check the reviewer asks the orchestrator to run, because it could not settle
 * a claim from files alone. The reviewer never runs it and never sees the
 * output: `adv` executes it, records it, and reports the result.
 *
 * `expect` is what makes the result mechanical instead of another opinion: the
 * reviewer must say what it expects to see, and the orchestrator compares.
 */
export const CheckProposal = z.object({
  argv: z.array(z.string().min(1)).min(1, "a proposal needs a command"),
  expect: z
    .object({
      exitCode: z.number().int().optional(),
      stdoutIncludes: z.string().min(1).optional(),
    })
    .refine(
      (e) => e.exitCode !== undefined || e.stdoutIncludes !== undefined,
      "a proposal needs an expected exit code or a substring to look for — " +
        "otherwise the result cannot be judged mechanically",
    ),
  why: z.string().min(1).optional(),
});

/**
 * A verdict carries its own proof: `confirmed` and `refuted` must cite
 * evidence, `unverifiable` must say why. Requiring evidence of all three is
 * what pushed models to invent a `file:line` for claims they could not check.
 */
const Verdict = z.discriminatedUnion("verdict", [
  z.object({
    id: Id,
    verdict: z.literal("confirmed"),
    evidence: Evidence,
    note: z.string().optional(),
  }),
  z.object({
    id: Id,
    verdict: z.literal("refuted"),
    evidence: Evidence,
    note: z.string().optional(),
  }),
  z.object({
    id: Id,
    verdict: z.literal("unverifiable"),
    note: z.string().min(1),
    /** An optional check the orchestrator may run. Never executed by a model. */
    proposes: CheckProposal.optional(),
  }),
]);

export const Review = z.object({
  verdicts: z.array(Verdict),
  tradeoffs: z.array(
    z.object({
      id: Id,
      per_option: z.array(
        z.object({ option: z.string().min(1), against: z.array(z.string()) }),
      ),
    }),
  ),
  extra_findings: z.array(
    z.object({
      id: Id,
      text: z.string().min(1),
      kind: z.enum(["verifiable", "judgment"]),
      evidence: Evidence.optional(),
      note: z.string().optional(),
    }),
  ),
});

export const Changelog = z.object({
  changes: z.array(
    z.object({
      item: Id,
      disposition: z.enum(["fixed", "rebutted", "applied", "no-op", "dismissed"]),
      summary: z.string().min(1),
      evidence: z.string().optional(),
    }),
  ),
});

export const Gate = z.object({
  decisions: z.array(z.object({ id: Id, choice: z.string().min(1) })),
  findings: z.array(
    z.object({
      id: Id,
      disposition: z.enum(["accepted", "dismissed", "untriaged"]),
    }),
  ),
});

/* ------------------------------------------------------------------ *
 * Audit — what was actually executed, and why it is evidence.
 *
 * One record per proposed check, including checks that were never run: an
 * absent record would be indistinguishable from a check nobody proposed.
 * ------------------------------------------------------------------ */

export const AuditRecord = z.object({
  /** `A1`, `A2`… assigned by the orchestrator, never by a model. */
  id: z.string().regex(/^A\d+$/, "audit ids are assigned as A1, A2, …"),
  /** The claim this check is about. */
  claim: Id,
  proposedBy: z.string().min(1),
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1),
  tier: z.enum(["auto", "ask", "none"]),
  decision: z.enum(["auto-allowed", "human-approved", "human-rejected", "refused"]),
  decidedAt: z.string().min(1),
  status: z.enum(["ran", "timed-out", "spawn-error", "not-run"]),
  exitCode: z.number().int().optional(),
  signal: z.string().optional(),
  startedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  totalBytes: z.number().int().nonnegative(),
  /** sha256 of the full output, so a capped record still identifies it. */
  sha256: z.string(),
  tree: z.object({ head: z.string().nullable(), dirty: z.boolean() }),
  /** Names only. Never values: the environment holds credentials. */
  env: z.array(z.string()),
  planVersion: z.number().int().positive(),
  planSha256: z.string(),
  outcome: z.enum(["matched", "mismatched", "not-run"]),
});

export const Audit = z.object({ records: z.array(AuditRecord) });

export const ModelRef = z.object({
  /** `provider/model#variant`, as accepted by opencode. */
  ref: z.string(),
  /** Explicit family; a gateway puts every model under one provider. */
  family: z.string(),
});

export const CouncilModels = z.object({
  drafter: ModelRef,
  reviewer: ModelRef,
  /** Optional third take. Null/absent means a two-model run. */
  peer: ModelRef.nullable().optional(),
});

export const RunState = z.object({
  state: z.enum([
    "created",
    "taking",
    "synthesizing",
    "drafted",
    "reviewed",
    "validated",
    "gated",
    "rebutted",
    "done",
    "failed",
  ]),
  createdAt: z.string(),
  task: z.string(),
  mode: z.enum(["plan", "answer"]),
  models: CouncilModels,
  /**
   * The run this one continues, when it continues one: the parent's run name
   * (its timestamp directory name) and its directory. Optional so every run
   * recorded before chaining still parses. Informational only — the composed
   * task carries the parent's text, so a chain reads whole without this.
   */
  parent: z.object({ name: z.string(), dir: z.string() }).optional(),
  /**
   * URLs repaired deterministically before the review saw the plan. Recorded so
   * the artifact is not silently different from what the model wrote.
   */
  urlRepairs: z.array(z.object({ before: z.string(), after: z.string() })).optional(),
  /**
   * Why the run stopped, when it stopped by failing. Without this a dead run
   * and a parked one look identical unless you notice the missing artifacts.
   */
  error: z.string().optional(),
});

/* Envelopes: what an agent must return from one call. */

export const DraftEnvelope = z.object({ plan: z.string().min(1), claims: Claims });
export const RebutEnvelope = z.object({ plan: z.string().min(1), changelog: Changelog });

export type Claims = z.infer<typeof Claims>;
export type Review = z.infer<typeof Review>;
export type Changelog = z.infer<typeof Changelog>;
export type Gate = z.infer<typeof Gate>;
export type CouncilModels = z.infer<typeof CouncilModels>;
export type RunState = z.infer<typeof RunState>;
export type AuditRecord = z.infer<typeof AuditRecord>;
export type Audit = z.infer<typeof Audit>;
export type CheckProposal = z.infer<typeof CheckProposal>;
export type DraftEnvelope = z.infer<typeof DraftEnvelope>;
export type RebutEnvelope = z.infer<typeof RebutEnvelope>;

/* ------------------------------------------------------------------ *
 * Council — parallel takes plus one synthesis.
 *
 * Each model answers the same prompt independently (take.1.md, take.2.md,
 * optional take.3.md); the lead then synthesises the final answer. No claims,
 * no verdicts, no gate: the synthesis carries a short "what we learned" note.
 * ------------------------------------------------------------------ */

/** One independent take, as written to take.N.md. */
export interface CouncilTake {
  /** 1-based: take 1 is the lead's own initial answer. */
  index: number;
  model: { ref: string; family: string };
  text: string;
}

/** The synthesised final answer plus the note on what the peers contributed. */
export interface CouncilResult {
  final: string;
  learned: string;
}
