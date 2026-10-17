import { z } from "zod";
import { agentsConfigJson } from "../agents.ts";
import {
  Changelog as ChangelogSchema,
  Claims as ClaimsSchema,
  type Claims,
  type Changelog,
  Review as ReviewSchema,
  type Review,
} from "../contracts.ts";
import {
  changelogPrompt,
  claimsPrompt,
  draftPrompt,
  rebutPrompt,
  retryPrompt,
  reviewPrompt,
  toolRetryPrompt,
} from "../prompts.ts";
import type { DraftInput, ModelRef, RebutInput, ReviewInput, Runner } from "../runner.ts";

export interface OpencodeRunOptions {
  /** Working directory the agents run in — the target repo. */
  repo: string;
  drafter: ModelRef;
  reviewer: ModelRef;
  /** Agent ids under .opencode/agents/. */
  agents?: { drafter: string; reviewer: string; writer: string };
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
}

/** Fired after every model call, for progress and cost reporting. */
export type CallHook = (info: {
  kind: "draft" | "review" | "rebut";
  step: string;
  retry: boolean;
  model: string;
  ms: number;
  usage: Usage;
  events: RunEvent[];
}) => void;

export class OpencodeRunRunner implements Runner {
  readonly models: { drafter: ModelRef; reviewer: ModelRef };
  /** Set when the two models share a family. Informational. */
  readonly familyWarning: string | null;

  private readonly repo: string;
  private readonly agents: { drafter: string; reviewer: string; writer: string };
  private readonly timeoutMs: number;
  private readonly auto: boolean;
  private readonly standalone: boolean;
  private readonly onCall: CallHook | undefined;

  constructor(o: OpencodeRunOptions) {
    // A warning, not a failure: same-family models reduce diversity but are not
    // wrong, and refusing to run would be worse than saying so.
    this.familyWarning =
      o.drafter.family === o.reviewer.family
        ? `drafter and reviewer share family "${o.drafter.family}" — the review adds less than it could`
        : null;
    this.repo = o.repo;
    this.agents = o.agents ?? {
      drafter: "adv-drafter",
      reviewer: "adv-reviewer",
      writer: "adv-writer",
    };
    this.timeoutMs = o.timeoutMs ?? 180_000;
    this.auto = o.auto ?? true;
    this.standalone = o.standalone ?? true;
    this.onCall = o.onCall;
    this.models = { drafter: o.drafter, reviewer: o.reviewer };
  }

  /* Two calls, one deliverable each: a plan, then its claims. Asking for both
   * in one reply is where drafters get flaky. */
  async draft(input: DraftInput): Promise<{ plan: string; claims: Claims }> {
    const model = this.models.drafter.ref;
    const agent = this.agents.drafter;

    const planCall = await this.request({ model, agent, message: draftPrompt(input) });
    this.report("draft", "plan", model, planCall.call, planCall.retried);
    const plan = splitPlanAndJson(planCall.call.text).plan.trim();
    if (!plan) throw new Error("the drafter returned an empty plan");

    const { value: claims } = await this.validated({
      model,
      agent: this.agents.writer,
      kind: "draft",
      step: "claims",
      prompt: claimsPrompt({ mode: input.mode, body: plan }),
      schema: ClaimsSchema,
      extract: extractJson,
    });
    return { plan, claims };
  }

  async review(input: ReviewInput): Promise<Review> {
    const { value } = await this.validated({
      model: this.models.reviewer.ref,
      agent: this.agents.reviewer,
      kind: "review",
      step: "review",
      prompt: reviewPrompt(input),
      schema: ReviewSchema,
      extract: extractJson,
    });
    return value;
  }

  /* Same split: the revised plan, then the changelog describing it. */
  async rebut(input: RebutInput): Promise<{ plan: string; changelog: Changelog }> {
    const model = this.models.drafter.ref;
    const agent = this.agents.drafter;

    const planCall = await this.request({ model, agent, message: rebutPrompt(input) });
    this.report("rebut", "plan", model, planCall.call, planCall.retried);
    const plan = splitPlanAndJson(planCall.call.text).plan.trim();
    if (!plan) throw new Error("the rebuttal returned an empty plan");

    const items = [
      ...input.refuted.map((r) => ({ id: r.id, note: `refuted claim: ${r.text}` })),
      ...input.accepted.map((a) => ({ id: a.id, note: `accepted finding: ${a.text}` })),
      ...input.decisions.map((d) => ({ id: d.id, note: `human decision: ${d.choice}` })),
    ];
    if (items.length === 0) return { plan, changelog: { changes: [] } };

    const { value: changelog } = await this.validated({
      model,
      agent: this.agents.writer,
      kind: "rebut",
      step: "changelog",
      prompt: changelogPrompt({ before: input.plan, after: plan, items }),
      schema: ChangelogSchema,
      extract: extractJson,
    });
    return { plan, changelog };
  }

