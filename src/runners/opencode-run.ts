import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentsConfigJson } from "../agents.ts";
import {
  splitLearned,
  synthesizePrompt,
  takePrompt,
  toolRetryPrompt,
} from "../prompts.ts";
import type {
  Mode,
  ModelRef,
  Runner,
  SynthesizeInput,
  TakeInput,
} from "../runner.ts";

export interface OpencodeRunOptions {
  /** Working directory the agents run in — the target repo. */
  repo: string;
  drafter: ModelRef;
  reviewer: ModelRef;
  peer?: ModelRef | null;
  /** Agent ids adv injects. */
  agents?: {
    council: string;
    councilAnswer: string;
  };
  timeoutMs?: number;
  /**
   * Pass --auto so a headless run never blocks on an `ask`. Explicit `deny`
   * rules still hold, and the adv agents deny everything but read-only tools.
   */
  auto?: boolean;
  /** Called after each model call. */
  onCall?: CallHook;
  /**
   * Run under a private server so the session's location is `repo`. The shared
   * background service owns the location and its cwd is unrelated to the target
   * repo. Defaults to true.
   */
  standalone?: boolean;
}

/** One line of `opencode run --format json` output. */
export interface RunEvent {
  type?: string;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    messageID?: string;
    state?: { status?: string; input?: Record<string, unknown> };
    cost?: number;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
}

export interface Usage {
  steps: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /**
   * Whether the provider reported a cost at all. A gateway that does not
   * (openrouter) leaves this false, and the run must then say "not reported"
   * rather than displaying $0 — a paid run must not read as a free one.
   */
  costKnown: boolean;
}

export interface CallResult {
  text: string;
  sessionID: string | undefined;
  events: RunEvent[];
  usage: Usage;
  ms: number;
}

/** One model call: which model, which agent, what to say. */
export interface CallRequest {
  model: string;
  agent: string;
  message: string;
  sessionID?: string;
  /** Working directory for this call. Answer mode uses a neutral one. */
  cwd?: string;
}

/** Fired after every model call, for progress and cost reporting. */
export type CallHook = (info: {
  kind: "take" | "synthesis";
  step: string;
  retry: boolean;
  model: string;
  ms: number;
  usage: Usage;
  events: RunEvent[];
}) => void;

export class OpencodeRunRunner implements Runner {
  readonly models: { drafter: ModelRef; reviewer: ModelRef; peer?: ModelRef | null };
  /** Set when the two models share a family. Informational. */
  readonly familyWarning: string | null;

  private readonly repo: string;
  private readonly agents: {
    council: string;
    councilAnswer: string;
  };
  private readonly timeoutMs: number;
  private readonly auto: boolean;
  private readonly standalone: boolean;
  private readonly onCall: CallHook | undefined;
  /**
   * A neutral working directory for answer mode: a general question must not see
   * the repository it was launched from, because OpenCode loads AGENTS.md from the
   * working directory as project instructions even with no file tools.
   */
  private readonly answerDir: string;

  constructor(o: OpencodeRunOptions) {
    // A warning, not a failure: same-family models reduce diversity but are not
    // wrong, and refusing to run would be worse than saying so.
    this.familyWarning =
      o.drafter.family === o.reviewer.family
        ? `drafter and reviewer share family "${o.drafter.family}" — the second take adds less than a cross-family one would`
        : null;
    this.repo = o.repo;
    this.agents = o.agents ?? {
      council: "adv-council",
      councilAnswer: "adv-council-answer",
    };
    this.answerDir = path.join(os.tmpdir(), "adv-answer");
    mkdirSync(this.answerDir, { recursive: true });
    this.timeoutMs = o.timeoutMs ?? 180_000;
    this.auto = o.auto ?? true;
    this.standalone = o.standalone ?? true;
    this.onCall = o.onCall;
    this.models = o.peer ? { drafter: o.drafter, reviewer: o.reviewer, peer: o.peer } : { drafter: o.drafter, reviewer: o.reviewer };
  }

  /** A general question gets a neutral cwd: no repo, no project AGENTS.md. */
  private cwdFor(mode: Mode): string {
    return mode === "answer" ? this.answerDir : this.repo;
  }

  private councilAgent(mode: Mode): string {
    return mode === "answer" ? this.agents.councilAnswer : this.agents.council;
  }

  /* Council: one independent take per model, then one synthesis by the lead. */
  async take(model: ModelRef, input: TakeInput): Promise<{ text: string }> {
    const agent = this.councilAgent(input.mode);
    const cwd = this.cwdFor(input.mode);
    const call = await this.request({ model: model.ref, agent, message: takePrompt(input), cwd });
    this.report("take", "take", model.ref, call.call, call.retried);
    const text = call.call.text.trim();
    if (!text) throw new Error(`model ${model.ref} returned an empty take`);
    return { text };
  }

  /** Synthesis with the full peer context. */
  async synthesize(input: SynthesizeInput): Promise<{ final: string; learned: string }> {
    const model = this.models.drafter.ref;
    const agent = this.councilAgent(input.mode);
    const cwd = this.cwdFor(input.mode);
    const call = await this.request({
      model,
      agent,
      message: synthesizePrompt({
        mode: input.mode,
        task: input.task,
        takes: input.takes.map((t) => ({ model: t.model.ref, text: t.text })),
      }),
      cwd,
    });
    this.report("synthesis", "synthesis", model, call.call, call.retried);
    const { final, learned } = splitLearned(call.call.text);
    if (!final) throw new Error("the synthesis returned an empty answer");
    return { final, learned };
  }

  /* ---------------------------------------------------------------- */

