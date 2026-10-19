import { Box, Static, Text, render, useApp, useInput } from "ink";
import path from "node:path";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
import { familyClash, familyOf, listModels, orderedModels, providerOf } from "./models.ts";
import { costOf, cannotUseTools, formatCost, loadCatalogue, type Catalogue } from "./catalogue.ts";
import { mouseAccepting, MOUSE_OFF, MOUSE_ON, setMouseAccepting, wheelRows } from "./mouse.ts";
import { allProviderBills, authedProviders, noteForModel, PROVIDER_NOTES } from "./providers.ts";
import { failedProbes, loadProbes, pingModel, probeBadge, probeCoverage, probeHint, type ProbeCache } from "./probe.ts";
import { readOpenCodeModels } from "./opencode-state.ts";
import {
  deletePair,
  loadPairs,
  markPairUsed,
  nameForPair,
  pairKey,
  pairModels,
  pairRows,
  savePair,
  type Models as PairModels,
  type Pair,
  type PairRow,
} from "./pairs.ts";
import {
  appendDecisions,
  deleteRuns,
  deletionSummary,
  displayPath,
  listRuns,
  loadState,
  NO_CRITERIA,
  readCriteria,
  readDecisions,
  rotateGate,
  runPaths,
  saveState,
  type DeletionSummary,
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
import type { Mode, ModelRef } from "./runner.ts";

type Phase =
  | "setup"
  | "start"
  | "clarify"
  | "settings"
  | "pick"
  | "providers"
  | "pairs"
  | "pairname"
  | "pairconfirm"
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
  { key: "↑↓ · j / k", what: "scroll a line" },
  { key: "space · f", what: "page down" },
  { key: "b · u", what: "page up · half a page up" },
  { key: "Ctrl+D · Ctrl+U", what: "half a page down · half a page up" },
  { key: "g / G", what: "jump to the top / the end" },
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
function Line({ spans, wrap }: { spans: StyledLine; wrap?: "truncate" }) {
  return (
    <Text wrap={wrap}>
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

/**
 * Subscribe to wheel reports while this screen is the one on the stack.
 *
 * Only one scrollable screen is mounted at a time, so a plain subscription is
 * unambiguous: whichever screen is up does the scrolling. The callback is held
 * in a ref because it closes over state that changes every render, and
 * re-subscribing on every render would drop reports arriving in between.
 */
function useWheelScroll(onScroll: (rows: number) => void, active = true) {
  const latest = useRef(onScroll);
  latest.current = onScroll;
  useEffect(() => {
    if (!active) return;
    const onData = (chunk: Buffer | string) => {
      if (!mouseAccepting()) return;
      const rows = wheelRows(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      if (rows) latest.current(rows);
    };
    process.stdin.on("data", onData);
    return () => {
      process.stdin.off("data", onData);
    };
  }, [active]);
}

/** Terminal height for a scrollable pane, leaving room for the chrome. */
const paneHeight = (chrome: number, rows: number) => Math.max(6, rows - chrome);

/**
 * The live terminal width. `process.stdout.columns` is read during render, so
 * a component that measures must also re-render when it changes — otherwise
 * Ink resizes Yoga and repaints the committed tree, still carrying the old
 * width, and every row padded to the old width wraps once in the new one.
 * Ink's own `resize` listener is registered first (at `render()`), so Yoga is
 * already at the new size when this notifies; the re-render lands framed
 * right. Worst case during a drag is one stale frame, immediately corrected.
 */
const subscribeResize = (cb: () => void) => {
  process.stdout.on("resize", cb);
  return () => {
    process.stdout.off("resize", cb);
  };
};
const useTerminalWidth = () => useSyncExternalStore(subscribeResize, () => process.stdout.columns ?? 100);
const useTerminalRows = () => useSyncExternalStore(subscribeResize, () => process.stdout.rows ?? 24);

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
  const termRows = useTerminalRows();
  const height = paneHeight(8, termRows);
  const [offset, setOffset] = useState(0);

  useWheelScroll((rows) => by(rows));

  /** Move by rows, clamped, so the pane cannot be scrolled past either end. */
  const by = (rows: number) => setOffset((o) => clampOffset(o + rows, lines.length, height));
  const half = Math.max(1, Math.ceil(height / 2));

  useInput((input, key) => {
    // The control pairs first: Ctrl+D and Ctrl+U are how a Mac pages a document,
    // and the swallow below would otherwise eat them.
    if (key.ctrl && input === "d") {
      by(half);
      return;
    }
    if (key.ctrl && input === "u") {
      by(-half);
      return;
    }
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
    // `j`/`k` a line, `space`/`f` a page, `b`/`u` back a page and half a page,
    // `g`/`G` the ends. Apple Terminal keeps PageUp and PageDown for its own
    // scrollback — they never reach the app — so the paging keys have to be
    // letters. `pageUp`/`pageDown` still work where a terminal does send them.
    if (key.downArrow || input === "j") by(1);
    else if (key.upArrow || input === "k") by(-1);
    else if (key.pageDown || input === " " || input === "f") by(height);
    else if (key.pageUp || input === "b") by(-height);
    else if (input === "u") by(-half);
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
          {` · ↑↓ line · space/b page · ${escLabel}`}
        </Text>
      </Box>
      <Box>
        <Line spans={footer} wrap="truncate" />
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
    // Mouse reports arrive as input too. A wheel notch must scroll the screen,
    // not type `[<64;10;5M` into the question.
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
  pair,
}: {
  cfg: Config;
  mode: Mode;
  selection: number;
  saved: string | null;
  /** The name of the saved pair these two models are, or null when unnamed. */
  pair: string | null;
}) {
  const rows: { label: string; value: string }[] = [
    // Matched by model, not by position: a pair saved under another name is
    // still the pair in use, and showing nothing would read as "no pair".
    { label: "pair", value: pair ?? "—" },
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

/** Above this a sweep is refused by name rather than silently costing 100 calls. */
const SWEEP_MAX = 40;

/** Fixed badge columns, so every row's price and status line up. */
const COST_W = 14;
const BADGE_W = 16;

/** Pads or trims to an exact column count, so a badge column stays aligned. */
const pad = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n) : s.length >= n ? s : s + " ".repeat(n - s.length);

/**
 * Shorten a ref from the middle, never the end.
 *
 * `opencode-go/muse-spark` and `opencode/muse-spark-free` differ at *both*
 * ends — the provider prefix and the free suffix. A trailing `…` hides exactly
 * the distinction a reader is trying to make, so the middle goes instead and
 * both halves stay legible.
 */
function shorten(ref: string, max: number): string {
  if (ref.length <= max) return ref;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.55);
  const tail = keep - head;
  return `${ref.slice(0, head)}…${ref.slice(ref.length - tail)}`;
}

function Pick({
  role,
  list,
  filter,
  index,
  catalogue,
  probes,
  pinging,
  keyed,
  subject,
  notice,
}: {
  role: "drafter" | "reviewer";
  list: ReturnType<typeof orderedModels>;
  filter: string;
  index: number;
  catalogue: Catalogue;
  probes: ProbeCache;
  pinging: Set<string>;
  keyed: Set<string>;
  subject: Mode;
  notice: string | null;
}) {
  const height = 12;
  const { rows, items, favourite } = list;
  const cursor = items[index]?.row ?? 0;
  /**
   * The live terminal width, with no floor.
   *
   * There used to be a `Math.max(60, columns - 2)` here, which made every row
   * 60 columns wide on a terminal narrower than that — so a row that fitted
   * perfectly at 100 columns wrapped into two visual rows at 58, and the list
   * looked double-spaced. It looked fine again on re-entering the screen only
   * because Ink re-measures on the next render, not because the arithmetic was
   * right. One column is left spare because a row that exactly fills the width
   * wraps on some terminals for reasons that are not worth chasing.
   *
   * A read of `process.stdout.columns` during render also goes stale: nothing
   * re-rendered on `resize`, so Ink repainted the committed tree — padded to
   * the old width — inside the new Yoga frame, and each row wrapped once on
   * the trailing column. The hook above subscribes, so a resize re-renders at
   * the true width with no keypress needed.
   */
  const cols = useTerminalWidth();
  const width = Math.max(24, cols - 1);
  // The badge columns yield before the ref does. Holding them at 14 and 16 on a
  // 44-column terminal leaves nine characters of model name and a price you
  // cannot use — the ref is the thing being chosen, so it gets the floor.
  let costW = COST_W;
  let badgeW = BADGE_W;
  const spare = width - 4 - 24;
  if (spare < costW + badgeW) {
    costW = Math.max(9, Math.floor(spare * 0.45));
    badgeW = Math.max(9, spare - costW);
  }
  // `- 5` leaves a spare column so a truncated ref never runs straight into the
  // price with no gap, which is what it looked like at 58 columns.
  const refWidth = Math.max(8, width - 5 - costW - badgeW);
  const start = Math.max(0, Math.min(cursor - 5, Math.max(0, rows.length - height)));
  const marked = items.length === 0;

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
        {rows.slice(start, start + height).map((row, i) => {
          const absolute = start + i;

          if (row.kind === "group") {
            return (
              <Box key={`g${absolute}`}>
                {/* Truncated like a row, for the same reason: a header that
                    wraps is two rows and the window counts lines. */}
                <Text dimColor wrap="truncate">
                  {`  ${row.label}${row.note ? ` — ${row.note}` : ""}`.slice(0, width)}
                </Text>
              </Box>
            );
          }
          if (row.kind === "provider") {
            // The header carries what the reader came for: which account this
            // is, and whether a credential is present at all. `opencode-go` and
            // `opencode` are different bills and look identical otherwise.
            return (
              <Box key={`p${row.provider}`}>
                <Text dimColor wrap="truncate">
                  {`  ${row.provider} · ${row.count} · ${keyed.has(row.provider) ? "key set" : "NO KEY"}`.slice(0, width)}
                </Text>
              </Box>
            );
          }

          const m = row.ref;
          const selected = absolute === cursor;
          const dead = cannotUseTools(catalogue, m, subject);
          const badge = pinging.has(m)
            ? "… pinging"
            : (probeBadge(probes, m)?.badge ?? probeHint(probes, m));
          const cost = dead ? "—" : formatCost(costOf(catalogue, m));
          const note = noteForModel(m);
          // Truncated, not wrapped: a row that spills is two rows, and the
          // window here counts lines. The full sentence is in `?`.
          const status = (badge || (note ? "· note" : "")).slice(0, badgeW - 1);
          // The whole row lights up, not just the ref. With the price and status
          // in fixed columns 60 characters away, a cursor on the ref alone left
          // the reader guessing which price belonged to which model.
          const accent = selected ? THEME.accent : undefined;
          return (
            <Box key={m}>
              {/* Marks, not colour: a monochrome terminal loses decoration and
                  nothing else. ★ is OpenCode's own list; ✗ is a verdict. Two
                  columns of two, so a row starts at the same offset whatever
                  is in them. */}
              <Text dimColor={!selected}>{favourite.has(m) ? "★ " : "  "}</Text>
              <Text color={accent}>{selected ? "❯ " : "  "}</Text>
              <Text color={accent} bold={selected} dimColor={dead && !selected} wrap="truncate">
                {pad(shorten(m, refWidth - 1), refWidth)}
              </Text>
              <Text color={accent} dimColor={!selected && !dead} wrap="truncate">{pad(cost, costW)}</Text>
              <Text color={dead ? THEME.warn : accent} dimColor={!selected && !dead} wrap="truncate">
                {pad(status, badgeW)}
              </Text>
            </Box>
          );
        })}
        {rows.length === 0 && <Text dimColor>no match</Text>}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {marked
            ? "nothing to choose"
            : `${items.length} model(s) · P replies? · T replies AND uses a tool? · A sweep · ? providers`}
        </Text>
      </Box>
      <Box>
        <Text dimColor>↑↓ choose · Enter select · Esc back</Text>
      </Box>
      {notice && (
        <Box marginTop={1}>
          <Text color={THEME.warn}>{notice}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Wrap a note to the pane, with a hanging indent.
 *
 * A provider note is a sentence or two and the pane has no scroller, so a long
 * one would wrap on its own and break the one-element-one-row rule that every
 * scrolled pane here depends on. It wraps here instead, where the indent is
 * visible.
 */
function wrapNote(text: string, width: number, indent = 4): string[] {
  const room = Math.max(20, width - indent);
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > room) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.map((l, i) => (i === 0 ? `${" ".repeat(indent)}${l}` : `${" ".repeat(indent + 2)}${l}`));
}

/**
 * The provider pane: what each provider is, and which bill it lands on.
 *
 * Answers the question the picker cannot: `opencode-go` is a subscription,
 * `opencode` is a different account that meters per token, and on this machine
 * the second one had no credit. Everything here is derived — the credential from
 * `opencode auth list`, the counts from the catalogue and the listing — except
 * the dated account notes, which no command can report.
 *
 * Built as styled lines and handed to a `Scroller` rather than drawn as boxes,
 * because it outgrows a short terminal: thirteen providers, three notes, the
 * dropped favourites and the failed pings is forty-odd rows, and a pane with no
 * scroller pushes its own `Esc back` off the bottom on a 24-row window. The hint
 * that says how to leave must never be the thing that scrolls away.
 */
function providerLines(
  listing: string[],
  catalogue: Catalogue,
  keyed: Map<string, "env" | "stored">,
  dropped: string[],
  probes: ProbeCache,
): StyledLine[] {
  const bills = allProviderBills(listing, catalogue, keyed);
  const failures = failedProbes(probes);
  const width = wrapWidth();
  const lines: StyledLine[] = [
    [{ text: "each provider, what it bills to, and whether a key is present.", dim: true }],
    [{ text: "counts are free / priced / unknown · n without tools cannot be a repo agent", dim: true }],
    [{ text: "" }],
  ];

  for (const b of bills) {
    const summary =
      `${b.billing} · ${b.listed} listed · ${b.free}f ${b.priced}p ${b.unknown}?` +
      `${b.noTools ? ` · ${b.noTools} without tools` : ""} · ` +
      `${b.keyed === null ? "NO KEY" : `key (${b.keyed})`}`;
    lines.push([
      { text: b.provider, bold: true },
      ...(b.keyed === null ? [{ text: "  ", dim: true }, { text: summary, color: THEME.warn }] : [{ text: `  ${summary}`, dim: true }]),
    ]);
    if (b.note) lines.push(...wrapNote(b.note, width).map((t) => [{ text: t, dim: true }] as StyledLine));
  }

  if (dropped.length > 0) {
    lines.push([{ text: "" }]);
    lines.push([
      { text: `★ ${dropped.length} of your OpenCode favourites cannot be reached from here`, color: THEME.warn },
    ]);
    lines.push([
      {
        text: "  OpenCode still marks these as favourites, but `opencode models` no longer",
        dim: true,
      },
    ]);
    lines.push([
      { text: "  lists them — no key, or the model is gone. Its own picker cannot offer", dim: true },
    ]);
    lines.push([{ text: "  them either, so they are left out of adv's picker too.", dim: true }]);
    for (const d of dropped) lines.push([{ text: `    ${d}`, dim: true }]);
  }

  const { tested, failed } = probeCoverage(probes);
  lines.push([{ text: "" }]);
  if (tested === 0) {
    lines.push([{ text: "no model has been pinged yet — press P on one, or A to sweep", dim: true }]);
  } else {
    lines.push([
      {
        text: `pinged ${tested} model(s) so far · ${failed} unusable · ${tested - failed} usable`,
        dim: true,
      },
    ]);
  }

  if (failures.length > 0) {
    lines.push([{ text: "" }]);
    lines.push([
      {
        text: `✗ the ${failed} that failed, out of the ${tested} pinged so far`,
        color: THEME.warn,
      },
    ]);
    lines.push([
      { text: "  this is only what has been tested — the rest of the catalogue is unknown,", dim: true },
    ]);
    lines.push([{ text: "  not known-good. A verdict goes stale: successes after a week, failures after a day.", dim: true }]);
    for (const f of failures) {
      lines.push(...wrapNote(`${f.ref} — ${f.verdict.detail}`, width).map((t) => [{ text: t, dim: true }] as StyledLine));
    }
  }

  return lines;
}

function Providers({
  listing,
  catalogue,
  keyed,
  dropped,
  probes,
  notice,
  onClose,
}: {
  listing: string[];
  catalogue: Catalogue;
  keyed: Map<string, "env" | "stored">;
  dropped: string[];
  probes: ProbeCache;
  notice: string | null;
  onClose: () => void;
}) {
  return (
    <Scroller
      title="providers"
      lines={providerLines(listing, catalogue, keyed, dropped, probes)}
      notice={notice}
      footer={[
        { text: "the picker", color: THEME.accent },
        { text: " · ↑↓ scroll · Esc back", dim: true },
      ]}
      onClose={onClose}
    />
  );
}

/**
 * The pair list: saved pairs first, then pairs past runs used, then the row that
 * saves the current two.
 *
 * Not a `Scroller`: this list is bounded and indexed, like the past-runs screen,
 * and every row is clipped to one line so the cursor arithmetic stays honest.
 */
function Pairs({
  rows,
  index,
  current,
  notice,
  loading,
}: {
  rows: PairRow[];
  index: number;
  /** The pair the settings are on, so the row it names can be marked. */
  current: PairModels | null;
  notice: string | null;
  /** The file is being read; an empty list is not yet an answer. */
  loading: boolean;
}) {
  const width = Math.max(8, useTerminalWidth() - 6);
  const height = 14;
  const start = Math.max(0, Math.min(index - 6, Math.max(0, rows.length - height)));
  const at = rows[index];

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right="pairs" />
      </Box>
      <Text dimColor>
        two models at once, under a name — the pair you used last is first
      </Text>
      <Box marginTop={1} flexDirection="column">
        {rows.slice(start, start + height).map((row, i) => {
          const absolute = start + i;
          const selected = absolute === index;
          const models = row.kind === "saved" ? row.pair : row.kind === "recent" ? row.recent : null;
          const inUse = models !== null && current !== null && pairKey(models) === pairKey(current);
          // The two models are the point of the row, so they get the space and
          // the task is clipped to what is left. One element is one row: a
          // wrapped row moves every cursor below it, which is the scroll bug the
          // panes are built to avoid.
          const fullDetail = !models
            ? ""
            : `  ${models.drafter.ref} -> ${models.reviewer.ref}` +
              (row.kind === "recent" ? `  [run ${row.recent.run}]` : "") +
              (row.kind === "saved" && row.warnings.length === 0
                ? `  [${row.pair.lastUsedAt ? "used" : "never used"}]`
                : "") +
              (row.kind === "saved" && row.warnings.length ? "  !" : "");
          // Both halves are clipped, each from its own budget: a long detail
          // alone used to push the row past the pane even with the label at
          // its ten-character floor, and a row that fills the width wraps.
          const maxDetail = Math.max(10, width - 1 - 4 - 10);
          const detail = fullDetail.length > maxDetail ? shorten(fullDetail, maxDetail) : fullDetail;
          const label =
            row.kind === "saved" ? row.pair.name : row.kind === "recent" ? row.recent.task : "save current as…";
          const room = Math.max(8, width - 4 - detail.length - 1);
          const text = label.length > room ? `${label.slice(0, room - 1)}…` : label;
          return (
            <Box key={row.key}>
              {/* Both markers in one Text: Ink drops the trailing space of a Text
                  that butts up against the next one, which would print ●❯. */}
              <Text color={inUse ? THEME.warn : undefined}>
                {`${inUse ? "●" : " "} ${selected ? "❯" : " "} `}
              </Text>
              <Text color={selected ? THEME.accent : undefined} bold={selected} wrap="truncate">
                {text}
              </Text>
              <Text dimColor wrap="truncate">
                {detail}
              </Text>
            </Box>
          );
        })}
        {loading && <Text dimColor>reading the pairs…</Text>}
        {!loading && rows.length === 1 && (
          <Text dimColor>no pairs saved, and no runs to learn one from</Text>
        )}
      </Box>
      {at && at.kind === "saved" && at.warnings.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {at.warnings.map((w) => (
            <Text key={w} color={THEME.warn}>{`! ${w}`}</Text>
          ))}
        </Box>
      )}
      {notice && (
        <Box marginTop={1}>
          <Text dimColor>{notice}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text>
          <Line
            spans={hints(
              ["Enter", "use this pair"],
              ["d", "delete"],
              ["Esc", "back"],
            )}
          />
        </Text>
      </Box>
    </Box>
  );
}

/** The name prompt. Typing is handled by the app; this draws the field. */
function PairName({ value, known }: { value: string; known: string[] }) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right="save this pair" />
      </Box>
      <Text dimColor>name it, so the next one is a keystroke away:</Text>
      <Box marginTop={1}>
        <Text inverse>{` ${value} `}</Text>
      </Box>
      {known.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>saved names:</Text>
          {known.slice(0, 8).map((n) => (
            <Text key={n} dimColor>{`  ${n}`}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text>
          <Line spans={hints(["Enter", "save"], ["Esc", "cancel"])} />
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Deleting or overwriting a pair asks first.
 *
 * The same rule run deletion follows: nothing is removed or replaced on one
 * keystroke, and the name is on the screen before `y` means anything.
 */
function ConfirmPair({
  ask,
  pair,
  onAnswer,
}: {
  ask: "delete" | "overwrite";
  pair: { name: string; drafter: ModelRef; reviewer: ModelRef };
  onAnswer: (ok: boolean) => void;
}) {
  useInput((input, key) => {
    if (input === "y" || input === "Y") onAnswer(true);
    else if (input === "n" || input === "N" || key.escape || key.return) onAnswer(false);
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right={ask === "delete" ? "delete this pair" : "replace this pair"} />
      </Box>
      <Text bold color={THEME.danger}>
        {ask === "delete" ? `delete the pair "${pair.name}"?` : `overwrite the pair "${pair.name}"?`}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>{`  ${pair.drafter.ref}`}</Text>
        <Text>{`  ${pair.reviewer.ref}`}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {ask === "delete"
            ? "the name goes; the models are still in the list of pairs runs have used"
            : "the two models stored under that name are replaced by the current two"}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Line spans={hints(["y", ask === "delete" ? "delete" : "overwrite"], ["n", "cancel"])} />
        </Text>
      </Box>
    </Box>
  );
}

/** A past run, as a row: when, what it was, where it stands. */
function Runs({
  runs,
  index,
  offset,
  height,
  tagged,
}: {
  runs: RunSummary[];
  index: number;
  /** The window's first row: the list is longer than the screen. */
  offset: number;
  height: number;
  tagged: Set<string>;
}) {
  const width = Math.max(8, useTerminalWidth() - 6);
  const window = runs.slice(offset, offset + height);
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right="past runs" />
      </Box>
      <Text dimColor>
        open one to continue it — a finished run can be revisited, a parked one finished
      </Text>
      <Box marginTop={1} flexDirection="column">
        {window.map((r, i) => {
          const at = offset + i;
          const selected = at === index;
          const marked = tagged.has(r.dir);
          const label = r.mode === "answer" ? "question" : "task";
          // The row must never exceed the pane: a row that exactly fills the
          // width wraps on some terminals, and the window counts lines — the
          // old `width - 34` guessed the prefix and overflowed by five on long
          // tasks. Measured from the real prefix, with one spare column.
          const head = `${r.name}   ${r.state.padEnd(8)}${label} · `;
          const room = Math.max(8, width - 1 - 4 - head.length);
          const text = r.task.length > room ? `${r.task.slice(0, room - 1)}…` : r.task;
          return (
            <Box key={r.dir}>
              <Text color={marked ? THEME.warn : undefined}>{marked ? "● " : "  "}</Text>
              <Text color={selected ? THEME.accent : undefined}>{selected ? "❯ " : "  "}</Text>
              <Text color={selected ? THEME.accent : undefined} bold={selected} wrap="truncate">
                {r.name}
              </Text>
              <Text color={selected ? THEME.accent : undefined} wrap="truncate">
                {"   "}
                {r.state.padEnd(8)}
              </Text>
              <Text color={selected ? THEME.accent : undefined} dimColor={!selected} wrap="truncate">
                {label} · {text}
              </Text>
            </Box>
          );
        })}
        {runs.length === 0 && (
          <Text dimColor>no runs yet — this repository has none, and no question has been asked</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {runs.length > height ? `${offset + 1}–${Math.min(runs.length, offset + height)} of ${runs.length} · ` : ""}
          ↑↓ choose · Enter open
          {tagged.size ? ` · ${tagged.size} tagged` : ""}
        </Text>
      </Box>
      <Box>
        <Text>
          <Line
            spans={hints(
              ["space", tagged.size ? "untag/tag" : "tag"],
              ["d", tagged.size ? `delete ${tagged.size}` : "delete"],
              ["D", "delete all"],
              ["a", "tag all"],
              ["A", "clear"],
              ["n", "question"],
              ["Esc", "back"],
            )}
          />
        </Text>
      </Box>
    </Box>
  );
}

/**
 * The delete confirmation.
 *
 * Nothing is removed on one keystroke: the count, the split, and each run by
 * name and task are on the screen before `y` means anything. The split matters
 * most for the questions bucket, which reaches runs asked from other
 * directories entirely.
 */
function ConfirmDelete({
  summary,
  onAnswer,
}: {
  summary: DeletionSummary;
  onAnswer: (ok: boolean) => void;
}) {
  useInput((input, key) => {
    if (input === "y" || input === "Y") onAnswer(true);
    else if (input === "n" || input === "N" || key.escape || key.return) onAnswer(false);
  });

  const total = summary.here + summary.elsewhere;
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right="delete runs" />
      </Box>
      <Text bold color={THEME.danger}>
        delete {total} run{total === 1 ? "" : "s"}?
      </Text>
      <Box marginTop={1} flexDirection="column">
        {summary.here > 0 && <Text>{`  ${summary.here} filed under this repository`}</Text>}
        {summary.elsewhere > 0 && (
          <Text color={THEME.warn}>
            {`  ${summary.elsewhere} question${summary.elsewhere === 1 ? "" : "s"}, asked from any directory`}
          </Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {summary.lines.slice(0, 8).map((line) => (
          <Text key={line.dir} dimColor>
            {"  "}
            {line.text}
          </Text>
        ))}
        {summary.lines.length > 8 && <Text dimColor>{`  … and ${summary.lines.length - 8} more`}</Text>}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          the run directories are removed for good; nothing in any repository is touched, and
          decisions already written to a repo's .adv/decisions.md stay
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Line
            spans={hints(["y", `delete ${total}`], ["n", "cancel"])}
          />
        </Text>
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
function Log({ lines, label }: { lines: StyledLine[]; label: string | null }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (label === null) return;
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, [label]);
  const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame % 10];

  return (
    <>
      {/* Already wrapped to the width: one element is one row on screen, which
          is what makes the pane's position below it a number rather than a
          guess. Ink wrapping a long log line would shift everything under it. */}
      <Static items={lines}>
        {(line, i) => <Line key={i} spans={line} />}
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

/** Wrap text to the given width, clipping to a few lines so a question fits. */
function wrapText(text: string, maxLines: number, width: number): string[] {
  const room = Math.max(8, width);
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

  const wrapW = Math.max(8, useTerminalWidth() - 4);
  const detail: string[] = [];
  for (const line of item.detail) detail.push(...wrapText(line, 2, wrapW));
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
        {wrapText(item.title, 4, wrapW).map((line, i) => (
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
    // Hand the mouse to the terminal, so plain click-drag selects text and the
    // wheel moves the scrollback. A control key, not a letter: a letter would
    // also be typed into the prompt or the model filter.
    if (key.ctrl && input === "t") {
      const next = !mouseReporting;
      process.stdout.write(next ? MOUSE_ON : MOUSE_OFF);
      setMouseAccepting(next);
      setMouseReporting(next);
      // The log is the channel that exists on every screen; the notice is the
      // one next to the pane. A toggle with no feedback is a toggle you press
      // twice to find out what it did.
      addLog(
        next
          ? "mouse: the pane scrolls with the wheel again"
          : "mouse: the terminal has it — drag to select, wheel to scroll back; Ctrl+T takes it back",
      );
      setNotice(
        next
          ? "the mouse scrolls the pane again"
          : "the mouse is the terminal's — drag to select; Ctrl+T takes it back",
      );
      return;
    }
    // Past runs, from any settled screen: hopping between runs should not cost
    // a trip home first. Left off while a model call or an approval is in
    // flight — those phases are "running"/"working", and are not in this list.
    if (
      key.ctrl &&
      input === "r" &&
      (phase === "start" || phase === "gate" || phase === "result" || phase === "error")
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
  /**
   * OpenCode's own favourites and recents, read on demand from its state file.
   *
   * A hint about which models matter, never a source of truth: `adv` does not
   * write that file, and a machine without one simply has an unstarred picker.
   */
  const [openCode, setOpenCode] = useState<{ favourites: string[]; recents: string[] }>({
    favourites: [],
    recents: [],
  });
  const [filter, setFilter] = useState("");
  const [pickIndex, setPickIndex] = useState(0);
  const [pickRole, setPickRole] = useState<"drafter" | "reviewer">("drafter");
  /**
   * What is knowable about a model without calling one, and what a call once
   * said. All three are read on demand when the picker opens: the catalogue is a
   * file OpenCode already keeps, `auth list` is free, and the probes are our own
   * record. Every one degrades to empty, which renders `?` — the honest reading,
   * and never "free".
   */
  const [catalogue, setCatalogue] = useState<Catalogue>(new Map());
  const [probes, setProbes] = useState<ProbeCache>({});
  const [authed, setAuthed] = useState<Map<string, "env" | "stored">>(new Map());
  /** Refs with a call in flight, so a row can say `…` instead of pretending. */
  const [pinging, setPinging] = useState<Set<string>>(new Set());
  /** How many models a sweep is armed for, so the count survives a re-render. */
  const [sweepArmed, setSweepArmed] = useState<number | null>(null);
  /* Saved pairs, and the runs the recent-pair rows come from. The runs are a
     separate list from the past-runs screen's: that one is a snapshot with its
     own tags and scroll, and opening pairs must not disturb it. */
  const [savedPairs, setSavedPairs] = useState<Pair[]>([]);
  const [pairRuns, setPairRuns] = useState<RunSummary[]>([]);
  const [pairIndex, setPairIndex] = useState(0);
  const [pairLoading, setPairLoading] = useState(false);
  const [pairName, setPairName] = useState("");
  const [pairAsk, setPairAsk] = useState<{ ask: "delete" | "overwrite"; pair: Pair } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Whether the app owns the mouse.
   *
   * The terminal gives the wheel to the app only if the app asks for it, and
   * while it has it the terminal will not drag-select text — the press that
   * starts a selection is the event the app asked for. So the app can hold the
   * mouse or hand it back, not both at once; `startTui` asks for it on the way
   * in, and Ctrl+T hands it over and takes it back.
   */
  const [mouseReporting, setMouseReporting] = useState(true);
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
  /**
   * Where the run on screen was opened from.
   *
   * Esc means "back", and back is not one place: a result you reached from the
   * past-runs list belongs to that list (with its tags and its scroll where you
   * left them), and one you started from the desk belongs to the desk. `n` is
   * the unconditional way to the desk, for when "back" is not what you want.
   */
  const [openedFrom, setOpenedFrom] = useState<"start" | "runs">("start");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsIndex, setRunsIndex] = useState(0);
  /**
   * The cursor, readable by a key handler mid-frame.
   *
   * Two keystrokes can be delivered before React commits — a held `space`, or
   * two presses in one read from the terminal — and both handlers then close
   * over the same `runsIndex`. Tagging and moving would read the same row
   * twice, which toggles it back off: a fast tag did nothing. Handlers read the
   * ref; the state is what draws.
   */
  const runsCursor = useRef(0);
  const [runsOffset, setRunsOffset] = useState(0);
  const [taggedRuns, setTaggedRuns] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
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
    setNotice(null);
    setPhase("settings");
    if (allModels.length === 0) {
      // The listing must resolve *before* the credential lookup: the provider
      // ids come from it, and passing the stale `[]` this closure captured made
      // every provider resolve to no match and report NO KEY.
      void listModels(repo)
        .then(async (listing) => {
          setAllModels(listing);
          setAuthed(await authedProviders(listing).catch(() => new Map()));
        })
        .catch(() => setAllModels([]));
    } else {
      void authedProviders(allModels)
        .then(setAuthed)
        .catch(() => setAuthed(new Map()));
    }
    // Re-read on every visit: favourites are marked in OpenCode, between
    // sessions, and a list frozen at launch is the wrong list by the afternoon.
    // It never throws, so this is not worth a try.
    void readOpenCodeModels().then(setOpenCode);
    // The catalogue and our own probe record do not depend on the listing, so
    // they do not wait for it. Neither throws.
    void loadCatalogue().then((r) => setCatalogue(r.catalogue));
    void loadProbes().then(setProbes);
  }

  /** The rows on the pair screen, recomputed from what is loaded. */
  const pairScreen = useMemo(
    () => pairRows(savedPairs, pairRuns, new Set(allModels)),
    [savedPairs, pairRuns, allModels],
  );
  /**
   * The name of the saved pair the current two models are, or null.
   *
   * Matched by model rather than by name: a pair renamed in the file is still
   * the pair in use, and showing nothing would read as "no pair at all".
   */
  const currentPairName = cfg ? nameForPair(savedPairs, cfg.models) : null;

  /**
   * The models a row names — and nothing else.
   *
   * A `Pair` structurally satisfies `{drafter, reviewer}` while also carrying a
   * name and two dates, and passing one straight into `Config.models` writes
   * those into the repository's config file. `pairModels` is the boundary.
   */
  function modelsOf(row: PairRow): PairModels | null {
    const source = row.kind === "saved" ? row.pair : row.kind === "recent" ? row.recent : null;
    return source ? pairModels(source) : null;
  }

  /** The current two models, as a pair-shaped object. */
  function currentModels(): PairModels | null {
    return cfg ? pairModels(cfg.models) : null;
  }

  /** Store the current two models under a name, then go back to the list. */
  async function commitPair(name: string) {
    const models = currentModels();
    if (!models) return;
    await savePair({ name, ...models });
    const pairs = await loadPairs();
    setSavedPairs(pairs);
    // The cursor follows the pair you just made, not the row that happened to be
    // under it — saving one pushes every run row down by one.
    const rows = pairRows(pairs, pairRuns, new Set(allModels));
    const at = rows.findIndex((row) => row.kind === "saved" && row.pair.name === name);
    if (at >= 0) setPairIndex(at);
    setNotice(`saved pair "${name}"`);
    setPhase("pairs");
  }

  /**
   * Use a pair: both models, saved the way a manual pick is saved — the
   * repository's `.adv/config.json` as well as the user config — and marked used,
   * which is what sorts it first next time.
   */
  async function usePair(models: PairModels, name?: string) {
    if (!cfg) return;
    await persist({ ...cfg, models }, mode);
    addLog(`pair${name ? ` "${name}"` : " from a run"} · ${models.drafter.ref} -> ${models.reviewer.ref}`);
    setSavedPairs(name ? await markPairUsed(name) : await loadPairs());
    setSettingsSel(0);
    setSaved(name ? `using pair "${name}"` : "using a pair a run used");
    setPhase("settings");
  }

  /* Settings: choose a pair, a model, or the subject. Every change is written
     to the repository's .adv/ and to the user config. */
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
        setSettingsSel((s) => Math.min(4, s + 1));
        return;
      }
      if (!key.return) return;

      if (settingsSel === 0) {
        void openPairs();
        return;
      }
      if (settingsSel === 1 || settingsSel === 2) {
        setPickRole(settingsSel === 1 ? "drafter" : "reviewer");
        setFilter("");
        setPickIndex(0);
        setPhase("pick");
        return;
      }
      if (settingsSel === 3) {
        const nextMode: Mode = mode === "plan" ? "answer" : "plan";
        setMode(nextMode);
        void persist(cfg, nextMode).then(() => setSaved(`saved mode: ${nextMode}`));
        return;
      }
      setPhase("start");
    },
    { isActive: phase === "settings" },
  );

  /**
   * The pair list: saved pairs last-used first, then pairs runs have used.
   *
   * Both are read on the way in rather than kept warm, so what is on screen is
   * what is on disk — including after another `adv`, or a hand edit.
   */
  async function openPairs() {
    setPairName("");
    setPairAsk(null);
    setNotice(null);
    setPhase("pairs");
    setPairLoading(true);
    const [pairs, runs] = await Promise.all([loadPairs(), listRuns(repo)]);
    setPairLoading(false);
    setSavedPairs(pairs);
    setPairRuns(runs);
    // The cursor opens on the pair in use, so "the last one" is where Enter
    // lands without moving anything.
    const current = currentPairKey();
    const at = pairRows(pairs, runs, new Set(allModels)).findIndex((row) => {
      const models = row.kind === "saved" ? row.pair : row.kind === "recent" ? row.recent : null;
      return models !== null && pairKey(models) === current;
    });
    setPairIndex(Math.max(0, at));
  }

  const currentPairKey = () => (cfg ? pairKey(cfg.models) : "");

  /* Pair list. Every key its footer names is answered here: Enter, `d`, Esc. */
  useInput(
    (input, key) => {
      if (key.escape) {
        setPhase("settings");
        return;
      }
      if (key.upArrow || input === "k") {
        setPairIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setPairIndex((i) => Math.min(Math.max(0, pairScreen.length - 1), i + 1));
        return;
      }
      const row = pairScreen[pairIndex];
      if (key.return) {
        if (!row) return;
        if (row.kind === "save") {
          setPairName("");
          setPhase("pairname");
          return;
        }
        void usePair(modelsOf(row)!, row.kind === "saved" ? row.pair.name : undefined);
        return;
      }
      if (input === "d") {
        if (row?.kind === "saved") {
          setPairAsk({ ask: "delete", pair: row.pair });
          setPhase("pairconfirm");
        } else if (row?.kind === "recent")
          setNotice("that pair belongs to a run — it is not stored here, and goes when the run does");
        else setNotice("this is the current two models; there is nothing saved to delete");
      }
    },
    { isActive: phase === "pairs" },
  );

  /**
   * The name prompt.
   *
   * Esc cancels back to the list rather than carrying on to settings: this
   * screen has its own parent one level in, and a stray Esc must not throw away
   * the list behind it as well.
   */
  useInput(
    (input, key) => {
      if (key.escape) {
        setPhase("pairs");
        return;
      }
      if (key.backspace || key.delete) {
        setPairName((n) => n.slice(0, -1));
        return;
      }
      if (key.return) {
        const name = pairName.trim();
        if (!name) {
          setNotice("a pair needs a name — that is how you find it again");
          return;
        }
        const existing = savedPairs.find((p) => p.name === name);
        const models = currentModels();
        if (existing) {
          if (models) {
            setPairAsk({ ask: "overwrite", pair: { ...existing, ...models } });
            setPhase("pairconfirm");
          }
          return;
        }
        void commitPair(name);
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input) setPairName((n) => n + input);
    },
    { isActive: phase === "pairname" },
  );

  /**
   * The answer to the delete/overwrite confirmation.
   *
   * The screen owns its keys while it is up, like the run deletion's, so there
   * is no handler for the phase here — two handlers on one screen is one
   * keystroke answered twice.
   */
  async function answerPairAsk(ok: boolean) {
    const ask = pairAsk;
    setPairAsk(null);
    setPhase("pairs");
    if (!ask) return;
    if (!ok) {
      setNotice(null);
      return;
    }
    if (ask.ask === "delete") {
      const gone = await deletePair(ask.pair.name);
      setSavedPairs(await loadPairs());
      setNotice(gone ? `deleted pair "${ask.pair.name}"` : `no pair called "${ask.pair.name}"`);
    } else {
      await commitPair(ask.pair.name);
      setNotice(`replaced pair "${ask.pair.name}"`);
    }
  }

  /** The model picker's rows: favourites first, then recents, then the rest. */
  const modelRows = useMemo(
    () => orderedModels(allModels, openCode.favourites, openCode.recents, filter),
    [allModels, openCode, filter],
  );

  /**
   * Ping some models, one at a time, and record each verdict as it lands.
   *
   * Sequential rather than parallel on purpose: a burst of thirty calls at a
   * rate-limited provider produces thirty rate limits and teaches the reader
   * nothing, and the cost of the queue is seconds. The cache is re-read per
   * model rather than merged at the end, so a screen left open shows progress
   * and a screen closed halfway keeps the half it got.
   */
  async function runPing(refs: string[], kind: "cheap" | "full") {
    const first = refs[0];
    if (first) {
      setPinging((s) => new Set(s).add(first));
      setNotice(`pinging ${refs.length > 1 ? `${refs.length} models` : refs[0]} (${kind})…`);
    }
    try {
      for (const ref of refs) {
        await pingModel(ref, { repo, kind });
        // Re-read rather than merge in memory: the file is the record, and a
        // screen closed halfway keeps the half it got.
        setProbes(await loadProbes());
      }
      const after = await loadProbes();
      const bad = refs.filter((r) => after[r] && after[r]!.verdict.kind !== "ok");
      setNotice(
        bad.length === 0
          ? `pinged ${refs.length}: all reachable`
          : `pinged ${refs.length}: ${bad.length} not reachable — ? for why`,
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setPinging(new Set());
    }
  }

  /**
   * `A` — ping the models a reader would actually pick.
   *
   * With a filter typed, that is every match. Without one, it is the set this
   * whole feature exists for: OpenCode's favourites, its recents, and the two
   * models currently configured. Around thirty models rather than 651, which is
   * the difference between a sweep you run and one you do not.
   *
   * **Two presses, on purpose.** Up to `SWEEP_MAX` calls is real money, and a
   * single keypress cannot tell a deliberate `A` from a slipped Shift — `P` and
   * `A` are the only way to spend calls at all, so a mis-typed one is exactly
   * what this feature promises it will not do. One call is cheap enough not to
   * ask twice; forty is not.
   *
   * Refused above `SWEEP_MAX` with the number named, because a filter of `-`
   * would otherwise spend a hundred calls on a gesture.
   */
  async function sweep() {
    const filtered = filter.trim().length > 0;
    const all = filtered
      ? modelRows.items.map((i) => i.ref)
      : [...new Set([
          ...openCode.favourites.filter((m) => modelRows.items.some((i) => i.ref === m)),
          ...openCode.recents.filter((m) => modelRows.items.some((i) => i.ref === m)),
          ...(cfg ? [cfg.models.drafter.ref, cfg.models.reviewer.ref] : []),
        ])];
    // Skip any provider with no credential, rather than keeping a list of the
    // ones that are slow or switched off. `opencode models` offers splash and
    // bionic because they are local endpoints, not because anything is listening
    // — sweeping them costs a timeout each and teaches nothing. Derived from
    // `opencode auth list`, so there is nothing here to maintain.
    const reachable = all.filter((ref) => authed.has(providerOf(ref)));
    const skipped = all.length - reachable.length;
    if (reachable.length === 0) {
      setNotice(all.length === 0 ? "nothing to ping — the list is empty" : "nothing to ping — no provider here has a key");
      return;
    }
    if (reachable.length > SWEEP_MAX) {
      setNotice(
        `${reachable.length} match "${filter}" — narrow it to ${SWEEP_MAX} or fewer, or A with no filter`,
      );
      return;
    }
    if (sweepArmed === reachable.length) {
      setSweepArmed(null);
      setNotice(null);
      await runPing(reachable, "cheap");
      return;
    }
    setSweepArmed(reachable.length);
    setNotice(
      `${reachable.length} models — press A again to ping them all` +
        `${filtered ? ` (matching "${filter}")` : " (favourites, recents, current pair)"}` +
        `${skipped ? ` · ${skipped} skipped, no key for their provider` : ""}` +
        `. Any other key cancels.`,
    );
  }

  /** The provider pane scrolls and closes itself; `Scroller` owns its keys. */
  /* Model picker. */
  useInput(
    (input, key) => {
      if (!cfg) return;
      // Items, not rows: group and provider headers are not cursor targets, and
      // indexing `rows` directly is how the cursor used to land on a header.
      const items = modelRows.items;
      const chosen = items[pickIndex]?.ref;

      if (key.escape) {
        setSweepArmed(null);
        setPhase("settings");
        return;
      }
      if (key.upArrow) {
        setSweepArmed(null);
        setPickIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSweepArmed(null);
        setPickIndex((i) => Math.min(Math.max(0, items.length - 1), i + 1));
        return;
      }
      if (key.return) {
        if (chosen) {
          const next: Config = {
            ...cfg,
            models: { ...cfg.models, [pickRole]: { ref: chosen, family: familyOf(chosen) } },
          };
          void persist(next, mode).then(() => setSaved(`saved ${pickRole}: ${chosen}`));
        }
        setSweepArmed(null);
        setPhase("settings");
        return;
      }
      // `?` before the text handling below: it is a key, not a character to filter.
      if (input === "?") {
        setSweepArmed(null);
        setPhase("providers");
        return;
      }
      // Uppercase only, deliberately. `p` as a ping key made the letter `p`
      // untypeable in the filter, and every one of the 651 refs is lowercase —
      // so the command keys take the case nothing needs.
      if (input === "P") {
        setSweepArmed(null);
        if (chosen) void runPing([chosen], "cheap");
        return;
      }
      if (input === "T") {
        setSweepArmed(null);
        if (chosen) void runPing([chosen], "full");
        return;
      }
      if (input === "A") {
        void sweep();
        return;
      }
      if (key.backspace || key.delete) {
        setSweepArmed(null);
        setNotice(null);
        setFilter(filter.slice(0, -1));
        setPickIndex(0);
        return;
      }
      if (key.ctrl || key.meta) return;
      // Mouse reports arrive as input; the filter is text, so it refuses them.
      if (input) {
        setSweepArmed(null);
        setNotice(null);
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
  /**
   * Back where this run was opened from.
   *
   * The past-runs list keeps its tags, its scroll and its own state: it is not
   * reloaded here, so going back does not undo a selection the reader made two
   * screens ago.
   */
  function goBack() {
    setPanel(null);
    setPhase(openedFrom === "runs" ? "runs" : "start");
  }

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
    setOpenedFrom("start");
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

  /**
   * The runs list is longer than the screen, so it shows a window of it — the
   * same arithmetic the panes use, because an index that can walk past the
   * visible rows is a row you cannot see you are about to delete.
   */
  const runsHeight = paneHeight(11, useTerminalRows());

  // Only while the list is the screen: otherwise a wheel notch on a result
  // would move a cursor nobody can see.
  useWheelScroll(
    (rows) => moveRuns(runsCursor.current + Math.sign(rows)),
    phase === "runs",
  );

  function moveRuns(next: number) {
    const index = Math.max(0, Math.min(runs.length - 1, next));
    runsCursor.current = index;
    setRunsIndex(index);
    setRunsOffset((offset) => {
      if (index < offset) return index;
      if (index >= offset + runsHeight) return index - runsHeight + 1;
      return clampOffset(offset, runs.length, runsHeight);
    });
  }

  /**
   * Delete the runs the confirmation named.
   *
   * The store refuses anything outside itself, so a failure here is reported
   * rather than thrown, and a partial failure still refreshes the list: what is
   * gone is gone, and the reader is told what is left.
   */
  async function deleteSelected(dirs: string[]) {
    setPendingDelete(null);
    const result = await deleteRuns(dirs);
    addLog(
      result.failed.length
        ? `deleted ${result.deleted.length} run(s); ${result.failed.length} refused: ` +
            result.failed.map((f) => `${f.dir} — ${f.error}`).join("; ")
        : `deleted ${result.deleted.length} run(s)`,
    );
    setTaggedRuns(new Set());
    const fresh = await listRuns(repo);
    setRuns(fresh);
    // Whatever was under the cursor is gone or has moved; both the ref and the
    // window start again from the top.
    runsCursor.current = Math.min(runsCursor.current, Math.max(0, fresh.length - 1));
    setRunsIndex(runsCursor.current);
    setRunsOffset(0);
    // The run on screen may be one of them: the screen is then a record of
    // something that no longer exists, and `r` would fail on a missing
    // directory. Back to the question desk rather than a stale result.
    if (head && result.deleted.includes(head.paths.dir)) {
      setHead(null);
      setTail(null);
      setGate(null);
      setRunTask("");
      addLog("the run on screen was deleted — back to the start screen");
      setPhase("start");
    }
  }

  /* Past runs: this repository's, plus every question, newest first. */
  async function openRuns() {
    setPhase("runs");
    // Any pane is on the screen we are leaving; it must not reappear when we
    // come back to a gate or a result later.
    setPanel(null);
    runsCursor.current = 0;
    setRunsIndex(0);
    setRunsOffset(0);
    setTaggedRuns(new Set());
    setPendingDelete(null);
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
    setOpenedFrom("runs");
    const p = runPaths(repo, dir);
    try {
      const state = await loadState(p);
      if (state.state === "failed") {
        const first = state.error ? state.error.split("\n")[0]! : "";
        setError(
          `that run failed${first ? ` — ${first}` : ""}.\n\n` +
            `a failed run has no finished result to continue. Esc goes back, or n starts a new one.`,
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
        // run is reachable again from where it was opened.
        addLog("leaving the gate — the run stays on disk; Ctrl+R reopens it");
        goBack();
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

  /**
   * The error screen.
   *
   * It had no handler at all: the only way off it was Ctrl+C, while its own text
   * told the reader to press Esc for the other runs. A dead end that claims a
   * key works is worse than a dead end.
   */
  useInput(
    (input, key) => {
      if (key.escape) {
        addLog("that run is on disk but cannot be continued");
        goBack();
        return;
      }
      if (input === "n" && !key.ctrl && !key.meta) {
        // Back to the question desk, with nothing of the failed run loaded.
        setHead(null);
        setTail(null);
        setGate(null);
        setRunTask("");
        setPhase("start");
        return;
      }
      if (input === "q") exit();
    },
    { isActive: phase === "error" },
  );

  /* Past-runs list input. */
  useInput(
    (input, key) => {
      if (key.upArrow) {
        moveRuns(runsCursor.current - 1);
        return;
      }
      if (key.downArrow) {
        moveRuns(runsCursor.current + 1);
        return;
      }
      if (key.pageDown || input === "f") {
        moveRuns(runsCursor.current + runsHeight);
        return;
      }
      if (key.pageUp || input === "b") {
        moveRuns(runsCursor.current - runsHeight);
        return;
      }
      if (input === "g") {
        moveRuns(0);
        return;
      }
      if (input === "G") {
        moveRuns(runs.length - 1);
        return;
      }
      if (key.return) {
        const chosen = runs[runsCursor.current];
        // The row carries its own directory: a question and a task recorded in
        // the same second share a name, and only the row knows which is which.
        if (chosen) void openRun(chosen);
        return;
      }
      if (input === " ") {
        const at = runs[runsCursor.current];
        if (at) {
          setTaggedRuns((tags) => {
            const next = new Set(tags);
            if (next.has(at.dir)) next.delete(at.dir);
            else next.add(at.dir);
            return next;
          });
          moveRuns(runsCursor.current + 1);
        }
        return;
      }
      if (input === "a") {
        setTaggedRuns(new Set(runs.map((r) => r.dir)));
        return;
      }
      if (input === "A") {
        setTaggedRuns(new Set());
        return;
      }
      if (input === "d") {
        // Tagged runs are a selection: `d` acts on it, or on the cursor when
        // there is none. The footer says which before the key is pressed.
        const dirs = taggedRuns.size
          ? [...taggedRuns]
          : runs[runsCursor.current]
            ? [runs[runsCursor.current]!.dir]
            : [];
        if (dirs.length) setPendingDelete(dirs);
        return;
      }
      if (input === "D") {
        if (runs.length) setPendingDelete(runs.map((r) => r.dir));
        return;
      }
      if (key.escape) {
        setTaggedRuns(new Set());
        setPhase("start");
        return;
      }
      if (input === "n" && !key.ctrl && !key.meta) {
        setTaggedRuns(new Set());
        setPhase("start");
      }
    },
    // While the confirmation is up, the confirmation owns the keys: it is a
    // component with its own handler, like the check approval.
    { isActive: phase === "runs" && pendingDelete === null },
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
  /* The log as rows: `!` lines keep their colour, and every line is wrapped here
     rather than by Ink — a wrapped log line would occupy two rows and shift
     everything below it, which is exactly what the pointer mapping must not
     have to guess about. */
  const logRows = useMemo(
    () =>
      fitSpans(
        log.map((line) =>
          spans(line.startsWith("!") ? { text: line, color: THEME.warn } : { text: line }),
        ),
        wrapWidth(),
      ),
    [log],
  );

  let content: ReactNode;

  if (phase === "setup") {
    content = <Setup repo={repo} selection={setupSelection} />;
  } else if (phase === "settings" && cfg) {
    content = (
      <Settings cfg={cfg} mode={mode} selection={settingsSel} saved={saved} pair={currentPairName} />
    );
  } else if (phase === "pick") {
    content = (
      <Pick
        role={pickRole}
        list={modelRows}
        filter={filter}
        index={pickIndex}
        catalogue={catalogue}
        probes={probes}
        pinging={pinging}
        keyed={new Set(authed.keys())}
        subject={mode}
        notice={notice}
      />
    );
  } else if (phase === "providers") {
    content = (
      <Providers
        listing={allModels}
        catalogue={catalogue}
        keyed={authed}
        dropped={modelRows.dropped}
        probes={probes}
        notice={notice}
        onClose={() => setPhase("pick")}
      />
    );
  } else if (phase === "pairs") {
    content = (
      <Pairs
        rows={pairScreen}
        index={pairIndex}
        current={cfg?.models ?? null}
        notice={notice}
        loading={pairLoading}
      />
    );
  } else if (phase === "pairname") {
    content = <PairName value={pairName} known={savedPairs.map((p) => p.name)} />;
  } else if (phase === "pairconfirm" && pairAsk) {
    content = <ConfirmPair ask={pairAsk.ask} pair={pairAsk.pair} onAnswer={(ok) => void answerPairAsk(ok)} />;
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
    ) : pendingDelete ? (
      <ConfirmDelete
        summary={deletionSummary(
          runs.filter((r) => pendingDelete.includes(r.dir)),
          repo,
        )}
        onAnswer={(ok) => void (ok ? deleteSelected(pendingDelete) : setPendingDelete(null))}
      />
    ) : (
      <Runs
        runs={runs}
        index={runsIndex}
        offset={runsOffset}
        height={runsHeight}
        tagged={taggedRuns}
      />
    );
  } else if (phase === "gate" && head) {
    if (panel) {
      content = (
        <Scroller
          key={`panel:${panel.title}`}
          title={panel.title}
          lines={panel.lines}
        notice={notice}
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
        notice={notice}
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
        escLabel={openedFrom === "runs" ? "Esc back to the list" : "Esc back"}
        escCloses={false}
        onEsc={goBack}
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
          <Text>
            <Line
              spans={hints(
                ["n", "new question"],
                ["Esc", openedFrom === "runs" ? "back to the list" : "back"],
                ["q", "quit"],
              )}
            />
          </Text>
        </Box>
      </Box>
    );
  } else {
    content = null;
  }

  return (
    <Box flexDirection="column">
      <Log lines={logRows} label={logLabel} />
      {content}
      {/* Which mode the mouse is in, on every screen: the two modes do
          different things with a drag, and a reader who cannot see which one
          they are in has a mouse that seems to work at random. Truncated rather
          than wrapped, so it is always exactly one row. */}
      <Box>
        {mouseReporting ? (
          <Line
            wrap="truncate"
            spans={[
              { text: "◌ mouse: the pane", dim: true },
              { text: " — the wheel scrolls it · Ctrl+T for text selection", dim: true },
            ]}
          />
        ) : (
          <Line
            wrap="truncate"
            spans={[
              { text: "◉ mouse: the terminal's", color: THEME.warn, bold: true },
              { text: " — drag to select text, wheel scrolls back · Ctrl+T takes it back", dim: true },
            ]}
          />
        )}
      </Box>
    </Box>
  );
}

export async function startTui(opts: { repo: string }): Promise<void> {
  // Without this the wheel scrolls the terminal's scrollback instead of the
  // pane, and there is no way to ask for it later: the terminal has to be told
  // before it stops handling the wheel itself.
  process.stdout.write(MOUSE_ON);
  // Written unconditionally: taking reporting away from a terminal that already
  // gave it up costs nothing, and this is the path that must not be missed.
  const handBack = () => process.stdout.write(MOUSE_OFF);
  process.once("exit", handBack);
  try {
    const app = render(<App repo={opts.repo} />);
    await app.waitUntilExit();
  } finally {
    handBack();
    process.removeListener("exit", handBack);
  }
}
