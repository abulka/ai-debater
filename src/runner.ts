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
  /** One independent take from an explicit model — run these via Promise.all. */
  take(model: ModelRef, input: TakeInput): Promise<{ text: string }>;
  synthesize(input: SynthesizeInput): Promise<{ final: string; learned: string }>;
}