  /* ---------------------------------------------------------------- */

  /** Low-level call, exposed for the spike. Prefer draft/review/rebut. */
  async call(opts: CallRequest): Promise<CallResult> {
    const args = ["run", "--format", "json", "--model", opts.model, "--agent", opts.agent];
    if (this.standalone) args.push("--standalone");
    if (opts.sessionID) args.push("--session", opts.sessionID);
    if (this.auto) args.push("--auto");
    args.push(opts.message);

    const t0 = Date.now();
    const proc = Bun.spawn(["opencode", ...args], {
      cwd: this.repo,
      // Two things the child needs from us:
      //   PWD                     opencode resolves the project from $PWD, not
      //                           from the process cwd, and Bun.spawn({cwd})
      //                           does not update PWD. Without it the agents
      //                           resolve against the wrong project.
      //   OPENCODE_CONFIG_CONTENT the agent definitions, injected rather than
      //                           installed as files. Only read when opencode
      //                           starts its own server — hence --standalone.
      env: { ...process.env, PWD: this.repo, OPENCODE_CONFIG_CONTENT: agentsConfigJson() },
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
   * Same shape and same reason as the schema retry below: a run should not die
   * because a model had one bad turn.
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
    kind: "draft" | "review" | "rebut",
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

  /** One JSON reply, one schema, one stateless retry. */
  private async validated<T>(params: {
    model: string;
    agent: string;
    kind: "draft" | "review" | "rebut";
    step: string;
    prompt: string;
    schema: z.ZodType<T>;
    extract: (text: string) => unknown;
  }): Promise<{ value: T }> {
    const attempt = (text: string): { ok: true; value: T } | { ok: false; error: string } => {
      try {
        return { ok: true, value: params.schema.parse(params.extract(text)) };
      } catch (err) {
        return { ok: false, error: formatError(err) };
      }
    };

    const first = await this.request({ model: params.model, agent: params.agent, message: params.prompt });
    this.report(params.kind, params.step, params.model, first.call, first.retried);
    const one = attempt(first.call.text);
    if (one.ok) return { value: one.value };

    // Stateless retry: re-send the original prompt. Each --standalone run has
    // its own session store, so --session would resume nothing.
    const retry = await this.request({
      model: params.model,
      agent: params.agent,
      message: `${params.prompt}\n\n---\n\n${retryPrompt(one.error)}`,
    });
    this.report(params.kind, params.step, params.model, retry.call, true);
    const two = attempt(retry.call.text);
    if (two.ok) return { value: two.value };

    throw new Error(
      `validation failed twice.\n${two.error}\n--- raw reply ---\n${retry.call.text.slice(-4000)}`,
    );
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

const extractJson = (text: string): unknown => {
  const { json } = splitPlanAndJson(text);
  if (json === null) throw new Error("no fenced ```json block found in the reply");
  return JSON.parse(json);
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
    u.cost += e.part.cost ?? 0;
  }
  return u;
}

export function formatUsage(u: Usage): string {
  return (
    `${u.steps} step(s), in ${u.input} out ${u.output} reasoning ${u.reasoning} ` +
    `cache r${u.cacheRead}/w${u.cacheWrite}, $${u.cost.toFixed(6)}`
  );
}

/** Split a reply into prose and the last fenced block that parses as JSON. */
export function splitPlanAndJson(text: string): { plan: string; json: string | null } {
  const re = /```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/g;
  let last: { json: string; start: number } | null = null;
  for (const m of text.matchAll(re)) {
    const body = m[1] ?? "";
    try {
      JSON.parse(body);
      last = { json: body, start: m.index ?? 0 };
    } catch {
      /* not the block we want */
    }
  }
  if (!last) return { plan: text.trim(), json: null };
  return { plan: text.slice(0, last.start).trim(), json: last.json };
}

function formatError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("\n");
  }
  return err instanceof Error ? err.message : String(err);
}
