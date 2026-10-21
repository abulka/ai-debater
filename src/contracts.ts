import { z } from "zod";

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

export type CouncilModels = z.infer<typeof CouncilModels>;
export type RunState = z.infer<typeof RunState>;

/* ------------------------------------------------------------------ *
 * Council — parallel takes plus one synthesis.
 *
 * Each model answers the same prompt independently (take.1.md, take.2.md,
 * optional take.3.md); the lead then synthesises the final answer. The synthesis
 * carries a short "what we learned" note.
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
