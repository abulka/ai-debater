import type { Claims, Review, Changelog } from "./contracts.ts";

export interface ModelRef {
  /** `provider/model#variant`, as accepted by opencode. */
  ref: string;
  /** Explicit family, e.g. "anthropic" or "openai".
   *  Not derived from the provider: a gateway puts every model under one provider. */
  family: string;
}

/** The council: lead (take 1 + synthesis), peer 1 (take 2), optional peer 2 (take 3). */
export interface CouncilModels {
  drafter: ModelRef;
  reviewer: ModelRef;
  peer?: ModelRef | null;
}

/** Legacy alias: the pipeline, CLI and TUI name the two required roles drafter/reviewer. */
export type Models = CouncilModels;

/** `plan` works on a repository; `answer` is a general question. */
export type Mode = "plan" | "answer";

export interface DraftInput {
  mode: Mode;
  task: string;
  criteria: string;
  decisions: string;
}

export interface ReviewInput {
  mode: Mode;
  task: string;
  criteria: string;
  plan: string;
  claims: Claims;
}

export interface RebutInput {
  mode: Mode;
  task: string;
  plan: string;
  claims: Claims;
  /** Refuted claims — the only verifiable items the rebuttal may touch. */
  refuted: { id: string; text: string; evidence: string }[];
  /** Findings the human accepted at the gate. */
  accepted: { id: string; text: string; evidence: string }[];
  /** Human decisions — settled; the plan must be made to reflect them. */
  decisions: { id: string; text: string; choice: string }[];
}

export interface TakeInput {
  mode: Mode;
  task: string;
  criteria: string;
  decisions: string;
}

export interface SynthesizeInput {
  mode: Mode;
  task: string;
  criteria: string;
  takes: { model: ModelRef; text: string }[];
}

export interface Runner {
  readonly models: { drafter: ModelRef; reviewer: ModelRef };
  draft(input: DraftInput): Promise<{ plan: string; claims: Claims }>;
  review(input: ReviewInput): Promise<Review>;
  rebut(input: RebutInput): Promise<{ plan: string; changelog: Changelog }>;
  /** One independent take from an explicit model — run these via Promise.all. */
  take(model: ModelRef, input: TakeInput): Promise<{ text: string }>;
  synthesize(input: SynthesizeInput): Promise<{ final: string; learned: string }>;
}
