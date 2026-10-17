import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Evidence — v1 accepts `path:line` or a URL only.
 *
 * Nothing is executed in v1, so command output cannot be real evidence:
 * a reviewer citing it could only be inventing it. Claims that need a
 * command to settle must come back `unverifiable`.
 * ------------------------------------------------------------------ */

const URL_RE = /^https?:\/\/\S+$/;
const FILE_LINE_RE = /^[^\s:]+:\d+(?:-\d+)?$/;

export const EVIDENCE_RULE =
  "evidence must be `path:line` (e.g. src/http.ts:88) or a URL; command output is not accepted in v1";

export const Evidence = z
  .string()
  .refine((v) => URL_RE.test(v) || FILE_LINE_RE.test(v), { message: EVIDENCE_RULE });

/** Claim ids: V1.. verifiable, J1.. judgment, E1.. extra findings. */
const Id = z.string().regex(/^[VJE]\d+$/, "id must look like V1, J2, or E3");

export const Claims = z.object({
  verifiable: z.array(z.object({ id: Id, text: z.string().min(1) })),
  judgment: z.array(
    z.object({
      id: Id,
      text: z.string().min(1),
      options: z.array(z.string().min(1)).min(1),
    }),
  ),
});

export const Review = z.object({
  verdicts: z.array(
    z.object({
      id: Id,
      verdict: z.enum(["confirmed", "refuted", "unverifiable"]),
      evidence: Evidence,
    }),
  ),
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
      evidence: Evidence,
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
  findings: z.array(z.object({ id: Id, disposition: z.enum(["accepted", "dismissed"]) })),
});

export const ModelRef = z.object({
  /** `provider/model#variant`, as accepted by opencode. */
  ref: z.string(),
  /** Explicit family; a gateway puts every model under one provider. */
  family: z.string(),
});

export const RunState = z.object({
  state: z.enum([
    "created",
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
  models: z.object({ drafter: ModelRef, reviewer: ModelRef }),
});

/* Envelopes: what an agent must return from one call. */

export const DraftEnvelope = z.object({ plan: z.string().min(1), claims: Claims });
export const RebutEnvelope = z.object({ plan: z.string().min(1), changelog: Changelog });

export type Claims = z.infer<typeof Claims>;
export type Review = z.infer<typeof Review>;
export type Changelog = z.infer<typeof Changelog>;
export type Gate = z.infer<typeof Gate>;
export type RunState = z.infer<typeof RunState>;
export type DraftEnvelope = z.infer<typeof DraftEnvelope>;
export type RebutEnvelope = z.infer<typeof RebutEnvelope>;
