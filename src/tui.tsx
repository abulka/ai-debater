import { Box, Static, Text, render, useApp, useInput } from "ink";
import path from "node:path";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { loadConfig, saveConfig } from "./config.ts";
import type { Config } from "./config.ts";
import type { AuditRecord, Claims, Gate, Review } from "./contracts.ts";
import { auditSpans, type ApprovalRequest } from "./audit.ts";
import { advState, initRepo } from "./init.ts";
import {
  answersToGate,
  buildItems,
  clampOffset,
  decisionEntries,
  describeGateChange,
  gateWarnings,
  maxOffset,
  parseEvidence,
  readEvidenceContext,
  selectionForCurrent,
  statusSpans,
  verdictCounts,
  type GateAnswer,
  type GateItem,
} from "./gate-model.ts";
import { familyClash, familyOf, listModels } from "./models.ts";
import {
  appendDecisions,
  displayPath,
  listRuns,
  loadState,
  NO_CRITERIA,
  readCriteria,
  readDecisions,
  rotateGate,
  runPaths,
  saveState,
  type RunSummary,
} from "./orchestrator.ts";
import {
  headFromArtifacts,
  loadArtifacts,
  loadTail,
  runHead,
  runTail,
  saveGate,
  type Head,
  type Models,
  type Reporting,
  type Tail,
} from "./pipeline.ts";
import { diffPane, renderAnswer, renderResult, renderResultLines } from "./render.ts";
import {
  fitSpans,
  renderMarkdownLines,
  spans,
  wrapWidth,
  type Span,
  type StyledLine,
} from "./markdown.ts";
import { THEME } from "./theme.ts";
import { copyMarkdown, copyNotice } from "./clipboard.ts";
import type { Mode } from "./runner.ts";

type Phase =
  | "setup"
  | "start"
  | "clarify"
  | "settings"
  | "pick"
  | "runs"
  | "running"
  | "gate"
  | "working"
  | "result"
  | "error";

type Panel = { title: string; lines: StyledLine[] };

/**
 * Every key the result screen answers to.
 *
 * A list, not a paragraph in the footer: the footer has room for four or five
 * of them, and the ones a reader needs once — the draft the review saw, the
 * claims as recorded — are exactly the ones that would not fit. `?` shows this,
 * and it is the same list the key handler is written against, so a new key that
 * is not here is a key nobody can find.
 */
const RESULT_KEYS: { key: string; what: string }[] = [
  { key: "y", what: "copy the answer as Markdown (also answer.md in the run directory)" },
  { key: "Y", what: "copy the whole result as Markdown, commentary included (also result.md)" },
  { key: "x", what: "the exact text diff, and what each change was for (Esc back)" },
  { key: "d", what: "the draft the review saw, before the gate" },
  { key: "v", what: "every verdict, with its evidence" },
  { key: "i", what: "the review at a glance — warnings, checks, refuted claims" },
  { key: "c", what: "the claims the drafter declared" },
  { key: "R", what: "the reviewer's raw reply, exactly as it was written" },
  { key: "l", what: "the full run log" },
  { key: "r", what: "revisit the gate — re-ask it with the recorded answers prefilled" },
  { key: "n", what: "back to your question — the draft you had typed is kept" },
  { key: "g / G", what: "jump to the top / the end" },
  { key: "↑↓ · space", what: "scroll" },
  { key: "q", what: "quit (the run stays on disk — reopen it with Ctrl+R on the start screen)" },
];

/**
 * A span's styles as Ink props.
 *
 * The renderer's vocabulary is deliberately small and named after Markdown;
 * this is the one place that knows what the terminal library calls those
 * things. `strike` is `strikethrough` here, `dim` is `dimColor`.
 */
const inkStyle = (span: Span) => ({
  ...(span.bold ? { bold: true } : {}),
  ...(span.dim ? { dimColor: true } : {}),
  ...(span.italic ? { italic: true } : {}),
  ...(span.underline ? { underline: true } : {}),
  ...(span.strike ? { strikethrough: true } : {}),
  ...(span.color ? { color: span.color } : {}),
});

/**
 * One line of styled spans: nested `Text` composes the styles.
 *
 * A blank line needs a space in it. An empty `<Text>` renders as no row at all,
 * so a paragraph break would silently disappear and the pane would draw fewer
 * rows than it counted — which is exactly the scroll bug the pre-wrapping
 * exists to prevent.
 */
function Line({ spans }: { spans: StyledLine }) {
  return (
    <Text>
      {spans.length === 0
        ? " "
        : spans.map((span, i) => (
            <Text key={i} {...inkStyle(span)}>
              {span.text}
            </Text>
          ))}
    </Text>
  );
}

/**
 * The top line: the tool's name, and which screen you are on.
 *
 * Both take the accent, because "where am I" is the thing a reader needs
 * without reading: at a glance, the gate and the result should not look alike.
 */
function Header({ right }: { right: string }) {
  return (
    <Box>
      <Text bold color={THEME.accent}>
        adv
      </Text>
      <Text color={THEME.accent}>  {right}</Text>
    </Box>
  );
}

/**
 * A footer of keys: the key itself takes the accent and its label recedes, so
 * the eye can find "which key" without reading "what it does".
 */
function hints(...pairs: [string, string][]): StyledLine {
  return pairs.flatMap(([key, what], i) =>
    i === 0
      ? [{ text: key, color: THEME.accent, bold: true }, { text: ` ${what}` }]
      : [
          { text: " · " },
          { text: key, color: THEME.accent, bold: true },
          { text: ` ${what}` },
        ],
  );
}

/** Terminal height for a scrollable pane, leaving room for the chrome. */
const paneHeight = (chrome: number) => Math.max(6, (process.stdout.rows ?? 24) - chrome);

/* ------------------------------------------------------------------ *
 * One scrollable pane, used by the panels and by the result view. The
 * arithmetic lives in gate-model.ts so "the list will not move" is one
 * bug, tested once, and not four copies of the same off-by-one.
 * ------------------------------------------------------------------ */

