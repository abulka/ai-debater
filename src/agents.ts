/**
 * The three agent definitions adv uses, as data.
 *
 * They are **injected** into each `opencode run` through
 * `OPENCODE_CONFIG_CONTENT` (see `OpencodeRunRunner`), not written to disk.
 * That matters for three reasons:
 *
 *   - No setup command. File-based agents have to be installed before the first
 *     run, into the target repo or the global config dir, or `opencode` fails
 *     with `Agent not found`. Injection removes the failure and the step.
 *   - No writes into the human's directories — not the target repo, not
 *     `~/.config/opencode`.
 *   - It merges with the user's own configuration rather than replacing it, so
 *     their providers, MCP servers and credentials still apply.
 *
 * `OPENCODE_CONFIG_CONTENT` is only read when `opencode` starts its own server,
 * which is why the runner always passes `--standalone`.
 *
 * There is deliberately no `model` field: the runner passes `--model` per call,
 * and a pinned default here once pointed the reviewer at a model that trains on
 * request data.
 */

/** `effect` is ordered-list matched, last rule wins. */
export interface Permission {
  action: string;
  resource: string;
  effect: "allow" | "ask" | "deny";
}

export interface AgentDefinition {
  description: string;
  /** Primary: adv selects one per call with `--agent`. */
  mode: "primary";
  /** Keep out of the agent list of the user's ordinary sessions. */
  hidden: boolean;
  system: string;
  permissions: Permission[];
}

const DENY_ALL: Permission = { action: "*", resource: "*", effect: "deny" };

/**
 * Read-only inspection of the repo. Deny-by-default is load-bearing: OpenCode's
 * base policy is `allow *`, so denying only `edit`/`shell` leaves every other
 * tool — MCP servers included — reachable. In M0 the reviewer, blocked from
 * writing a file, routed around it with the Playwright MCP tools and opened a
 * browser to download the file instead. See spike/README.md.
 */
const READ_ONLY: Permission[] = [
  DENY_ALL,
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  // History and diffs only: v1 plans, it does not execute project code.
  { action: "shell", resource: "git log *", effect: "allow" },
  { action: "shell", resource: "git show *", effect: "allow" },
  { action: "shell", resource: "git diff *", effect: "allow" },
  { action: "shell", resource: "git status *", effect: "allow" },
  { action: "shell", resource: "git grep *", effect: "allow" },
  { action: "shell", resource: "git ls-files *", effect: "allow" },
  { action: "shell", resource: "git branch *", effect: "allow" },
  // Answer mode cites URLs, so a source has to be checkable.
  { action: "webfetch", resource: "*", effect: "allow" },
  { action: "websearch", resource: "*", effect: "allow" },
];

const drafter: AgentDefinition = {
  description:
    "Drafts plans and answers, and sorts every statement into verifiable claims and judgment calls. Read-only. Used by the adv tool.",
  mode: "primary",
  hidden: true,
  system: `You draft plans and answers. You never write or modify code.

Hard rules:

- Every statement you make about a codebase must come from a file you actually
  read, or a git command you actually ran. Every factual assertion must be
  checkable, and you must not invent a source. If you have not checked it, say so
  rather than asserting it.
- Never choose between options for a judgment call. List the options and stop.
- The human's criteria are fixed. Do not invent criteria.
- Settled decisions are closed. Do not reopen them.
- When the task asks for a plan, the deliverable is the plan text, not edits.
- You may read files, run read-only \`git\` commands, and fetch web pages. You
  cannot write, and you cannot run anything else. If you are blocked, report the
  limitation — do not look for another route.

Your reply must end with exactly one fenced \`json\` block containing your
verifiable claims and judgment calls, as instructed in the prompt.`,
  permissions: READ_ONLY,
};

const reviewer: AgentDefinition = {
  description:
    "Adversarially verifies a plan or answer and lists trade-offs. Read-only, never rewrites. Used by the adv tool.",
  mode: "primary",
  hidden: true,
  system: `You are an adversarial reviewer. Your job is to verify, not to improve.

Hard rules:

- Never propose an alternative answer, and never rewrite the one you were given.
- Every verdict is exactly one of \`confirmed\`, \`refuted\`, or \`unverifiable\`.
- \`confirmed\` and \`refuted\` need evidence: a URL, or a \`path:line\` you actually
  read. \`unverifiable\` needs a short note saying why, and no evidence.
- You cannot run commands, so you can never cite command output. If a claim could
  be settled by running one command, mark it \`unverifiable\` and *propose* the
  check in the structured field the prompt describes. The tool may run it and
  report the result; you will not see the output. A claim that needs a test run
  to settle is never a guess.
- Use websearch and webfetch to check factual claims. Never confirm a claim you
  have not checked.
- Never guess. \`unverifiable\` is a correct and useful answer.
- For judgment calls, list trade-offs against the stated criteria. Never
  recommend one option, and never resolve the call.
- Flag problems the author did not list as separate findings.
- You may read files and run read-only \`git\` commands. If you cannot check
  something, say so. Do not route around a restriction with another tool; that
  is itself a finding worth reporting.

Your reply must be exactly one fenced \`json\` block, as instructed in the prompt.`,
  permissions: READ_ONLY,
};

const writer: AgentDefinition = {
  description:
    "Transforms text into JSON. No tools at all. Used by the adv tool for the claims and changelog steps.",
  mode: "primary",
  hidden: true,
  system: `You transform text into JSON. You have no tools: you cannot read files, run
commands, or search anything. Everything you need is in the prompt.

Reply with exactly one fenced \`json\` block containing the requested structure,
and nothing before or after it.`,
  // Nothing at all. These steps take text in and put JSON out; a model that
  // reaches for a tool here is hallucinating one (gpt-oss called a "search" tool
  // that does not exist, and the provider rejected the request).
  permissions: [DENY_ALL],
};

/** Keyed by the agent id the runner passes to `--agent`. */
export const AGENTS: Record<string, AgentDefinition> = {
  "adv-drafter": drafter,
  "adv-reviewer": reviewer,
  "adv-writer": writer,
};

/**
 * The config fragment adv injects. Merged over the user's own
 * `OPENCODE_CONFIG_CONTENT` if they have one set, so neither is lost.
 */
export function agentsConfigJson(): string {
  const mine = { agents: AGENTS };
  const theirs = process.env["OPENCODE_CONFIG_CONTENT"];
  if (!theirs) return JSON.stringify(mine);
  try {
    const parsed: unknown = JSON.parse(theirs);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return JSON.stringify(mine);
    }
    // Ours wins on a name collision: these are adv's own agents, and a
    // same-named one in the user's config would shadow the read-only posture.
    return JSON.stringify({ ...(parsed as object), agents: { ...readAgents(parsed), ...mine.agents } });
  } catch {
    // Their value is not JSON; opencode would choke on it anyway. Ours wins.
    return JSON.stringify(mine);
  }
}

function readAgents(config: unknown): Record<string, unknown> {
  const agents = (config as { agents?: unknown }).agents;
  return agents && typeof agents === "object" && !Array.isArray(agents)
    ? (agents as Record<string, unknown>)
    : {};
}