  /** Low-level call. */
  async call(opts: CallRequest): Promise<CallResult> {
    const args = ["run", "--format", "json", "--model", opts.model, "--agent", opts.agent];
    if (this.standalone) args.push("--standalone");
    if (opts.sessionID) args.push("--session", opts.sessionID);
    if (this.auto) args.push("--auto");
    args.push(opts.message);

    const t0 = Date.now();
    const cwd = opts.cwd ?? this.repo;
    const proc = Bun.spawn(["opencode", ...args], {
      cwd,
      // Two things the child needs from us:
      //   PWD                     opencode resolves the project from $PWD, not
      //                           from the process cwd, and Bun.spawn({cwd})
      //                           does not update PWD. Without it the agents
      //                           resolve against the wrong project.
      //   OPENCODE_CONFIG_CONTENT the agent definitions, injected rather than
      //                           installed as files. Only read when opencode
      //                           starts its own server — hence --standalone.
      env: { ...process.env, PWD: cwd, OPENCODE_CONFIG_CONTENT: agentsConfigJson() },
      stdout: "pipe",
      stderr: "pipe",
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill();
    }, this.timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);

    if (killed) throw new Error(`opencode run timed out after ${this.timeoutMs}ms`);
    if (code !== 0) {
      const raw = (stderr || stdout).slice(-2000);
      // The agents come from OPENCODE_CONFIG_CONTENT, so this now means the
      // injected config did not reach the child at all.
      if (/Agent not found/i.test(raw)) {
        throw new Error(
          `opencode did not receive the "${opts.agent}" definition. adv injects it in ` +
            `OPENCODE_CONFIG_CONTENT, which opencode only reads when it starts its own ` +
            `server — so a run must use --standalone. Check that nothing stripped that ` +
            `variable from the environment.\n${raw}`,
        );
      }
      throw new Error(`opencode run exited ${code}\n${raw}`);
    }

    const events = parseNdjson(stdout);

    // A multi-step run emits text in more than one message; the answer is the
    // final message's text, not every text part in the stream.
    const textParts = events.filter((e) => e.part?.type === "text" && e.part.text);
    const lastMessageID = textParts.at(-1)?.part?.messageID;
    const text = textParts
      .filter((e) => lastMessageID === undefined || e.part?.messageID === lastMessageID)
      .map((e) => e.part?.text ?? "")
      .join("");

    const sessionID = events.find((e) => typeof e.sessionID === "string")?.sessionID;
    return { text, sessionID, events, usage: summarizeUsage(events), ms: Date.now() - t0 };
  }

  /**
   * A provider rejects a turn when the model calls a tool that was never
   * offered — gpt-oss invents a `search` tool that does not exist, and the
   * request comes back `tool_use_failed`. That is the model's mistake, not
   * ours, and it is stochastic, so one stateless retry with a nudge clears it.
   *
   * Retries are limited to the model's own rejected output and to explicitly
   * transient provider failures. Anything else propagates untouched.
   */
  private async request(opts: CallRequest): Promise<{ call: CallResult; retried: boolean }> {
    try {
      return { call: await this.call(opts), retried: false };
    } catch (err) {
      if (!retryable(err)) throw err;
      // Exactly one retry. Deliberately not recursive: a provider that keeps
      // rejecting must fail the run, not spin.
      const retry = await this.call({
        ...opts,
        message: `${opts.message}\n\n---\n\n${toolRetryPrompt()}`,
      });
      return { call: retry, retried: true };
    }
  }

  private report(
    kind: "take" | "synthesis",
    step: string,
    model: string,
    call: CallResult,
    retry = false,
  ) {
    this.onCall?.({
      kind,
      step,
      retry,
      model,
      ms: call.ms,
      usage: call.usage,
      events: call.events,
    });
  }

}

/* ------------------------------------------------------------------ */

/**
 * The provider rejected the model's own turn — it called a tool that was never
 * offered. gpt-oss does this with a `search` tool that does not exist, in every
 * agent, including the writer, which has no tools at all.
 */
const MODEL_TURN_REJECTED =
  /tool_use_failed|attempted to call tool|which was not in request\.tools|failed_generation/i;

/** Explicitly transient provider trouble. Anchored on words: the raw NDJSON in
 *  the message is full of digit runs, so bare status codes are not safe. */
const TRANSIENT = /rate.?limit|too many requests|overloaded|service unavailable|ECONNRESET|fetch failed/i;

/** Only the model's own rejected turn, or declared transient trouble. */
const retryable = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  return MODEL_TURN_REJECTED.test(message) || TRANSIENT.test(message);
};

export function parseNdjson(stdout: string): RunEvent[] {
  const events: RunEvent[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      events.push(JSON.parse(t) as RunEvent);
    } catch {
      /* non-JSON noise */
    }
  }
  return events;
}

/** Tokens and cost, summed over the run's steps. Reported by `step_finish`. */
export function summarizeUsage(events: RunEvent[]): Usage {
  const u: Usage = {
    steps: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
  for (const e of events) {
    if (e.part?.type !== "step-finish") continue;
    u.steps += 1;
    const t = e.part.tokens;
    u.input += t?.input ?? 0;
    u.output += t?.output ?? 0;
    u.reasoning += t?.reasoning ?? 0;
    u.cacheRead += t?.cache?.read ?? 0;
    u.cacheWrite += t?.cache?.write ?? 0;
    if (e.part.cost !== undefined) u.costKnown = true;
    u.cost += e.part.cost ?? 0;
  }
  return u;
}

export function formatUsage(u: Usage): string {
  const cost = u.costKnown ? `$${u.cost.toFixed(6)}` : "cost not reported";
  return (
    `${u.steps} step(s), in ${u.input} out ${u.output} reasoning ${u.reasoning} ` +
    `cache r${u.cacheRead}/w${u.cacheWrite}, ${cost}`
  );
}