function Scroller({
  title,
  lines,
  footer,
  notice,
  escLabel = "Esc back",
  escCloses = true,
  onClose,
  onEsc,
  onKey,
}: {
  title: string;
  /** Pre-wrapped styled lines: one element is one row, so scrolling stays honest. */
  lines: StyledLine[];
  footer: StyledLine;
  /** A one-line answer to the last key, shown under the footer. */
  notice?: string | null;
  /**
   * What Esc does here, shown in the scroll hint. A panel says "Esc back"; the
   * result says "q quits" because Esc there is inert. A hint that names the
   * wrong key is worse than no hint.
   */
  escLabel?: string;
  /**
   * Whether Esc closes this screen. False on the result, the top level: `q`
   * quits and a stray Esc only shows a hint. Quitting the tool is not
   * something a mis-typed keystroke should do.
   */
  escCloses?: boolean;
  /** Called when Esc is pressed and `escCloses` is false. */
  onEsc?: () => void;
  onClose: () => void;
  onKey?: (input: string) => boolean;
}) {
  const height = paneHeight(7);
  const [offset, setOffset] = useState(0);

  useInput((input, key) => {
    // Ctrl/meta combos belong to the app (Ctrl+R past runs, Ctrl+C quit). A
    // letter's control twin must not also read as the plain key — Ctrl+R is not
    // "r" (revisit), Ctrl+Y is not "y" (copy).
    if (key.ctrl || key.meta) return;
    if (onKey?.(input)) return;
    if (key.escape) {
      if (escCloses) onClose();
      else onEsc?.();
      return;
    }
    if (input === "q") {
      onClose();
      return;
    }
    if (key.downArrow || input === "j") setOffset((o) => clampOffset(o + 1, lines.length, height));
    else if (key.upArrow || input === "k") setOffset((o) => clampOffset(o - 1, lines.length, height));
    else if (key.pageDown || input === " ") setOffset((o) => clampOffset(o + height, lines.length, height));
    else if (key.pageUp) setOffset((o) => clampOffset(o - height, lines.length, height));
    else if (input === "g") setOffset(0);
    else if (input === "G") setOffset(maxOffset(lines.length, height));
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right={title} />
      </Box>
      <Box flexDirection="column">
        {lines.slice(offset, offset + height).map((line, i) => (
          <Line key={i} spans={line} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {lines.length === 0 ? "empty" : `${offset + 1}–${Math.min(lines.length, offset + height)} of ${lines.length}`}
          {` · ↑↓ scroll · ${escLabel}`}
        </Text>
      </Box>
      <Box>
        <Line spans={footer} />
      </Box>
      {notice && (
        <Box>
          <Text color={THEME.ok}>{notice}</Text>
        </Box>
      )}
    </Box>
  );
}

/* ------------------------------------------------------------------ */

function Setup({
  repo,
  selection,
}: {
  repo: string;
  selection: number;
}) {
  const options = [
    { label: "Initialise .adv/ here", hint: "creates criteria, decisions and config" },
    {
      label: "Continue without it",
      hint: "no criteria — the reviewer has nothing to check trade-offs against",
    },
  ];

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right="first run" />
      </Box>
      <Box marginBottom={1}>
        <Text>
          No <Text bold>.adv/</Text> in <Text>{repo}</Text>
        </Text>
      </Box>
      <Text dimColor>
        .adv/ holds your criteria, settled decisions and model choice. Without it, a run still
        works but the reviewer has no criteria to check trade-offs against.
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((o, i) => (
          <Box key={o.label} flexDirection="column">
            <Box>
              <Text color={i === selection ? THEME.accent : undefined}>{i === selection ? "❯ " : "  "}</Text>
              <Text color={i === selection ? THEME.accent : undefined} bold={i === selection}>
                {o.label}
              </Text>
            </Box>
            <Text dimColor>
              {"    "}
              {o.hint}
            </Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ choose · Enter to confirm · Ctrl+C to quit</Text>
      </Box>
    </Box>
  );
}

/**
 * A cheap nudge, not a classifier. If someone types a question in plan mode,
 * the run will read the repository and answer with a plan; that happened once and
 * the result was a "Plan:" about fixtures/toy-repo. A question mark, or a question
 * opening word, is enough to suggest Tab.
 */
function looksLikeQuestion(task: string): boolean {
  const text = task.trim();
  if (!text) return false;
  if (/\?\s*$/.test(text)) return true;
  return /^(what|which|who|whom|whose|when|where|why|how|is|are|was|were|does|do|did|can|could|should|would)\b/i.test(
    text,
  );
}

function Start({
  repo,
  cfg,
  mode,
  task,
  setTask,
  onRun,
  onToggleMode,
  onSettings,
}: {
  repo: string;
  cfg: Config | null;
  mode: Mode;
  task: string;
  setTask: (v: string) => void;
  onRun: () => void;
  onToggleMode: () => void;
  onSettings: () => void;
}) {
  useInput((input, key) => {
    if (key.tab) {
      onToggleMode();
      return;
    }
    // Ctrl+P, not a letter: anything typeable must stay available for the task.
    if (key.ctrl && input === "p") {
      onSettings();
      return;
    }
    // Ctrl+U clears the draft, readline-style. The prompt outlives a trip to a
    // past run, so a deliberate wipe is what makes room for the next one.
    if (key.ctrl && input === "u") {
      setTask("");
      return;
    }
    if (key.return) {
      if (task.trim() && cfg) onRun();
      return;
    }
    if (key.backspace || key.delete) {
      setTask(task.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input) setTask(task + input);
  });

  const clash = cfg ? familyClash(cfg.models) : null;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right="adversarial two-model review" />
      </Box>
      <Box>
        <Text dimColor>repo    </Text>
        <Text>{repo}</Text>
      </Box>
      <Box>
        <Text dimColor>models  </Text>
        <Text>
          {cfg
            ? `${cfg.models.drafter.ref} [${cfg.models.drafter.family}]  ->  ${cfg.models.reviewer.ref} [${cfg.models.reviewer.family}]`
            : "loading…"}
        </Text>
      </Box>
      <Box>
        <Text dimColor>subject </Text>
        <Text color={THEME.accent}>{mode === "answer" ? "general question" : "this repository"}</Text>
        <Text dimColor>
          {"  "}
          {mode === "answer"
            ? "no repository is read; facts are checked against URLs"
            : "reads the code; plans a change or answers a question about it"}
          {"   (Tab to switch)"}
        </Text>
      </Box>
      {clash && (
        <Box marginTop={1}>
          <Text color="yellow">
            ! {clash}
            {cfg?.familyCheck === "require"
              ? " — this repo requires different families, so Enter is blocked (Ctrl+P to change)"
              : " (fine for testing; use --strict or familyCheck: \"require\" for a trial)"}
          </Text>
        </Box>
      )}
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
        {task ? (
          <Text>
            {task}
            <Text inverse> </Text>
          </Text>
        ) : (
          <Text dimColor>
            {mode === "answer" ? "Type your question, then press Enter…" : "Describe the task, then press Enter…"}
            <Text inverse> </Text>
          </Text>
        )}
      </Box>
      {mode === "plan" && looksLikeQuestion(task) && (
        <Box marginTop={1}>
          <Text color="yellow">
            ! that reads like a general question — Tab switches to one, with no repository read
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>Enter run · Tab mode · Ctrl+R past runs · Ctrl+P settings · Ctrl+U clear · Ctrl+C quit</Text>
      </Box>
      <Box>
        <Text dimColor>models, criteria and decisions live in {repo}/.adv/</Text>
      </Box>
    </Box>
  );
}

function Settings({
  cfg,
  mode,
  selection,
  saved,
}: {
  cfg: Config;
  mode: Mode;
  selection: number;
  saved: string | null;
}) {
  const rows: { label: string; value: string }[] = [
    { label: "drafter", value: cfg.models.drafter.ref },
    { label: "reviewer", value: cfg.models.reviewer.ref },
    { label: "subject", value: mode === "answer" ? "general question" : "this repository" },
    { label: "back", value: "" },
  ];
  const clash = familyClash(cfg.models);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right={`settings · family check ${cfg.familyCheck}`} />
      </Box>
      {rows.map((r, i) => (
        <Box key={r.label}>
          <Text color={i === selection ? THEME.accent : undefined}>{i === selection ? "❯ " : "  "}</Text>
          <Text color={i === selection ? THEME.accent : undefined} bold={i === selection}>
            {r.label.padEnd(10)}
          </Text>
          <Text>{r.value}</Text>
        </Box>
      ))}
      {clash && (
        <Box marginTop={1} flexDirection="column">
          <Text color={THEME.warn}>! {clash}</Text>
          <Text dimColor>
            {cfg.familyCheck === "require"
              ? "familyCheck: require — runs here will refuse to start."
              : "fine for testing. Set familyCheck to \"require\" in .adv/config.json for a trial."}
          </Text>
        </Box>
      )}
      {saved && (
        <Box marginTop={1}>
          <Text color={THEME.ok}>{saved}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>↑↓ move · Enter choose · Esc back</Text>
      </Box>
    </Box>
  );
}

function Pick({
  role,
  models,
  filter,
  index,
}: {
  role: "drafter" | "reviewer";
  models: string[];
  filter: string;
  index: number;
}) {
  const shown = models.filter((m) => m.toLowerCase().includes(filter.toLowerCase())).slice(0, 500);
  const height = 12;
  const start = Math.max(0, Math.min(index - 5, Math.max(0, shown.length - height)));

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right={`pick ${role}`} />
      </Box>
      <Box>
        <Text dimColor>filter  </Text>
        <Text>{filter || "type to filter…"}</Text>
        <Text inverse> </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {shown.slice(start, start + height).map((m, i) => {
          const absolute = start + i;
          const selected = absolute === index;
          return (
            <Box key={m}>
              <Text color={selected ? THEME.accent : undefined}>{selected ? "❯ " : "  "}</Text>
              <Text color={selected ? THEME.accent : undefined} bold={selected}>
                {m}
              </Text>
              <Text dimColor>{`  [${familyOf(m)}]`}</Text>
            </Box>
          );
        })}
        {shown.length === 0 && <Text dimColor>no match</Text>}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{shown.length} match(es) · ↑↓ choose · Enter select · Esc back</Text>
      </Box>
    </Box>
  );
}

/** A past run, as a row: when, what it was, where it stands. */
function Runs({
  runs,
  index,
}: {
  runs: RunSummary[];
  index: number;
}) {
  const width = Math.max(40, (process.stdout.columns ?? 100) - 4);
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right="past runs" />
      </Box>
      <Text dimColor>
        open one to continue it — a finished run can be revisited, a parked one finished
      </Text>
      <Box marginTop={1} flexDirection="column">
        {runs.slice(0, 12).map((r, i) => {
          const selected = i === index;
          const label = r.mode === "answer" ? "question" : "task";
          const text = r.task.length > width - 34 ? `${r.task.slice(0, width - 37)}…` : r.task;
          return (
            <Box key={r.name}>
              <Text color={selected ? THEME.accent : undefined}>{selected ? "❯ " : "  "}</Text>
              <Text color={selected ? THEME.accent : undefined} bold={selected}>
                {r.name}
              </Text>
              <Text color={selected ? THEME.accent : undefined}>
                {"   "}
                {r.state.padEnd(8)}
              </Text>
              <Text color={selected ? THEME.accent : undefined} dimColor={!selected}>
                {label} · {text}
              </Text>
            </Box>
          );
        })}
        {runs.length === 0 && <Text dimColor>no runs recorded for this repository yet</Text>}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ choose · Enter open · n question · Esc back</Text>
      </Box>
    </Box>
  );
}

function Approve({
  request,
  onAnswer,
}: {
  request: ApprovalRequest;
  onAnswer: (ok: boolean) => void;
}) {
  useInput((input, key) => {
    if (input === "y" || input === "Y") onAnswer(true);
    else if (input === "n" || input === "N" || key.escape || key.return) onAnswer(false);
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right="a check needs your ok" />
      </Box>
      <Text>The reviewer could not settle {request.claim} from the files.</Text>
      <Text>It wants to run:</Text>
      <Box marginLeft={2} marginTop={1}>
        <Text bold color={THEME.accent}>{request.argv.join(" ")}</Text>
      </Box>
      {request.why && (
        <Box marginLeft={2}>
          <Text dimColor>{request.why}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          This runs the project's own code and can take a minute. The result is
          recorded, and if it disagrees with the plan, the plan is corrected.
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text bold>y</Text> run it · <Text bold>n</Text> skip it
        </Text>
      </Box>
    </Box>
  );
}

/**
 * The run log, and the one live line that goes with it.
 *
 * Finished lines go into Ink's <Static>: each is written to the terminal once
 * and is never redrawn or erased. That is what keeps the log when the phase
 * changes — the gate, the result, the exit — because the redrawn frame is
 * everything *below* it, and the history stays on screen and in the scrollback.
 * Before this, each phase replaced the whole frame, and the gate wiped the log
 * exactly when the human wanted to know how the run got to that question.
 *
 * The live line is the spinner, labelled with what is happening. It is part of
 * the frame, so it disappears with the phase — only settled lines are permanent.
 */
function Log({ log, label }: { log: string[]; label: string | null }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (label === null) return;
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, [label]);
  const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame % 10];

  return (
    <>
      <Static items={log}>
        {(line, i) => (
          <Text key={i} dimColor={line.startsWith("!")} color={line.startsWith("!") ? "yellow" : undefined}>
            {line}
          </Text>
        )}
      </Static>
      {label !== null && (
        <Box>
          <Text color={THEME.warn}>{spinner} </Text>
          <Text dimColor>{label}</Text>
        </Box>
      )}
    </>
  );
}

/** Wrap text to the terminal width, clipping to a few lines so a question fits. */
function wrapText(text: string, maxLines: number): string[] {
  const width = Math.max(40, (process.stdout.columns ?? 100) - 4);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1] ?? ""}…`];
}

function GateView({
  claims,
  review,
  items,
  index,
  selection,
  warnings,
  checks,
  models,
  mode,
  revisit,
  current,
}: {
  claims: Claims;
  review: Review;
  items: GateItem[];
  index: number;
  selection: number;
  warnings: string[];
  checks: AuditRecord[];
  models: { drafter: { ref: string }; reviewer: { ref: string } };
  mode: Mode;
  /** True when this gate was asked before and its answers are prefilled. */
  revisit?: boolean;
  /** The recorded answer for the current item, when there is one. */
  current?: string;
}) {
  const item = items[index];
  if (!item) return null;

  const counts = verdictCounts(claims, review);
  const decisions = items.filter((i) => i.kind === "judgment").length;
  const findings = items.length - decisions;
  const thing = mode === "answer" ? "answer" : "plan";
  const author = models.drafter.ref;
  const checker = models.reviewer.ref;
  const refuted = review.verdicts.filter((v) => v.verdict === "refuted").length;
  const extras = [
    warnings.length ? `${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : "",
    checks.length ? `${checks.length} check${checks.length === 1 ? "" : "s"}` : "",
    refuted ? `${refuted} refuted claim${refuted === 1 ? "" : "s"}` : "",
  ].filter(Boolean);

  const detail: string[] = [];
  for (const line of item.detail) detail.push(...wrapText(line, 2));
  const clippedDetail = detail.slice(0, 4);

  return (
    <Box flexDirection="column">
      <Header
        right={`gate${revisit ? " · revisit" : ""} · ${index + 1} of ${items.length} · ${item.kind}`}
      />
      <Text dimColor>
        {items.length} questions: {decisions} for you to decide, {findings} finding
        {findings === 1 ? "" : "s"} to triage
      </Text>
      {revisit && (
        <Text dimColor>your recorded answers are prefilled — change only what you mean to</Text>
      )}
      <Line spans={statusSpans(counts)} />
      {extras.length > 0 && (
        <Text>
          <Text color={THEME.warn}>! {extras.join(" · ")}</Text>
          <Text dimColor> — i for details</Text>
        </Text>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          {item.kind === "finding"
            ? `${checker} noticed this in the ${thing} ${author} wrote:`
            : `${author} left this open for you:`}
        </Text>
      </Box>

      <Box flexDirection="column">
        {wrapText(item.title, 4).map((line, i) => (
          <Text key={i} bold>
            {line}
          </Text>
        ))}
      </Box>

      {clippedDetail.length > 0 && (
        <Box flexDirection="column">
          {clippedDetail.map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text bold color={THEME.accent}>
          {item.kind === "finding"
            ? `Change the ${thing} to cover this?`
            : `Which should the ${thing} do?`}
        </Text>
      </Box>

      <Box flexDirection="column">
        {item.options.map((option, i) => (
          <Box key={i}>
            <Text color={i === selection ? THEME.accent : undefined}>{i === selection ? "❯ " : "  "}</Text>
            <Text color={i === selection ? THEME.accent : undefined} bold={i === selection}>
              {option}
            </Text>
            {option === current && (
              <Text dimColor>
                {"   · "}
                <Text color={THEME.ok}>current — Enter keeps it</Text>
              </Text>
            )}
          </Box>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text>
          <Line
            spans={hints(
              ["↑↓", "move"],
              ["Enter", revisit ? "keeps current" : "answer"],
              ["w", "whole text"],
              ["d", thing],
              ["v", "verdicts"],
              ...(item.evidence ? ([["e", "source"]] as [string, string][]) : []),
              ["i", "summary"],
              ["l", "log"],
              ["n", "question"],
              ["Esc", "leave"],
            )}
          />
        </Text>
      </Box>
    </Box>
  );
}

/* ------------------------------------------------------------------ */

/** What the spinner says while a model is thinking. */
function workingLabel(log: string[], phase: Phase, mode: Mode): string | null {
  if (phase === "working") {
    return mode === "answer"
      ? "rewriting the answer with the drafter…"
      : "rewriting the plan with the drafter…";
  }
  if (phase !== "running") return null;
  const last = [...log].reverse().find((line) => !line.startsWith("!")) ?? "";
  if (last.startsWith("drafting")) return "waiting for the drafter…";
  if (last.startsWith("reviewing")) return "waiting for the reviewer — usually the slow part…";
  if (last.startsWith("review read") || last.startsWith("checking")) {
    return "running the checks the reviewer asked for…";
  }
  if (last.startsWith("rebutting") || last.startsWith("in scope")) {
    return "rewriting with the drafter…";
  }
  return log.length ? "working…" : "starting…";
}
function callLine(info: {
  kind: "draft" | "review" | "rebut";
  step: string;
  retry: boolean;
  ms: number;
  usage: { cost: number; costKnown: boolean };
}): string {
  const what =
    info.kind === "draft"
      ? info.step === "plan"
        ? "plan written"
        : "claims extracted"
      : info.kind === "review"
        ? "review returned"
        : info.step === "plan"
          ? "revision written"
          : "changelog written";
  // $0 is an absence, not a number: a gateway that reports no cost must not
  // make a paid run display as free.
  const cost = info.usage.costKnown ? `$${info.usage.cost.toFixed(6)}` : "cost not reported";
  return `${what}${info.retry ? " (retry)" : ""} — ${(info.ms / 1000).toFixed(1)}s, ${cost}`;
}

function App({ repo }: { repo: string }) {
  const { exit } = useApp();
  /* One handler for the whole app, in every phase, so no screen forgets it. */
  useInput((input, key) => {
    if (key.ctrl && input === "c") exit();
    // Past runs, from any settled screen: hopping between runs should not cost
    // a trip home first. Left off while a model call or an approval is in
    // flight — those phases are "running"/"working", and are not in this list.
    if (
      key.ctrl &&
      input === "r" &&
      (phase === "start" || phase === "gate" || phase === "result")
    ) {
      void openRuns();
    }
  });
  const [cfg, setCfg] = useState<Config | null>(null);
  const [hasCriteria, setHasCriteria] = useState(false);
  const [phase, setPhase] = useState<Phase>("start");
  const [mode, setMode] = useState<Mode>("plan");
  /* Two tasks, not one. `task` is the prompt on the question desk: the start
     screen owns it and nothing else writes to it, so looking at a past run and
     coming back finds the draft still there. `runTask` is the task of the run
     on screen — set from the draft when a run starts, from the run's own
     record when one is opened. Overloading one state is what used to eat the
     draft the moment you pressed Ctrl+R. */
  const [task, setTask] = useState("");
  const [runTask, setRunTask] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [head, setHead] = useState<Head | null>(null);
  const [tail, setTail] = useState<Tail | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  const [selection, setSelection] = useState(0);
  const [setupSelection, setSetupSelection] = useState(0);
  const [answers, setAnswers] = useState<GateAnswer[]>([]);
  const [settingsSel, setSettingsSel] = useState(0);
  const [allModels, setAllModels] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [pickIndex, setPickIndex] = useState(0);
  const [pickRole, setPickRole] = useState<"drafter" | "reviewer">("drafter");
  const [saved, setSaved] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clarifySel, setClarifySel] = useState(0);
  const approvalResolver = useRef<((ok: boolean) => void) | null>(null);

  /* The run being worked on, when it is one that already exists on disk.
     `previousGate` is the gate's answers as recorded before this gate was
     entered: null on a fresh run, the stored gate on a revisited or reopened
     one. It drives the prefill, the "did anything move" check, and the
     decisions.md supersede rule — the same three the CLI's `revise` uses. */
  const [previousGate, setPreviousGate] = useState<Gate | null>(null);
  /** The run already had a life on disk before this gate was entered. A failed
     tail on such a run parks back at its gate, retryable; a brand-new run
     keeps the head's rule — failed is failed. */
  const [reopened, setReopened] = useState(false);
  const [wasDone, setWasDone] = useState(false);
  const [runModels, setRunModels] = useState<Models | null>(null);
  const [runMode, setRunMode] = useState<Mode | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsIndex, setRunsIndex] = useState(0);
  const [runsLoading, setRunsLoading] = useState(false);

  /* The mode a run runs in: the run's own, or the subject preference for a
     fresh one. The preference (`mode`) is where *you* are working — it must
     not be hijacked by opening a run that happened to be in the other mode. */
  const effectiveMode: Mode = runMode ?? mode;

  const addLog = (line: string) => setLog((l) => [...l, line]);

  /* The pipeline asks for a yes before running a slow check. The promise is
     resolved by the Approve screen, so the run waits without blocking the UI. */
  const requestApproval = (request: ApprovalRequest) =>
    new Promise<boolean>((resolve) => {
      approvalResolver.current = resolve;
      setApproval(request);
    });

  function answerApproval(ok: boolean) {
    const resolve = approvalResolver.current;
    approvalResolver.current = null;
    setApproval(null);
    resolve?.(ok);
  }

  useEffect(() => {
    void (async () => {
      try {
        const present = await advState(repo);
        const config = await loadConfig(repo);
        setCfg(config);
        setMode(config.mode);
        setHasCriteria(present.criteria);
        // First run in a repo with no .adv/: ask, rather than silently using defaults.
        setPhase(present.dir ? "start" : "setup");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [repo]);

  useInput(
    (_input, key) => {
      if (key.upArrow) setSetupSelection(0);
      if (key.downArrow) setSetupSelection(1);
      if (key.return) void chooseSetup(setupSelection === 0 ? "init" : "skip");
    },
    { isActive: phase === "setup" },
  );

  useInput(
    (_input, key) => {
      if (key.escape) {
        setPhase("start");
        return;
      }
      if (key.upArrow) {
        setClarifySel(0);
        return;
      }
      if (key.downArrow) {
        setClarifySel(1);
        return;
      }
      if (key.return) beginRun(clarifySel === 0 ? "answer" : "plan");
    },
    { isActive: phase === "clarify" },
  );

  async function chooseSetup(action: "init" | "skip") {
    try {
      if (action === "init") {
        await initRepo(repo);
        setCfg(await loadConfig(repo));
        setHasCriteria(true);
      }
      setPhase("start");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  const persist = async (next: Config, nextMode: Mode) => {
    setCfg(next);
    await saveConfig(repo, { ...next, mode: nextMode });
  };

  async function openSettings() {
    setSettingsSel(0);
    setSaved(null);
    setPhase("settings");
    if (allModels.length === 0) {
      try {
        setAllModels(await listModels(repo));
      } catch {
        setAllModels([]);
      }
    }
  }

  /* Settings: choose models, switch mode. Every change is written to .adv/. */
  useInput(
    (_input, key) => {
      if (!cfg) return;
      if (key.escape) {
        setPhase("start");
        return;
      }
      if (key.upArrow) {
        setSettingsSel((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setSettingsSel((s) => Math.min(3, s + 1));
        return;
      }
      if (!key.return) return;

      if (settingsSel === 0 || settingsSel === 1) {
        setPickRole(settingsSel === 0 ? "drafter" : "reviewer");
        setFilter("");
        setPickIndex(0);
        setPhase("pick");
        return;
      }
      if (settingsSel === 2) {
        const nextMode: Mode = mode === "plan" ? "answer" : "plan";
        setMode(nextMode);
        void persist(cfg, nextMode).then(() => setSaved(`saved mode: ${nextMode}`));
        return;
      }
      setPhase("start");
    },
    { isActive: phase === "settings" },
  );

  /* Model picker. */
  useInput(
    (input, key) => {
      if (!cfg) return;
      const shown = allModels.filter((m) => m.toLowerCase().includes(filter.toLowerCase()));

      if (key.escape) {
        setPhase("settings");
        return;
      }
      if (key.upArrow) {
        setPickIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setPickIndex((i) => Math.min(Math.max(0, shown.length - 1), i + 1));
        return;
      }
      if (key.return) {
        const chosen = shown[pickIndex];
        if (chosen) {
          const next: Config = {
            ...cfg,
            models: { ...cfg.models, [pickRole]: { ref: chosen, family: familyOf(chosen) } },
          };
          void persist(next, mode).then(() => setSaved(`saved ${pickRole}: ${chosen}`));
        }
        setPhase("settings");
        return;
      }
      if (key.backspace || key.delete) {
        setFilter(filter.slice(0, -1));
        setPickIndex(0);
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input) {
        setFilter(filter + input);
        setPickIndex(0);
      }
    },
    { isActive: phase === "pick" },
  );

  const items = useMemo(() => (head ? buildItems(head.claims, head.review) : []), [head]);
  const runDir = head ? displayPath(head.paths.dir) : "";

  // One place for the review-level warnings: the gate shows a count, the `i`
  // panel shows them in full, and both read from here.
  const warnings = useMemo(
    () =>
      head
        ? gateWarnings({
            missing: head.missing,
            evidenceIssues: head.evidenceIssues,
            urlRepairs: head.urlRepairs,
            hasCriteria: effectiveMode === "answer" ? true : hasCriteria,
          })
        : [],
    [head, effectiveMode, hasCriteria],
  );

  /* A same-family pair is a warning, unless this repo says the result is
     evidence — then it is a stop, before any money is spent. */
  function beginRun(next: Mode = mode) {
    if (!cfg) return;
    const clash = familyClash(cfg.models);
    if (clash && cfg.familyCheck === "require") {
      setError(
        `${clash}.\n\nThis repo sets familyCheck: "require", so the run was not started. ` +
          `Choose a reviewer from another family with Ctrl+P.`,
      );
      setPhase("error");
      return;
    }
    // The two things the human just chose. They belong in the log: without them
    // the history starts at "drafting" and does not say what was asked or who is
    // doing it.
    addLog(`${next === "answer" ? "general question" : "repository"} · ${cfg.models.drafter.ref} -> ${cfg.models.reviewer.ref}`);
    addLog(`${next === "answer" ? "question" : "task"}: ${task.trim()}`);
    if (next !== mode) {
      setMode(next);
      void persist(cfg, next);
    }
    // A fresh run is a blank slate: nothing recorded to prefill, nothing to
    // supersede, and the config's models are the run's models.
    setRunMode(next);
    setRunModels(cfg.models);
    setRunTask(task.trim());
    setPreviousGate(null);
    setReopened(false);
    setWasDone(false);
    setGate(null);
    setTail(null);
    // `head` too: returning to the question desk from a finished run leaves the
    // old head in state, and the head effect skips while one is set — so a new
    // run would open straight onto the previous run's gate.
    setHead(null);
    setAnswers([]);
    setIndex(0);
    setSelection(0);
    setPanel(null);
    setPhase("running");
  }

  /* Run the head of the pipeline once the user commits a task. */
  useEffect(() => {
    if (phase !== "running" || !cfg || head) return;
    let cancelled = false;
    void (async () => {
      try {
        const criteria =
          effectiveMode === "answer" ? { text: NO_CRITERIA, found: false } : await readCriteria(repo);
        // Answer mode has no repository and needs no criteria; only a plan run
        // is missing something when the file is absent.
        if (!criteria.found && effectiveMode === "plan") {
          addLog("! .adv/criteria.md missing — using a fallback");
        }
        setHasCriteria(criteria.found);
        const decisions =
          effectiveMode === "answer" ? "(none — this is a general question)" : await readDecisions(repo);
        const reporting: Reporting = {
          onCall: (info) => addLog(callLine(info)),
          onNote: (text) => addLog(text),
          onApprove: requestApproval,
        };
        const result = await runHead(
          repo,
          runTask,
          criteria.text,
          decisions,
          cfg.models,
          effectiveMode,
          reporting,
        );
        if (cancelled) return;
        setHead(result);
        setPhase("gate");
      } catch (e) {
        if (cancelled) return;
        setError(`${e instanceof Error ? e.message : String(e)}\n\nthe run is recorded as failed — ` +
          `adv status shows it, and the artifacts so far are on disk`);
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, head, repo, runTask, cfg, effectiveMode]);

  async function finishGate(all: GateAnswer[]) {
    if (!head || !cfg) return;
    const built = answersToGate(all);

    // Did anything move since the gate was last recorded? A fresh run has no
    // previous gate, so everything is new and the tail always runs.
    const hadAnswers =
      previousGate !== null &&
      (previousGate.decisions.length > 0 || previousGate.findings.length > 0);
    const change = previousGate ? describeGateChange(previousGate, built) : null;
    const changed = change ? change.decisions.length + change.findings.length : 0;

    // `changed` is computed against the previous gate, or against nothing on a
    // fresh run — where the run is not done yet, so this never fires for one.
    if (changed === 0 && wasDone) {
      // The tail already ran with exactly these answers: the run stands as it
      // is, and the head is not worth re-running to say so. No model calls.
      addLog("no answers changed — the run stands as it is; no model calls made");
      setGate(built);
      setPhase("result");
      return;
    }
    if (hadAnswers && changed === 0) {
      // A run parked at the gate never ran its tail: "nothing changed" means
      // the recorded answers stand, and the one thing left is to apply them.
      addLog("no answers changed — the recorded gate stands; running the tail");
    }

    setPhase("working");
    const models = runModels ?? cfg.models;
    try {
      // The previous generation of answers survives the asking: the comparison
      // above needed them, and a human who wants the old view can read the file.
      await rotateGate(head.paths);
      await saveGate(head.paths, built);
      // A gate answer to a general question is not a repository decision.
      if (effectiveMode === "plan") {
        // A gate asked fresh appends every settled answer; a gate asked again
        // appends only what moved, each marked so the file's history reads.
        const entries = hadAnswers && change
          ? decisionEntries(head.claims, change)
          : built.decisions
              .filter((d) => d.choice !== "open")
              .map((d) => ({
                id: d.id,
                text: head.claims.judgment.find((j) => j.id === d.id)?.text ?? "",
                choice: d.choice,
              }));
        await appendDecisions(repo, entries);
      }
      setGate(built);
      const reporting: Reporting = {
        onCall: (info) => addLog(callLine(info)),
        onNote: (text) => addLog(text),
      };
      const result = await runTail(
        repo,
        head.paths,
        { task: runTask },
        head.claims,
        head.review,
        built,
        models,
        effectiveMode,
        reporting,
      );
      setTail(result);
      setWasDone(true);
      setPhase("result");
    } catch (e) {
      // A failed tail on a run that already existed must not dead-end it: the
      // head is intact and the answers just given are recorded, so the run
      // parks back at its own gate, where reopening it retries the tail —
      // `adv run --resume` accepts it too. (A brand-new run keeps the head's
      // rule: failed is failed.)
      if (reopened) {
        try {
          const s = await loadState(head.paths);
          if (s.state === "failed") await saveState(head.paths, { ...s, state: "gated" });
        } catch {
          /* the error screen is what matters */
        }
      }
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg +
          (reopened
            ? "\n\nthe run is parked back at its gate — Ctrl+R to reopen it and retry, or `adv run --resume` in the terminal"
            : "\n\nthe run is recorded as failed — the past-runs list (Ctrl+R) shows it"),
      );
      setPhase("error");
    }
  }

  /* Past runs: this repository's, plus every question, newest first. */
  async function openRuns() {
    setPhase("runs");
    // Any pane is on the screen we are leaving; it must not reappear when we
    // come back to a gate or a result later.
    setPanel(null);
    setRunsIndex(0);
    setRunsLoading(true);
    setRuns(await listRuns(repo));
    setRunsLoading(false);
  }

  /**
   * Open a recorded run and continue it. The run's own task, mode and models
   * become the session's: a general question re-opened must not start reading
   * the repository it was not asked about, and the tail must be written by the
   * drafter that wrote the plan, not whatever the config says today.
   */
  async function openRun(run: RunSummary) {
    const { name, dir } = run;
    const p = runPaths(repo, dir);
    try {
      const state = await loadState(p);
      if (state.state === "failed") {
        const first = state.error ? state.error.split("\n")[0]! : "";
        setError(
          `that run failed${first ? ` — ${first}` : ""}.\n\n` +
            `a failed run has no finished result to continue. Esc for the other runs, or type a new task.`,
        );
        setPhase("error");
        return;
      }
      const art = await loadArtifacts(p);
      const thing = state.mode === "answer" ? "question" : "task";
      addLog(
        `opening ${name} — ${thing} "${state.task.slice(0, 80)}" · was ${state.state} · ` +
          `${state.models.drafter.ref} -> ${state.models.reviewer.ref}`,
      );
      setHead(headFromArtifacts(repo, p, art));
      setPreviousGate(art.gate);
      setReopened(true);
      setGate(art.gate);
      setWasDone(state.state === "done");
      setRunModels(state.models);
      setRunMode(state.mode);
      setRunTask(state.task);
      setAnswers([]);
      setIndex(0);
      setSelection(0);
      setPanel(null);
      if (state.state === "done") {
        setTail(await loadTail(p));
        setPhase("result");
      } else {
        setPhase("gate");
      }
    } catch (e) {
      setError(`${e instanceof Error ? e.message : String(e)}\n\nthe run could not be opened`);
      setPhase("error");
    }
  }

  /**
   * From the result screen: ask the gate again, with the recorded answers
   * prefilled. The cursor sits on each recorded answer; Enter keeps it. If
   * nothing moved, no model call is spent — the run stands as it is.
   */
  function startRevisit() {
    if (!head || !gate) return;
    setPreviousGate(gate);
    // The result screen only exists for a finished run, so this is always a
    // run with a life on disk: a failed tail here parks back at the gate.
    setReopened(true);
    setWasDone(true);
    setAnswers([]);
    setIndex(0);
    // The first question's cursor starts on its recorded answer, like every
    // later one will.
    const first = items[0];
    if (first) {
      const recorded =
        first.kind === "judgment"
          ? gate.decisions.find((d) => d.id === first.id)?.choice
          : gate.findings.find((f) => f.id === first.id)?.disposition;
      setSelection(selectionForCurrent(first, recorded));
    } else {
      setSelection(0);
    }
    setPanel(null);
    addLog("revisiting the gate — your recorded answers are prefilled");
    setPhase("gate");
  }

  /* The copy notice is an answer to a keystroke, not part of the result: it
     goes away on its own so the footer is not permanently shouting. */
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  /**
   * The result as the renderer wants it: what the screen is drawn from.
   *
   * The screen never inlines the diff. It is 30 rows of the 60, so it used to
   * sit below the fold, and toggling it changed the row count and nothing a
   * reader could see — which is why it is a panel now (`x`). The copies ask for
   * it: `Y` is "the whole result", and the diff is part of it.
   */
  function resultReport(includeDiff = false) {
    if (!tail || !head) return null;
    return {
      plan: tail.plan,
      changelog: tail.changelog,
      patch: tail.patch,
      assessment: tail.assessment,
      gate: gate ?? { decisions: [], findings: [] },
      claims: head.claims,
      review: head.review,
      checks: head.checks,
      ...(runModels ? { models: runModels } : cfg ? { models: cfg.models } : {}),
      includeDiff,
    };
  }

  /**
   * Copy the answer as Markdown — `y`, or the whole result with `Y`.
   *
   * `y` is `tail.plan`: the writer's own text, the same bytes as `plan.v2.md`,
   * with no wrapping, no terminal cleanup and no sources moved around. `Y` is
   * the result in Markdown, commentary and diff included, so it travels whole
   * when the answer is going somewhere to be discussed.
   */
  async function copyOut(whole = false) {
    if (!tail || !head) return;
    const text = whole ? renderResult(resultReport(true)!) : tail.plan;
    const file = whole ? head.paths.result : head.paths.answer;
    const result = await copyMarkdown(text, file);
    setNotice(copyNotice(result, text.length, path.basename(file)));
  }

  /**
   * The exact changes, and what each change was for — full pane.
   *
   * Opened by `x` rather than toggled into the result: the answer to "which
   * lines changed" is a thing to read, not a section to scroll past.
   */
  function openDiff() {
    const report = resultReport(true);
    if (!report) return;
    const lines = diffPane(report);
    setPanel({
      title: "the exact changes, and why",
      lines: lines.length
        ? lines
        : [spans({ text: "no diff — the text is unchanged", dim: true })],
    });
  }

  /**
   * A panel: a title, and lines wrapped to the pane.
   *
   * Everything goes through `fitSpans`, for the same reason the result does —
   * one element has to be one row, or the panel's scroll count stops matching
   * what is on the screen.
   */
  function showPanel(title: string, lines: StyledLine[], hang = 2) {
    setPanel({ title, lines: fitSpans(lines, wrapWidth(), hang) });
  }

  /** Keys, the draft, the claims, the raw review reply: curiosity and debugging. */
  function openResultPanel(kind: "keys" | "claims" | "raw") {
    if (!head) return;
    if (kind === "keys") {
      showPanel(
        "keys on this screen",
        RESULT_KEYS.map((k) =>
          spans({ text: `  ${k.key.padEnd(12)}`, color: THEME.accent, bold: true }, k.what),
        ),
        14,
      );
      return;
    }
    if (kind === "claims") {
      const lines: StyledLine[] = [
        spans({ text: "VERIFIABLE", bold: true }, " — the reviewer must return a verdict on each"),
        [],
      ];
      for (const c of head.claims.verifiable) {
        lines.push(spans({ text: `  ${c.id}`, dim: true }, `  ${c.text}`));
      }
      lines.push([], spans({ text: "JUDGMENT CALLS", bold: true }, " — the human decides these, not a model"), []);
      for (const j of head.claims.judgment) {
        lines.push(spans({ text: `  ${j.id}`, dim: true }, `  ${j.text}`));
        for (const option of j.options) lines.push(spans({ text: `      · ${option}`, dim: true }));
      }
      if (head.missing.length) {
        lines.push(
          [],
          spans({ text: "NO VERDICT RETURNED", color: THEME.warn }),
          ...head.missing.map((id) => spans({ text: `  ${id}`, dim: true })),
        );
      }
      showPanel("the claims the drafter declared", lines);
      return;
    }
    // The reviewer's own words, before the tool merged a check result into
    // them: the difference between review.json and what the gate showed is
    // exactly what the audit changed.
    showPanel(
      "the reviewer's raw reply",
      JSON.stringify(head.review, null, 2).split("\n").map((text) => spans({ text, dim: true })),
      0,
    );
  }

  /* Panels: the text the calls are about, every verdict, the cited source, the log. */
  async function openPanel(kind: "text" | "verdicts" | "evidence" | "log" | "info" | "item") {
    if (!head) return;
    const item = items[index];
    const thing = effectiveMode === "answer" ? "answer" : "plan";

    if (kind === "log") {
      showPanel(
        "run log",
        (log.length ? log : ["(nothing logged yet)"]).flatMap((line) =>
          line.startsWith("!")
            ? [spans({ text: line, color: THEME.warn })]
            : [spans({ text: line })],
        ),
        0,
      );
      return;
    }

    if (kind === "info") {
      const lines: StyledLine[] = [];
      if (warnings.length) {
        lines.push(spans({ text: "WARNINGS", color: THEME.warn }));
        for (const w of warnings) lines.push(spans("  ", { text: w, color: THEME.warn }));
        lines.push([]);
      }
      if (head.checks.length) {
        lines.push(spans({ text: "CHECKS THE TOOL RAN", color: THEME.accent }));
        for (const line of auditSpans(head.checks)) lines.push(spans("  ", ...line));
        lines.push([]);
      }
      const refuted = head.review.verdicts.filter((v) => v.verdict === "refuted");
      if (refuted.length) {
        lines.push(spans({ text: "REFUTED CLAIMS (these go to the rewrite)", color: THEME.danger }));
        for (const v of refuted) {
          lines.push(
            spans(
              { text: `  ${v.id}`, dim: true },
              `  ${head.claims.verifiable.find((c) => c.id === v.id)?.text ?? ""}`,
            ),
          );
        }
      }
      showPanel("the review at a glance", lines.length ? lines : [spans("nothing to report")]);
      return;
    }

    if (kind === "item") {
      showPanel(
        item ? `${item.id} — the whole text` : "the whole text",
        item
          ? [
              spans({ text: item.title, bold: true }),
              [],
              ...item.detail.map((text) => spans({ text, dim: true })),
            ]
          : [spans("nothing here")],
      );
      return;
    }

    if (kind === "text") {
      // The plan or answer as the model wrote it: real Markdown, rendered.
      // This pane used to show the raw source, which read like a file dump,
      // and it is the pane the human reads before every judgment call.
      const answer = renderAnswer(head.plan);
      const markdown = answer.sources
        ? `${answer.body}\n\n### Sources\n\n${answer.sources}`
        : answer.body;
      setPanel({
        // At the gate this is the text the questions are about, still in play.
        // On the result screen the run is over, and what this is showing is the
        // first draft the review saw — worth naming, because the answer above it
        // has since changed.
        title: phase === "result" ? "the original draft, as the review saw it" : `the ${thing} so far`,
        lines: renderMarkdownLines(markdown, wrapWidth()),
      });
      return;
    }

    if (kind === "verdicts") {
      const counts = verdictCounts(head.claims, head.review);
      const lines: StyledLine[] = [statusSpans(counts), []];
      // The colours follow "what needs attention": a refuted claim goes to the
      // rewrite, an unverifiable one is where the human has nothing to go on.
      // Confirmed is left alone — the file agreed, which is not a verdict on
      // whether the sentence is worth keeping.
      const heading = { refuted: THEME.danger, unverifiable: THEME.warn, confirmed: undefined };
      const order = ["refuted", "unverifiable", "confirmed"] as const;
      for (const verdict of order) {
        const rows = head.review.verdicts.filter((v) => v.verdict === verdict);
        if (rows.length === 0) continue;
        const colour = heading[verdict];
        lines.push(spans({ text: verdict.toUpperCase(), ...(colour ? { color: colour } : { bold: true }) }));
        for (const v of rows) {
          const text = head.claims.verifiable.find((c) => c.id === v.id)?.text ?? "";
          lines.push(spans({ text: `  ${v.id}`, dim: true }, `  ${text}`));
          if (v.verdict === "unverifiable") {
            lines.push(spans({ text: `      ${v.note}`, color: THEME.warn }));
          } else {
            lines.push(
              spans(
                { text: `      [${v.evidence}]`, color: THEME.code },
                v.note ? { text: ` — ${v.note}`, dim: true } : { text: "" },
              ),
            );
          }
        }
        lines.push([]);
      }
      for (const claim of head.claims.verifiable) {
        if (!head.review.verdicts.some((v) => v.id === claim.id)) {
          lines.push(
            spans({ text: "NO VERDICT", color: THEME.warn }, `  ${claim.id}  ${claim.text}`),
          );
        }
      }
      if (head.review.extra_findings.length) {
        lines.push([], spans({ text: "FINDINGS", color: THEME.accent }));
        for (const f of head.review.extra_findings) {
          lines.push(spans({ text: `  ${f.id}`, dim: true }, `  ${f.text}`));
          if (f.evidence) lines.push(spans({ text: `      [${f.evidence}]`, color: THEME.code }));
          else if (f.note) lines.push(spans({ text: `      ${f.note}`, dim: true }));
        }
      }
      showPanel("review — every verdict", lines);
      return;
    }

    if (!item?.evidence) return;

    // A URL is not a file. The old fallback told the human "this citation
    // cannot be shown here — it is worth questioning", which reads as an
    // accusation against a perfectly good URL. Say what it is instead.
    const ref = parseEvidence(item.evidence);
    if (ref?.kind === "url") {
      showPanel(`${item.id} — evidence`, [
        spans({ text: item.evidence, color: THEME.code }),
        [],
        spans({ text: "this is a source URL — the tool cannot display web pages here.", dim: true }),
        spans({ text: "open it, and judge the finding on its merits before you choose", dim: true }),
      ]);
      return;
    }

    const context = await readEvidenceContext(repo, item.evidence);
    setPanel({
      title: `${item.id} — ${item.evidence}`,
      lines: fitSpans(
        context
          ? [
              spans({
                text: `${context.file}${context.line ? `:${context.line}` : ""}`,
                color: THEME.accent,
                bold: true,
              }),
              [],
              ...context.lines.map((text) => spans({ text })),
            ]
          : [
              spans({ text: item.evidence, color: THEME.code }),
              [],
              spans({
                text: "not a readable file in this repository — the reviewer's citation cannot be shown here.",
                dim: true,
              }),
              spans({
                text: "A citation that does not resolve is itself worth questioning at this gate.",
                dim: true,
              }),
            ],
        wrapWidth(),
        0,
      ),
    });
  }

  /* Gate input. Nothing here is decided by a model. */
  useInput(
    (input, key) => {
      const item = items[index];
      if (!item) return;

      // Where the cursor lands on a recorded answer: on it. That is the whole
      // point of the prefill — Enter keeps, arrows change.
      const landOn = (i: number) => {
        const nextItem = items[i];
        if (!nextItem) {
          setSelection(0);
          return;
        }
        const recorded = previousGate
          ? nextItem.kind === "judgment"
            ? previousGate.decisions.find((d) => d.id === nextItem.id)?.choice
            : previousGate.findings.find((f) => f.id === nextItem.id)?.disposition
          : undefined;
        setSelection(selectionForCurrent(nextItem, recorded));
      };

      const commit = (value: string) => {
        const next = [...answers, { id: item.id, kind: item.kind, value }];
        setAnswers(next);
        if (index + 1 < items.length) {
          setIndex(index + 1);
          landOn(index + 1);
        } else {
          void finishGate(next);
        }
      };

      if (key.escape) {
        // Leaving the gate never loses the run: the head is on disk, and the
        // run is reachable again from the past-runs list.
        addLog("leaving the gate — the run stays on disk; Ctrl+R reopens it");
        void openRuns();
        return;
      }

      if (input === "n" && !key.ctrl && !key.meta) {
        // Not what this run is about — back to the question desk. The run stays
        // parked on disk and is reachable again with Ctrl+R.
        setPhase("start");
        return;
      }

      if (key.upArrow) {
        setSelection((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setSelection((s) => Math.min(item.options.length - 1, s + 1));
        return;
      }
      if (input === "d") {
        void openPanel("text");
        return;
      }
      if (input === "v") {
        void openPanel("verdicts");
        return;
      }
      if (input === "e" && item.evidence) {
        void openPanel("evidence");
        return;
      }
      if (input === "l") {
        void openPanel("log");
        return;
      }
      if (input === "i") {
        void openPanel("info");
        return;
      }
      if (input === "w") {
        void openPanel("item");
        return;
      }
      if (input === "o" && item.kind === "judgment") {
        commit("open");
        return;
      }
      if (input === "s") {
        // Skip: a finding is left untriaged (the text stays as it is); a
        // judgment call is left open (the text presents both options).
        commit(item.kind === "finding" ? "untriaged" : "open");
        return;
      }
      if (key.return) commit(item.values[selection] ?? item.values[0]!);
    },
    { isActive: phase === "gate" && panel === null },
  );

  /* Past-runs list input. */
  useInput(
    (input, key) => {
      if (key.upArrow) {
        setRunsIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setRunsIndex((i) => Math.min(runs.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const chosen = runs[runsIndex];
        // The row carries its own directory: a question and a task recorded in
        // the same second share a name, and only the row knows which is which.
        if (chosen) void openRun(chosen);
        return;
      }
      if (key.escape) {
        setPhase("start");
        return;
      }
      if (input === "n" && !key.ctrl && !key.meta) {
        setPhase("start");
      }
    },
    { isActive: phase === "runs" },
  );

  /* Nothing to ask: go straight through. */
  useEffect(() => {
    if (phase === "gate" && head && items.length === 0 && answers.length === 0) {
      void finishGate([]);
    }
  }, [phase, head, items.length, answers.length]);

  /* The log is never part of a phase's frame. It sits above the frame, in
     <Static>: settled lines are written once and stay on screen, so a phase
     change rewrites the screen below the history instead of erasing it. */
  const logLabel = approval ? null : workingLabel(log, phase, effectiveMode);

  let content: ReactNode;

  if (phase === "setup") {
    content = <Setup repo={repo} selection={setupSelection} />;
  } else if (phase === "settings" && cfg) {
    content = <Settings cfg={cfg} mode={mode} selection={settingsSel} saved={saved} />;
  } else if (phase === "pick") {
    content = <Pick role={pickRole} models={allModels} filter={filter} index={pickIndex} />;
  } else if (phase === "start") {
    content = (
      <Start
        repo={repo}
        cfg={cfg}
        mode={mode}
        task={task}
        setTask={setTask}
        onRun={() => {
          // A question typed in plan mode reads the repository and answers with
          // a "Plan:". Ask once, rather than relying on a warning line.
          if (mode === "plan" && looksLikeQuestion(task)) {
            setClarifySel(0);
            setPhase("clarify");
            return;
          }
          beginRun();
        }}
        onToggleMode={() => {
          // Persist it: the mode is a preference, like the models, and Tab
          // followed by a restart used to put you back in plan mode.
          const next: Mode = mode === "plan" ? "answer" : "plan";
          setMode(next);
          if (cfg) void persist(cfg, next);
        }}
        onSettings={() => void openSettings()}
      />
    );
  } else if (phase === "running" && approval) {
    content = <Approve request={approval} onAnswer={answerApproval} />;
  } else if (phase === "running" || phase === "working") {
    /* The screen is the log plus the spinner line it draws. */
    content = null;
  } else if (phase === "runs") {
    content = runsLoading ? (
      <Text dimColor>loading past runs…</Text>
    ) : (
      <Runs runs={runs} index={runsIndex} />
    );
  } else if (phase === "gate" && head) {
    if (panel) {
      content = (
        <Scroller
          key={`panel:${panel.title}`}
          title={panel.title}
          lines={panel.lines}
          footer={[
            { text: `gate ${index + 1} of ${items.length}`, color: THEME.accent },
            { text: " · Esc back to the question", dim: true },
          ]}
          onClose={() => setPanel(null)}
        />
      );
    } else {
      // The recorded answer for the question on screen, when one exists: the
      // cursor lands on it and the option is marked, so "keep" is visible.
      const it = items[index];
      const hadAnswers =
        previousGate !== null &&
        (previousGate.decisions.length > 0 || previousGate.findings.length > 0);
      const current = it && previousGate
        ? it.kind === "judgment"
          ? previousGate.decisions.find((d) => d.id === it.id)?.choice
          : previousGate.findings.find((f) => f.id === it.id)?.disposition
        : undefined;
      content = (
        <GateView
          claims={head.claims}
          review={head.review}
          items={items}
          index={index}
          selection={selection}
          warnings={warnings}
          checks={head.checks}
          models={runModels ?? cfg?.models ?? { drafter: { ref: "drafter" }, reviewer: { ref: "reviewer" } }}
          mode={effectiveMode}
          revisit={hadAnswers}
          current={current}
        />
      );
    }
  } else if (phase === "result" && tail && head) {
    const report = resultReport();
    // A panel opens over the result and Esc puts it away. The result screen is
    // where a finished run is read, and reading it means being able to look up
    // the draft, the claims and the reviewer's own words without leaving.
    content = panel ? (
      <Scroller
        key={`panel:${panel.title}`}
        title={panel.title}
        lines={panel.lines}
        footer={[
          { text: "the result", color: THEME.accent },
          { text: " · Esc back", dim: true },
        ]}
        onClose={() => setPanel(null)}
      />
    ) : report ? (
      <Scroller
        key="result"
        title="done"
        lines={renderResultLines(report)}
        notice={notice}
        escLabel="q quits"
        escCloses={false}
        onEsc={() => setNotice("Esc does not quit here — n for a new question, q to quit")}
        // Short on purpose: the pane's height is the terminal minus the chrome,
        // and a footer that wraps to two lines takes a row from the text. The
        // rest of the keys are behind `?`.
        footer={[
          ...hints(
            ["y", "copy answer"],
            ["Y", "copy all"],
            ["x", "diff + why"],
            ["n", "question"],
            ["?", "keys"],
            ["q", "quit"],
          ),
          { text: ` · ${runDir}`, dim: true },
        ]}
        onClose={() => exit()}
        onKey={(input) => {
          if (input === "n") {
            setPhase("start");
            return true;
          }
          if (input === "x") {
            openDiff();
            return true;
          }
          if (input === "y") {
            void copyOut();
            return true;
          }
          if (input === "Y") {
            void copyOut(true);
            return true;
          }
          if (input === "r") {
            startRevisit();
            return true;
          }
          if (input === "?") {
            openResultPanel("keys");
            return true;
          }
          if (input === "d") {
            void openPanel("text");
            return true;
          }
          if (input === "v") {
            void openPanel("verdicts");
            return true;
          }
          if (input === "i") {
            void openPanel("info");
            return true;
          }
          if (input === "l") {
            void openPanel("log");
            return true;
          }
          if (input === "c") {
            openResultPanel("claims");
            return true;
          }
          if (input === "R") {
            openResultPanel("raw");
            return true;
          }
          return false;
        }}
      />
    ) : null;
  } else if (phase === "error") {
    content = (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color={THEME.danger} bold>
            error
          </Text>
        </Box>
        <Text>{error}</Text>
        {error.includes("timed out") && (
          <Box marginTop={1}>
            <Text dimColor>
              The model took longer than three minutes. With web checking that
              usually means too many searches. Try a different reviewer with
              Ctrl+P, or a narrower question.
            </Text>
          </Box>
        )}
        {error.startsWith("validation failed") && (
          <Box marginTop={1}>
            <Text dimColor>
              That is the model's reply, not a bug in adv: it did not fit the
              expected shape, twice. Try again, or choose a different reviewer
              with Ctrl+P.
            </Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Ctrl+C to quit</Text>
        </Box>
      </Box>
    );
  } else {
    content = null;
  }

  return (
    <Box flexDirection="column">
      <Log log={log} label={logLabel} />
      {content}
    </Box>
  );
}

export async function startTui(opts: { repo: string }): Promise<void> {
  const app = render(<App repo={opts.repo} />);
  await app.waitUntilExit();
}
