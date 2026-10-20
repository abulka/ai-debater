import { Box, Text, render, useApp, useInput } from "ink";
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
  clampIndex,
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
import { familyClash, familyOf, isReferenceRow, listModels, orderedModels, providerOf, rankModels } from "./models.ts";
import type { FilterMode, PickerView } from "./models.ts";
import { costOf, cannotUseTools, formatCostBasis, loadCatalogue, type Catalogue, type PriceBasis } from "./catalogue.ts";
import {
  countScoredBySource,
  emptyBenchmarks,
  formatResolved,
  formatTaskCost,
  isStale,
  loadScores,
  scoresFor,
  type Benchmarks,
} from "./benchmarks.ts";
import {
  acdScoreOf,
  acdTaskCostOf,
  emptyAcd,
  fetchAcd,
  formatAcdBadge,
  formatPromptCost,
  loadAcd,
  resolveAcd,
  type AcdIndex,
} from "./aicodingdaily.ts";
import { loadAAKey, saveAAKey } from "./aa-key.ts";
import { refreshAllBenchmarks, verifyAAKey } from "./artificialanalysis.ts";
import { CEILING_STEP, DEFAULT_CEILING, DEFAULT_TASK_CEILING, addFilterHistory, loadCeiling, loadDisabledProviders, loadFilterHistory, loadTaskCeiling, recordFilterUse, removeFilterHistory, roundCeiling, saveCeiling, saveDisabledProviders, saveFilterHistory, saveTaskCeiling, stepCeiling, type FilterEntry } from "./prefs.ts";
import { mouseAccepting, MOUSE_OFF, MOUSE_ON, setMouseAccepting, wheelRows } from "./mouse.ts";
import { allProviderBills, authedProviders, noteForModel, PROVIDER_NOTES, type ProviderBill } from "./providers.ts";
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
  renamePair,
  savePair,
  suggestPairName,
  type Models as PairModels,
  type Pair,
  type PairRow,
} from "./pairs.ts";
import {
  advDataRoot,
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
import { exportModelsMd } from "./export-models.ts";
import {
  altScreenEnabled,
  cappedLines,
  contentRows,
  gateDetailBudget,
  logWindow,
  LOG_MAX_ROWS,
  MIN_CONTENT_ROWS,
  filterHistoryListHeight,
  pairsListHeight,
  pickContentWants,
  pickHintAllowed,
  pickListHeight,
  providerFilterListHeight,
  runsListHeight,
  scrollerHeight,
} from "./viewport.ts";
import { copyMarkdown, copyNotice } from "./clipboard.ts";
import { buildHintText, hintWidth, wrapHintLines, type HintState } from "./hints.ts";
import type { Mode, ModelRef } from "./runner.ts";

type Phase =
  | "setup"
  | "home"
  | "start"
  | "clarify"
  | "settings"
  | "aakey"
  | "pick"
  | "providers"
  | "provfilter"
  | "filterhist"
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
  { key: "q", what: "quit (the run stays on disk — reopen it with Ctrl+R from home)" },
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

/**
 * The live terminal size. `process.stdout.columns`/`rows` are read during
 * render, so a component that measures must also re-render when they change —
 * otherwise Ink resizes Yoga and repaints the committed tree, still carrying
 * the old width, and every row padded to the old width wraps once in the new
 * one. Ink's own `resize` listener is registered first (at `render()`), so
 * Yoga is already at the new size when this notifies; the re-render lands
 * framed right. Worst case during a drag is one stale frame, immediately
 * corrected.
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
  height,
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
  /** Visible rows, from the viewport budget: the frame must fit the terminal. */
  height: number;
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
  const [offset, setOffset] = useState(0);
  // A resize changes the budget under a scrolled pane: clamp back into range
  // rather than showing rows past the end.
  useEffect(() => {
    setOffset((o) => clampOffset(o, lines.length, height));
  }, [lines.length, height]);

  useWheelScroll((rows) => by(rows));

  /** Move by rows, clamped, so the pane cannot be scrolled past either end. */
  const by = (rows: number) => setOffset((o) => clampOffset(o + rows, lines.length, height));
  const half = Math.max(1, Math.ceil(height / 2));

  useInput((input, key) => {
    // The control pairs first: Ctrl+D and Ctrl+U are how a Mac pages a document,
    // Ctrl+F and Ctrl+B match the picker's paging keys, and the swallow below
    // would otherwise eat all four.
    if (key.ctrl && input === "d") {
      by(half);
      return;
    }
    if (key.ctrl && input === "u") {
      by(-half);
      return;
    }
    if (key.ctrl && input === "f") {
      by(height);
      return;
    }
    if (key.ctrl && input === "b") {
      by(-height);
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
          {` · ↑↓ line · space/b/^F/^B page · ${escLabel}`}
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

function Home({
  selection,
  setSelection,
  notice,
  onChoose,
}: {
  selection: number;
  setSelection: (v: number | ((s: number) => number)) => void;
  notice: string | null;
  onChoose: (i: number) => void;
}) {
  useInput((input, key) => {
    if (key.upArrow) {
      setSelection((s) => (s + 4) % 5);
      return;
    }
    if (key.downArrow) {
      setSelection((s) => (s + 1) % 5);
      return;
    }
    // Ctrl+R (past runs) and Ctrl+P (settings) are answered by the app-wide
    // handler, so they work the same from every settled screen.
    if (key.ctrl || key.meta) return;
    if (key.return) {
      onChoose(selection);
      return;
    }
    if (input === "m") {
      onChoose(0);
      return;
    }
    if (input === "n") {
      onChoose(1);
      return;
    }
    if (input === "p") {
      onChoose(2);
      return;
    }
    if (input === "s") {
      onChoose(3);
      return;
    }
    if (input === "q") {
      onChoose(4);
      return;
    }
  });

  const rows: { label: string; hint: string }[] = [
    { label: "models browser", hint: "the model list — browse, ping, compare" },
    { label: "new debate", hint: "ask a question or plan a change" },
    { label: "past runs", hint: "reopen a finished or parked run" },
    { label: "settings", hint: "saved pairs · benchmarks key" },
    { label: "quit", hint: "" },
  ];

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right="home" />
      </Box>
      <Box flexDirection="column">
        {rows.map((r, i) => (
          <Box key={r.label}>
            <Text color={i === selection ? THEME.accent : undefined}>{i === selection ? "❯ " : "  "}</Text>
            <Text color={i === selection ? THEME.accent : undefined} bold={i === selection}>
              {r.label.padEnd(15)}
            </Text>
            <Text dimColor>{r.hint}</Text>
          </Box>
        ))}
      </Box>
      {notice && (
        <Box marginTop={1}>
          <Text color={THEME.warn} wrap="truncate">
            {notice}
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor wrap="truncate">
          ↑↓ move · Enter choose · m models · n new · p runs · s settings · q quit · Ctrl+C quit
        </Text>
      </Box>
    </Box>
  );
}

/**
 * A text field with a visible cursor: the character under it rides inverse,
 * and past the end a block stands in the same place. Every editable field
 * here renders through this, so the cursor looks and behaves one way — the
 * prompt, the filter, the pair name, the key — instead of each inventing it.
 */
function FieldText({ text, cursor }: { text: string; cursor: number }) {
  const cur = Math.max(0, Math.min(cursor, text.length));
  const atEnd = cur >= text.length;
  return (
    <Text>
      {text.slice(0, cur)}
      <Text inverse>{atEnd ? " " : text[cur]}</Text>
      {atEnd ? "" : text.slice(cur + 1)}
    </Text>
  );
}

function Start({
  repo,
  cfg,
  mode,
  task,
  setTask,
  deskSel,
  setDeskSel,
  notice,
  pair,
  onRun,
  onToggleMode,
  onPick,
  onPickPair,
  onSettings,
  onHome,
}: {
  repo: string;
  cfg: Config | null;
  mode: Mode;
  task: string;
  setTask: (v: string) => void;
  /** Which row the cursor is on: 0 pair · 1 drafter · 2 reviewer · 3 subject · 4 prompt. */
  deskSel: number;
  setDeskSel: (v: number | ((s: number) => number)) => void;
  notice: string | null;
  /** The name of the saved pair the current two models are, or null when unnamed. */
  pair: string | null;
  onRun: () => void;
  onToggleMode: () => void;
  onPick: (role: "drafter" | "reviewer") => void;
  onPickPair: () => void;
  onSettings: () => void;
  onHome: () => void;
}) {
  // The caret inside the prompt: the prompt outlives this screen (the draft
  // is kept across visits), so the caret clamps to the text on every render
  // rather than trusting a length from an earlier visit.
  const [caret, setCaret] = useState(task.length);
  const cur = Math.max(0, Math.min(caret, task.length));
  useInput((input, key) => {
    if (key.escape) {
      onHome();
      return;
    }
    if (key.tab) {
      onToggleMode();
      return;
    }
    // Ctrl+P, not a letter: anything typeable must stay available for the task.
    if (key.ctrl && input === "p") {
      onSettings();
      return;
    }
    // Ctrl+U clears the draft, readline-style.
    if (key.ctrl && input === "u") {
      setTask("");
      setCaret(0);
      setDeskSel(4);
      return;
    }
    // Line editing, readline-style: arrows step, ^A/^E jump. Free keys here —
    // rows move on up/down, and nothing else answers to left/right.
    if (key.ctrl && input === "a") {
      setCaret(0);
      return;
    }
    if (key.ctrl && input === "e") {
      setCaret(task.length);
      return;
    }
    if (key.leftArrow) {
      setCaret((c) => Math.max(0, Math.min(c, task.length) - 1));
      return;
    }
    if (key.rightArrow) {
      setCaret((c) => Math.min(task.length, Math.max(0, c) + 1));
      return;
    }
    if (key.upArrow) {
      setDeskSel((s) => (s + 4) % 5);
      return;
    }
    if (key.downArrow) {
      setDeskSel((s) => (s + 1) % 5);
      return;
    }
    if (key.return) {
      if (deskSel === 4) {
        if (task.trim() && cfg) onRun();
        return;
      }
      if (deskSel === 0) {
        onPickPair();
        return;
      }
      if (deskSel === 1 || deskSel === 2) {
        onPick(deskSel === 1 ? "drafter" : "reviewer");
        return;
      }
      onToggleMode();
      return;
    }
    if (key.backspace) {
      if (cur > 0) {
        setTask(task.slice(0, cur - 1) + task.slice(cur));
        setCaret(cur - 1);
      }
      setDeskSel(4);
      return;
    }
    if (key.delete) {
      if (cur < task.length) setTask(task.slice(0, cur) + task.slice(cur + 1));
      setDeskSel(4);
      return;
    }
    if (key.ctrl || key.meta) return;
    // Typing always goes to the prompt and snaps the cursor back to it, so a
    // task can never land on a row and Enter can never mean choose by accident.
    // Mouse reports arrive as input too — they must not type into the question.
    if (input && !input.startsWith("\x1b[<")) {
      setTask(task.slice(0, cur) + input + task.slice(cur));
      setCaret(cur + input.length);
      setDeskSel(4);
    }
  });

  const clash = cfg ? familyClash(cfg.models) : null;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right="new debate" />
      </Box>
      <Box>
        <Text color={deskSel === 0 ? THEME.accent : undefined}>{deskSel === 0 ? "❯ " : "  "}</Text>
        <Text color={deskSel === 0 ? THEME.accent : undefined} bold={deskSel === 0}>
          {"drafter/reviewer preset".padEnd(24)}
        </Text>
        <Text>{pair ? `current preset: ${pair}` : "—"}</Text>
      </Box>
      {/* The preset stands apart from the models it names: one blank row groups
          preset-choosing away from drafter/reviewer/subject below. */}
      <Box marginTop={1}>
        <Text color={deskSel === 1 ? THEME.accent : undefined}>{deskSel === 1 ? "❯ " : "  "}</Text>
        <Text color={deskSel === 1 ? THEME.accent : undefined} bold={deskSel === 1}>
          {"drafter ".padEnd(9)}
        </Text>
        <Text>{cfg ? `${cfg.models.drafter.ref} [${cfg.models.drafter.family}]` : "loading…"}</Text>
      </Box>
      <Box>
        <Text color={deskSel === 2 ? THEME.accent : undefined}>{deskSel === 2 ? "❯ " : "  "}</Text>
        <Text color={deskSel === 2 ? THEME.accent : undefined} bold={deskSel === 2}>
          {"reviewer".padEnd(9)}
        </Text>
        <Text>{cfg ? `${cfg.models.reviewer.ref} [${cfg.models.reviewer.family}]` : "loading…"}</Text>
      </Box>
      <Box>
        <Text color={deskSel === 3 ? THEME.accent : undefined}>{deskSel === 3 ? "❯ " : "  "}</Text>
        <Text color={deskSel === 3 ? THEME.accent : undefined} bold={deskSel === 3}>
          {"subject ".padEnd(9)}
        </Text>
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
              ? " — this repo requires different families, so Enter is blocked (↑↓ to choose models)"
              : " (fine for testing; use --strict or familyCheck: \"require\" for a trial)"}
          </Text>
        </Box>
      )}
      <Box borderStyle="round" borderColor={deskSel === 4 ? "cyan" : "gray"} paddingX={1} marginTop={1}>
        {task ? (
          <FieldText text={task} cursor={cur} />
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
      {notice && (
        <Box marginTop={1}>
          <Text color={THEME.warn} wrap="truncate">
            {notice}
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor wrap="truncate">
          Enter {deskSel === 4 ? "run" : "choose"} · ↑↓ pick a row · Tab subject · Esc home · Ctrl+R runs ·
          Ctrl+P settings · Ctrl+U clear · ^A ^E ends
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>repo {repo}</Text>
      </Box>
      <Box>
        <Text dimColor>models, criteria and decisions live in {repo}/.adv/</Text>
      </Box>
    </Box>
  );
}

function Settings({
  selection,
  saved,
  pair,
  aaKey,
}: {
  selection: number;
  saved: string | null;
  /** The name of the saved pair these two models are, or null when unnamed. */
  pair: string | null;
  /** Whether an Artificial Analysis key is stored — the picker's benchmark source. */
  aaKey: boolean;
}) {
  const rows: { label: string; value: string }[] = [
    // Matched by model, not by position: a pair saved under another name is
    // still the pair in use, and showing nothing would read as "no pair".
    { label: "edit drafter/reviewer pairs", value: `current pair: ${pair ?? "—"}` },
    {
      label: "benchmarks",
      value: aaKey ? "artificialanalysis.ai · key set" : "artificialanalysis.ai · no key — OpenRouter benchmarks",
    },
    { label: "back", value: "" },
  ];

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right="settings" />
      </Box>
      {rows.map((r, i) => (
        <Box key={r.label}>
          <Text color={i === selection ? THEME.accent : undefined}>{i === selection ? "❯ " : "  "}</Text>
          <Text color={i === selection ? THEME.accent : undefined} bold={i === selection}>
            {r.label.padEnd(28)}
          </Text>
          <Text>{r.value}</Text>
        </Box>
      ))}
      {saved && (
        <Box marginTop={1}>
          <Text color={THEME.ok}>{saved}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>↑↓ move · Enter choose · Esc home</Text>
      </Box>
    </Box>
  );
}

/** Above this a ping-all is refused by name rather than silently costing 100 calls. */
const PING_MAX = 40;

/**
 * Pause after typing that commits the filter provisionally: the reader stopped
 * to look at the narrowed list, which is the plainest proof the filter works.
 * Long enough to outlast a phrase being typed, short enough to have fired
 * before any key that leaves the visit.
 */
const FILTER_IDLE_MS = 800;

/** Fixed badge columns, so every row's status lines up. */
const BADGE_W = 16;
/**
 * The price column sizes to its content, capped. Prices vary in length
 * (`free` beside `$10.00/$50.00+1.5x`), and a fixed width either wastes the
 * ref or truncates a badge mid-text — `$10.00/$50.00+1.` was the latter.
 * Below 8 the `price` label does not fit; past 20 the catalogue is wrong,
 * not the column.
 */
const COST_MIN_W = 8;
const COST_MAX_W = 20;
/**
 * The benchmark column. 14 fits `I100 C100 A100` without truncating a digit;
 * `formatBenchmarks` rounds so a typical row reads `I56 C78 A62`. Yields
 * before the ref does, and vanishes entirely below ~70 columns.
 */
const BENCH_W = 14;
/** Measured $/task, e.g. `$0.17`. Yields after the benchmarks, before the ref. */
const TASK_W = 8;
/**
 * AI Coding Daily's score, e.g. `D68`. Its own column beside the score —
 * never appended to it: two scales in one cell read as one number. Yields
 * with `ACD $/task` as a unit (below), before the score does.
 */
const ACD_W = 9;
/**
 * AI Coding Daily's measured $/task, e.g. `$0.79` — the same concept as
 * `$/task` (measured dollars per benchmark task), measured on their 4-project
 * coding suite instead of the Intelligence Index. Its own column, next to the
 * `ACD` one: the pair is visibly one source. Blank on all but ~40 rows.
 */
const PROMPT_W = 10;

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
  pickMode,
  list,
  filter,
  filterCaret,
  filterMode,
  index,
  height,
  pickStart,
  catalogue,
  probes,
  benchmarks,
  acd,
  rankAcd,
  rankCost,
  buildStep,
  view,
  hideUnscored,
  ceiling,
  pinging,
  keyed,
  subject,
  notice,
  providerLock,
  disabledCount,
  aaKey,
  priceBasis,
  taskCeiling,
  hintLines,
}: {
  role: "drafter" | "reviewer";
  /** Browse: Enter does nothing, Esc goes home. Select: Enter assigns, Esc returns to the debate screen. */
  pickMode: "browse" | "select" | "build";
  list: ReturnType<typeof orderedModels>;
  filter: string;
  /** The caret inside the filter, clamped to it where it renders. */
  filterCaret: number;
  /** AND needs every filter word; OR needs any one; OFF ignores the text. Tab cycles. */
  filterMode: FilterMode;
  index: number;
  /** Visible model rows, from the viewport budget: the frame must fit the terminal. */
  height: number;
  /** Where the picker's window starts, reported back — what `Y` means by "visible". */
  pickStart: { current: number };
  catalogue: Catalogue;
  probes: ProbeCache;
  benchmarks: Benchmarks;
  /** AI Coding Daily's coding leaderboard, resolved per row beside the AA indices. */
  acd: AcdIndex;
  view: PickerView;
  hideUnscored: boolean;
  ceiling: number;
  pinging: Set<string>;
  keyed: Set<string>;
  subject: Mode;
  notice: string | null;
  /** The provider the list is locked to, or null for every provider. */
  providerLock: string | null;
  /** Providers switched off on the `F` screen — the count line says how many. */
  disabledCount: number;
  /** Whether an Artificial Analysis key is stored — without one the scores are OpenRouter-only. */
  aaKey: boolean;
  /**
   * Rank the flat views by AI Coding Daily (`D`): points for the order,
   * ACD $/task for the taskcost ceiling. Session-only. Inert in the provider
   * view, which is grouped rather than ranked.
   */
  rankAcd: boolean;
  /**
   * Rank the flat views by measured cost (`S`) instead of by score.
   * Session-only. Inert in the provider view, which is grouped, not ranked.
   */
  rankCost: boolean;
  /** Which half of a hand-built pair this pick is: the drafter first, then the reviewer. */
  buildStep: "drafter" | "reviewer" | null;
  /** Which tier of a tiered price the rows show: base (`low`) or the above-threshold price (`high`). */
  priceBasis: PriceBasis;
  /** Measured $/task ceiling for the taskcost view's count line. */
  taskCeiling: number;
  /**
   * The hint rows, wrapped to the terminal width by the App (see `hints.ts`).
   * Rendered as-is: each element is one row. Uncapped — narrow terminals show
   * every row; only a terminal too short for menu plus 3 list rows crops the
   * tail, marked with `…`.
   */
  hintLines: string[];
}) {  const { rows, items, favourite } = list;
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
  // The ACD pair yields first of all: newest, blank on all but ~40 rows, and
  // one source reads as one block. Intelligence yields second, $/task third —
  // a missing column never misleads while a missing ref would. The ping badge
  // never yields: it is the narrowest signal on the row. Below ~70 columns
  // the numbers are gone rather than the ref.
  //
  // Column order on screen: price, intelligence (I/C/A badges), $/task,
  // ACD score, ACD $/task, ping. Costs and scores read left to right in the
  // order the count line names them; the ping badge rides last, next to no
  // number it could collide with.
  //
  // The $/task column shows on every view, not just taskcost: it was blank
  // noise there once, but a measured cost that vanishes outside one view is
  // a cost the reader stops trusting. AA rows carry one; the rest are blank.
  //
  // Price sizes to the longest cell on screen: a fixed width truncates
  // `$10.00/$50.00+1.5x` mid-badge, and padding to a constant wastes the ref
  // when every price is short.
  const needCost = items.reduce(
    (m, i) => Math.max(m, formatCostBasis(costOf(catalogue, i.ref), priceBasis).length),
    0,
  );
  let costW = Math.min(COST_MAX_W, Math.max(COST_MIN_W, needCost));
  let badgeW = BADGE_W;
  let benchW = BENCH_W;
  let taskW = TASK_W;
  let acdW = ACD_W;
  let promptW = PROMPT_W;
  // Every column boundary carries a single space (two after the price, which
  // was the first crammed boundary and keeps its wider gap): an exact-fill
  // cell otherwise touches the next column, and `pad` leaves no gap at exact
  // fill — that was the `prompt $ping` collision. The header below carries
  // the same separators, so labels always sit over their column.
  //
  // Yield order, narrowest first: the ACD pair as a unit (blank on all but
  // ~40 rows, and one source reads as one block), then intelligence, then
  // $/task — a missing column never misleads while a missing ref would. The
  // ping badge never yields: it is the narrowest signal on the row.
  const spare = width - 4 - 24;
  if (spare < costW + badgeW + benchW + taskW + acdW + promptW) {
    acdW = 0;
    promptW = 0;
  }
  if (spare < costW + badgeW + benchW + taskW) benchW = 0;
  if (spare < costW + badgeW + taskW) taskW = 0;
  if (spare < costW + badgeW) {
    costW = Math.max(9, Math.floor(spare * 0.45));
    badgeW = Math.max(9, spare - costW);
  }
  // The ping column is always last, so every column before it always has a
  // cell after it: a shown column always carries its separator, and a dropped
  // one simply isn't there. No trailing space is ever emitted.
  const sepBench = benchW > 0 ? 1 : 0;
  const sepTask = taskW > 0 ? 1 : 0;
  const sepAcd = acdW > 0 ? 1 : 0;
  const sepPrompt = promptW > 0 ? 1 : 0;
  /**
   * The ranking's column, for the header highlight. Score order ranks on the
   * score — AA's index, or ACD points with `D` — and cost order (`S`, every
   * flat view) ranks on the measured cost instead: $/task, or ACD $/task with
   * `D`. The other columns are filters, never the order; the provider view is
   * grouped, not ranked, so nothing highlights there.
   */
  const costRank = rankCost && view !== "provider";
  const sortCol: "score" | "acd" | "task" | "prompt" | null =
    view === "provider" ? null : costRank ? (rankAcd ? "prompt" : "task") : rankAcd ? "acd" : "score";
  // `- 7` leaves the leading four plus the two-space structural gap after the
  // price; every other boundary adds its own single space above.
  const refWidth = Math.max(
    8,
    width - 7 - costW - badgeW - benchW - taskW - acdW - promptW - sepBench - sepTask - sepAcd - sepPrompt,
  );
  // The window is sticky: it stays put until the cursor would leave it, then
  // follows — down pins the cursor to the last line, and reversing back up
  // walks the cursor through the visible rows to the top before the window
  // moves again. A pure function of the cursor cannot do this: without memory
  // of where the window was, it cannot know which way the cursor came from.
  // The ref holds the previous render's answer, clamped into range first so a
  // narrowed list or a resized terminal can never strand it past the end.
  const startRef = useRef(0);
  const maxStart = Math.max(0, rows.length - height);
  const prev = Math.min(Math.max(0, startRef.current), maxStart);
  const start =
    cursor < prev ? cursor : cursor >= prev + height ? Math.min(cursor - height + 1, maxStart) : prev;
  startRef.current = start;
  // Report the window back, so `Y` can export just what is on screen. An
  // effect, not a render write: the render stays pure and the ref is fresh
  // for any keypress handled after the commit.
  useEffect(() => {
    pickStart.current = start;
  }, [start, pickStart]);
  const marked = items.length === 0;
  // Counted over the view's own items, so the number stays true when the
  // filter, the view, or H narrows what is on screen. Split by source when
  // Artificial Analysis is in the merge, so a screen mixing two sources says so.
  const split = countScoredBySource(
    items.map((i) => i.ref),
    catalogue,
    benchmarks,
  );
  // In the taskcost view the scored count is the wrong denominator — most
  // scored rows have no measured task — so the line says how many do. With
  // `D` the measurement is ACD $/task, not AA $/task; the same switch as the
  // ranking, so two task definitions never share the count.
  const measured =
    view === "taskcost"
      ? items.filter(
          (i) =>
            (rankAcd
              ? resolveAcd(catalogue, acd, i.ref)?.costPerPrompt
              : scoresFor(catalogue, benchmarks, i.ref)?.taskCost) !== undefined,
        ).length
      : 0;
  // With `D` the AA/OpenRouter split is the wrong denominator too — the view
  // ranks by ACD — so the line counts ACD-ranked rows instead.
  const rankedAcd = rankAcd && view !== "provider"
    ? items.filter((i) => resolveAcd(catalogue, acd, i.ref) !== null).length
    : 0;
  // The ranking, in words: the dimension (`S`) and the source (`D`) compose,
  // and the header highlight alone cannot say both.
  const rankText =
    view === "provider"
      ? null
      : costRank && rankAcd
        ? " · rank: ACD $/task"
        : costRank
          ? " · rank: $/task"
          : rankAcd
            ? " · rank: AI Coding Daily"
            : null;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header
          right={
            pickMode === "browse"
              ? "models browser"
              : pickMode === "build"
                ? buildStep === "reviewer"
                  ? "pick reviewer — new pair 2/2"
                  : "pick drafter — new pair 1/2"
                : `pick ${role}`
          }
        />
      </Box>
      <Box>
        {/* AND is the default and stays unmarked; `or` or `off` appears only
            when Tab has left the default, so the marker always means
            something. */}
        <Text dimColor>{filterMode === "and" ? "filter  " : `filter ${filterMode}  `}</Text>
        {filter ? (
          <FieldText text={filter} cursor={filterCaret} />
        ) : (
          <Text>
            <Text dimColor>type to filter…</Text>
            <Text inverse> </Text>
          </Text>
        )}
      </Box>
      <Box marginTop={1}>
        {/* Column labels, in the rows' own widths — positional columns with no
            header is how a $/task figure stopped meaning anything. Skips the
            columns the width yielded, exactly as the rows below do, so the
            labels always sit over their column. The ranking's column rides in
            purple — the score, or the measured cost with `S` — so the sort
            reads apart from the cyan chrome and the yellow reference rows;
            the count line still names it in words, so a monochrome terminal
            loses nothing. */}
        <Line
          wrap="truncate"
          spans={[
            { text: " ".repeat(4) + pad("model", refWidth) + pad("price", costW) + "  ", dim: true },
            ...(benchW > 0
              ? [
                  {
                    text: pad("intelligence", benchW) + (sepBench ? " " : ""),
                    ...(sortCol === "score" ? { color: THEME.sort } : { dim: true }),
                  } as const,
                ]
              : []),
            ...(taskW > 0
              ? [
                  {
                    text: pad("$/task", taskW) + " ",
                    ...(sortCol === "task" ? { color: THEME.sort } : { dim: true }),
                  } as const,
                ]
              : []),
            ...(acdW > 0
              ? [
                  {
                    text: pad("ACD score", acdW) + (sepAcd ? " " : ""),
                    ...(sortCol === "acd" ? { color: THEME.sort } : { dim: true }),
                  } as const,
                ]
              : []),
            ...(promptW > 0
              ? [
                  {
                    text: pad("ACD $/task", promptW) + (sepPrompt ? " " : ""),
                    ...(sortCol === "prompt" ? { color: THEME.sort } : { dim: true }),
                  } as const,
                ]
              : []),
            { text: pad("ping", badgeW), dim: true },
          ]}
        />
      </Box>
      <Box flexDirection="column">
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
          const cost = dead ? "—" : formatCostBasis(costOf(catalogue, m), priceBasis);
          // Benchmarks are context, not a verdict: no colour encodes a score,
          // and the `≈` marks a match that needed normalisation. Blank on most
          // rows, which is why the column vanishes before the ref does.
          const bench = benchW > 0 ? formatResolved(scoresFor(catalogue, benchmarks, m)) : "";
          // AI Coding Daily's score in its own column: appending `D68` to the
          // score read as one number on a different scale. Blank on all but
          // ~40 rows — the ACD pair yields as a unit when narrow.
          const dbadge = acdW > 0 ? formatAcdBadge(resolveAcd(catalogue, acd, m)) : "";
          // Measured $/task, AA rows only. Blank means unmeasured, never free —
          // an OpenRouter row never has one, however cheap its list price.
          const task = taskW > 0 ? formatTaskCost(scoresFor(catalogue, benchmarks, m)?.taskCost) : "";
          // Measured $/task on AI Coding Daily's suite — the same concept as
          // $/task (measured dollars per benchmark task), measured on different
          // tasks. The taskcost view filters on one or the other (`D`
          // switches), never both.
          const prompt = promptW > 0 ? formatPromptCost(resolveAcd(catalogue, acd, m)?.costPerPrompt) : "";
          const note = noteForModel(m);
          // Truncated, not wrapped: a row that spills is two rows, and the
          // window here counts lines. The full sentence is in `?`.
          const status = (badge || (note ? "· note" : "")).slice(0, badgeW - 1);
          // The whole row lights up, not just the ref. With the price and status
          // in fixed columns 60 characters away, a cursor on the ref alone left
          // the reader guessing which price belonged to which model.
          // Reference rows light up yellow instead: DeepSeek V4.1 Flash is the
          // reader's pinned comparison line, so it reads at a glance. The
          // cursor keeps its own colour — selection beats reference — and the
          // name on the row still says what it is, so monochrome loses nothing.
          const anchor = !selected && isReferenceRow(m);
          const accent = selected ? THEME.accent : anchor ? THEME.warn : undefined;
          const dimmed = !selected && !anchor;
          return (
            <Box key={m}>
              {/* Marks, not colour: a monochrome terminal loses decoration and
                  nothing else. ★ is OpenCode's own list; ✗ is a verdict. Two
                  columns of two, so a row starts at the same offset whatever
                  is in them. */}
              <Text dimColor={!selected}>{favourite.has(m) ? "★ " : "  "}</Text>
              <Text color={accent}>{selected ? "❯ " : "  "}</Text>
              <Text color={accent} bold={selected} dimColor={dead && !selected && !anchor} wrap="truncate">
                {pad(shorten(m, refWidth - 1), refWidth)}
              </Text>
              <Text color={accent} dimColor={dimmed && !dead} wrap="truncate">{pad(cost, costW)}</Text>
              {/* The gap the badge cannot eat: `pad` leaves none when the cell
                  is exactly full, which a `+1.5x` price is. Two spaces —
                  everything reads crammed at one. */}
              <Text>{"  "}</Text>
              {benchW > 0 && (
                <>
                  <Text color={accent} dimColor={dimmed} wrap="truncate">
                    {pad(bench, benchW)}
                  </Text>
                  {/* Every boundary carries its space, in rows exactly as in
                      the header: without it an exact-fill cell touches the
                      next column — the old `prompt $ping` collision. */}
                  <Text> </Text>
                </>
              )}
              {taskW > 0 && (
                <>
                  <Text color={accent} dimColor={dimmed} wrap="truncate">
                    {pad(task, taskW)}
                  </Text>
                  <Text> </Text>
                </>
              )}
              {acdW > 0 && (
                <>
                  <Text color={accent} dimColor={dimmed} wrap="truncate">
                    {pad(dbadge, acdW)}
                  </Text>
                  {sepAcd && <Text> </Text>}
                </>
              )}
              {promptW > 0 && (
                <>
                  <Text color={accent} dimColor={dimmed} wrap="truncate">
                    {pad(prompt, promptW)}
                  </Text>
                  {sepPrompt && <Text> </Text>}
                </>
              )}
              <Text color={dead ? THEME.warn : accent} dimColor={!selected && !dead && !anchor} wrap="truncate">
                {pad(status, badgeW)}
              </Text>
            </Box>
          );
        })}
        {rows.length === 0 && <Text dimColor>no match</Text>}
      </Box>
      <Box marginTop={1}>
        {/* Truncated, not wrapped: these lines are the content's chrome, counted
            as one row each by the viewport budget, and a wrap would take a row
            from the list. The view rides in the accent colour: it is the mode,
            and the mode should read at a glance. */}
        <Line
          wrap="truncate"
          spans={
            marked
              ? [{ text: "nothing to choose", dim: true }]
              : [
                  {
                    text:
                      `${items.length} model(s) · ${index + 1} of ${items.length}` +
                      (rankAcd && view !== "provider"
                        ? ` · ${rankedAcd} ranked with AI Coding Daily`
                        : ` · ${split.total} scored` +
                          `${split.aa > 0 ? ` (${split.aa} Artificial Analysis + ${split.openrouter} OpenRouter)` : ""}`) +
                      `${view === "taskcost" ? ` · ${measured} with ${rankAcd ? "ACD task cost" : "task cost"}` : ""} · `,
                    dim: true,
                  },
                  { text: `view: ${view}`, color: THEME.accent },
                  // Its own span, with its own leading separator: folded into
                  // the view span it read `view: intelligencerank: …`.
                  ...(rankText ? [{ text: rankText, color: THEME.accent } as const] : []),
                  {
                    text:
                      `${providerLock ? ` · locked to: ${providerLock}` : ""}` +
                      `${disabledCount > 0 ? ` · ${disabledCount} provider${disabledCount === 1 ? "" : "s"} off (F)` : ""}` +
                      `${view === "value" ? ` ≤ $${ceiling.toFixed(2)}` : ""}` +
                      `${view === "taskcost" ? ` ≤ $${taskCeiling.toFixed(2)}/task${rankAcd ? " (ACD)" : ""}` : ""}` +
                      `${priceBasis === "high" ? " · price: high tier" : ""}` +
                      `${hideUnscored ? " · hiding unscored" : ""}` +
                      `${!aaKey ? " · OpenRouter scores only — key: settings → benchmarks" : ""}`,
                    dim: true,
                  },
                ]
          }
        />
      </Box>
      {/* The hints, wrapped to the width by the App: one element is one row,
          and a last-resort cut carries `…` (see `hints.ts`). Uncapped — a
          narrow terminal shows every row, paid for by the log window first. */}
      {hintLines.map((line, i) => (
        <Box key={i}>
          <Text dimColor wrap="truncate">
            {line}
          </Text>
        </Box>
      ))}
      {notice && (
        <Box marginTop={1}>
          {/* One row, like the count and hints: the budget counts it as one, and
              an armed ping-all names its models, which does not fit everywhere. */}
          <Text color={THEME.warn} wrap="truncate">
            {notice}
          </Text>
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
    [{ text: "★ OpenCode favourite · ❯ cursor · ✓ reachable (T: reached for a tool) · ✗ failed", dim: true }],
    [{ text: "P to test a model · T to test with a tool · A pings every model shown", dim: true }],
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
  lines.push([
    {
      text: "I intelligence · C coding · A agentic — Artificial Analysis indices, relayed keyless via OpenRouter (attribution: artificialanalysis.ai).",
      dim: true,
    },
  ]);
  lines.push([
    {
      text: "V cycles provider · intelligence · value (cheap per output token, under the ceiling) · taskcost (cheap per measured task, under its own ceiling). < > move the ceiling of the cheap view on screen.",
      dim: true,
    },
  ]);
  lines.push([
    {
      text: "C toggles the price basis: low shows the base price, high the above-threshold price a long session pays. The value view filters on the shown price.",
      dim: true,
    },
  ]);
  lines.push([
    {
      text: "task $ is measured dollars per Intelligence Index task — verbosity and the tokenizer baked in, AA rows only. OpenRouter rows never have one.",
      dim: true,
    },
  ]);
  lines.push([
    {
      text: "D is AI Coding Daily's coding leaderboard (max 70, best effort per model) — real agent harnesses on multi-file projects, a different scale from I/C/A, in its own column beside the score.",
      dim: true,
    },
  ]);
  lines.push([
    {
      text: "ACD $/task is their measured cost per task on that 4-project coding suite — the same concept as task $, measured on different tasks. The taskcost view filters on one or the other (D switches), never both.",
      dim: true,
    },
  ]);
  lines.push([
    {
      text: "D ranks the flat views by AI Coding Daily — points for the order, ACD $/task for the taskcost ceiling — instead of Artificial Analysis. Session-only; ignored in the provider view, which is grouped rather than ranked.",
      dim: true,
    },
  ]);
  lines.push([
    {
      text: "S ranks the flat views by measured cost — $/task, or ACD $/task with D — cheapest first, unmeasured trailing. Session-only; ignored in the provider view, which is grouped rather than ranked.",
      dim: true,
    },
  ]);
  lines.push([
    {
      text: "type to filter — pausing, moving through the list, or any command key records it · Tab cycles AND (every word), OR (any word), OFF (text kept, ignored) · \"…\" quotes an ordered phrase — \"deep 4.1\" lands on deepseek-v4.1-flash · ←→ steps the caret inside the filter · ^A ^E jump to its ends · R keeps this filter and opens its history · Esc leaves the picker",
      dim: true,
    },
  ]);
  lines.push([
    {
      text: "Y exports the table — the whole shown table, or just the visible window. Nothing here spends a model call.",
      dim: true,
    },
  ]);
  lines.push([
    {
      text: "the purple column header is the ranking — intelligence (ACD score with D), or the measured cost with S ($/task, ACD $/task with D). Price and the ceilings are filters (the count line names them), never the order.",
      dim: true,
    },
  ]);
  lines.push([
    {
      text: "DeepSeek V4.1 Flash rows read yellow — a pinned reference for comparing the rest. The cursor keeps its own colour; the name on the row still says what it is.",
      dim: true,
    },
  ]);
  lines.push([
    {
      text: "a price ending +Nx jumps to Nx past its long-context threshold — Haiku 5.5 is $0.10/$0.50 to 100k tokens, then $0.50/$2.50. The Y export lists both.",
      dim: true,
    },
  ]);
  lines.push([
    {
      text: "on the high basis the cell shows the above-threshold price instead, still marked + — a model that reads $0.50/$2.50+ never bills its base price to a long session.",
      dim: true,
    },
  ]);
  lines.push([
    {
      text: "≈ needed normalising to match and is the weaker claim. A date is the fetch, not the measurement.",
      dim: true,
    },
  ]);
  if (tested === 0) {
    lines.push([{ text: "no model has been pinged yet — press P on one, or A to ping every model shown", dim: true }]);
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
  height,
  onClose,
}: {
  listing: string[];
  catalogue: Catalogue;
  keyed: Map<string, "env" | "stored">;
  dropped: string[];
  probes: ProbeCache;
  notice: string | null;
  /** Visible rows, from the viewport budget: the frame must fit the terminal. */
  height: number;
  onClose: () => void;
}) {
  return (
    <Scroller
      title="providers"
      lines={providerLines(listing, catalogue, keyed, dropped, probes)}
      notice={notice}
      height={height}
      footer={[
        { text: "the picker", color: THEME.accent },
        { text: " · ↑↓ scroll · Esc back", dim: true },
      ]}
      onClose={onClose}
    />
  );
}

/**
 * The provider switchboard: every provider in the listing with its model
 * count, billing and key status, and a checkbox for whether the picker
 * shows it. Space toggles one, `a` switches everything back on, `o`
 * switches everything off, Esc returns to the picker — which re-filters
 * behind it in every view.
 *
 * Not a `Scroller`: this list is bounded (a dozen providers) and indexed
 * like the pair list, and every row is clipped to one line so the cursor
 * arithmetic stays honest. `?` stays the read-only explainer; this is the
 * interactive one next to it.
 */
function ProviderFilter({
  bills,
  disabled,
  index,
  height,
  notice,
}: {
  bills: ProviderBill[];
  /** Provider ids the picker hides. May name providers no longer listed — those simply match no row. */
  disabled: ReadonlySet<string>;
  index: number;
  /** Visible rows, from the viewport budget: the frame must fit the terminal. */
  height: number;
  notice: string | null;
}) {
  const width = Math.max(8, useTerminalWidth() - 6);
  // Sticky like the picker: the window holds while the cursor walks its rows,
  // and follows only at an edge.
  const startRef = useRef(0);
  const maxStart = Math.max(0, bills.length - height);
  const prev = Math.min(Math.max(0, startRef.current), maxStart);
  const start =
    index < prev ? index : index >= prev + height ? Math.min(index - height + 1, maxStart) : prev;
  startRef.current = start;
  const onCount = bills.filter((b) => !disabled.has(b.provider)).length;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right="providers on/off" />
      </Box>
      <Text dimColor>
        {`space toggles a provider — ${onCount} of ${bills.length} on, in every view`}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {bills.slice(start, start + height).map((b, i) => {
          const absolute = start + i;
          const selected = absolute === index;
          const off = disabled.has(b.provider);
          const detail =
            `  ${b.listed} model${b.listed === 1 ? "" : "s"} · ${b.billing}` +
            `${b.keyed === null ? " · NO KEY" : ` · key (${b.keyed})`}`;
          const maxDetail = Math.max(10, width - 1 - 4 - b.provider.length);
          const clipped = detail.length > maxDetail ? shorten(detail, maxDetail) : detail;
          return (
            <Box key={b.provider}>
              <Text color={selected ? THEME.accent : undefined}>
                {`${selected ? "❯" : " "} [${off ? " " : "x"}] `}
              </Text>
              <Text
                color={selected ? THEME.accent : undefined}
                bold={selected}
                dimColor={!selected && off}
                wrap="truncate"
              >
                {b.provider}
              </Text>
              <Text dimColor wrap="truncate">
                {clipped}
              </Text>
            </Box>
          );
        })}
        {bills.length === 0 && <Text dimColor>no providers listed</Text>}
      </Box>
      {notice && (
        <Box marginTop={1}>
          <Text dimColor>{notice}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text>
          <Line spans={hints(["space", "toggle"], ["a", "all on"], ["o", "all off"], ["Esc", "back"])} />
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Past filters: every filter a picker was left with, newest first.
 *
 * Not a `Scroller`: the list is bounded (thirty rows at most) and indexed
 * like the provider switchboard, and every row is clipped to one line so the
 * cursor arithmetic stays honest. Applying restores the text and its AND/OR
 * mode — the view, the lock and the ceilings are separate lenses and stay
 * where they are.
 */
function FilterHistory({
  entries,
  index,
  height,
  notice,
}: {
  entries: FilterEntry[];
  index: number;
  /** Visible rows, from the viewport budget: the frame must fit the terminal. */
  height: number;
  notice: string | null;
}) {
  const width = Math.max(8, useTerminalWidth() - 6);
  // Sticky like the picker: the window holds while the cursor walks its rows,
  // and follows only at an edge.
  const startRef = useRef(0);
  const maxStart = Math.max(0, entries.length - height);
  const prev = Math.min(Math.max(0, startRef.current), maxStart);
  const start =
    index < prev ? index : index >= prev + height ? Math.min(index - height + 1, maxStart) : prev;
  startRef.current = start;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right="filter history" />
      </Box>
      <Text dimColor>
        {entries.length === 0
          ? "no filters yet — narrow the list and it lands here"
          : `${entries.length} filter${entries.length === 1 ? "" : "s"} · newest first`}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {entries.slice(start, start + height).map((e, i) => {
          const absolute = start + i;
          const selected = absolute === index;
          // AND is the default and stays unmarked; `or` appears only when the
          // mode left the default, so the marker always means something.
          const modeMark = e.mode === "and" ? "" : ` · ${e.mode}`;
          const row = `${e.text}${modeMark}`;
          const clipped = row.length > width - 2 ? shorten(row, width - 2) : row;
          return (
            <Box key={`${e.text.toLowerCase()}${modeMark}`}>
              <Text color={selected ? THEME.accent : undefined}>{selected ? "❯ " : "  "}</Text>
              <Text
                color={selected ? THEME.accent : undefined}
                bold={selected}
                wrap="truncate"
              >
                {clipped}
              </Text>
            </Box>
          );
        })}
      </Box>
      {notice && (
        <Box marginTop={1}>
          <Text dimColor>{notice}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text>
          <Line
            spans={hints(
              ["↑↓", "choose"],
              ["Enter", "apply"],
              ["d", "remove"],
              ["D", "clear all"],
              ["Esc", "back"],
            )}
          />
        </Text>
      </Box>
    </Box>
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
  height,
  current,
  currentLine,
  scope,
  notice,
  loading,
}: {
  rows: PairRow[];
  index: number;
  /** Visible rows, from the viewport budget: the frame must fit the terminal. */
  height: number;
  /** The pair in use, so the row it names can be marked. */
  current: PairModels | null;
  /** The two models on the debate screen, as text — what "save current as…" names. */
  currentLine: string | null;
  /** Managing (settings): everything. Choosing (debate): saved presets only. */
  scope: "manage" | "preset";
  notice: string | null;
  /** The file is being read; an empty list is not yet an answer. */
  loading: boolean;
}) {
  const width = Math.max(8, useTerminalWidth() - 6);
  const visible = rows;
  // Sticky like the picker: the window holds while the cursor walks its rows,
  // and follows only at an edge — down pins to the last line, up to the top.
  const startRef = useRef(0);
  const maxStart = Math.max(0, visible.length - height);
  const prev = Math.min(Math.max(0, startRef.current), maxStart);
  const start =
    index < prev ? index : index >= prev + height ? Math.min(index - height + 1, maxStart) : prev;
  startRef.current = start;
  const at = visible[index];

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right={scope === "preset" ? "drafter/reviewer preset" : "drafter/reviewer pairs"} />
      </Box>
      <Text dimColor>
        {scope === "preset"
          ? "choose a saved preset — creating and deleting live in settings"
          : "two models at once, under a name — the pair you used last is first"}
      </Text>
      {scope === "manage" && currentLine && (
        <Box marginTop={1}>
          <Text dimColor>
            current <Text>{currentLine}</Text>
          </Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        {visible.slice(start, start + height).map((row, i) => {
          const absolute = start + i;
          const selected = absolute === index;
          // A grouping gap is a blank row, nothing more: the cursor never
          // rests on it (the handlers skip gaps), so it is never selected.
          if (row.kind === "gap") return <Box key={row.key} height={1} />;
          const models = row.kind === "saved" ? row.pair : row.kind === "recent" ? row.recent : null;
          const inUse = models !== null && current !== null && pairKey(models) === pairKey(current);
          // The two models are the point of the row, so they get the space and
          // the task is clipped to what is left. One element is one row: a
          // wrapped row moves every cursor below it, which is the scroll bug the
          // panes are built to avoid.
          const fullDetail =
            row.kind === "new"
              ? "  pick a drafter and a reviewer, then name it"
              : row.kind === "save"
                ? currentLine
                  ? `  the current two — ${currentLine}`
                  : ""
                : `  ${models!.drafter.ref} -> ${models!.reviewer.ref}` +
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
            row.kind === "saved"
              ? row.pair.name
              : row.kind === "recent"
                ? row.recent.task
                : row.kind === "new"
                  ? "new pair…"
                  : "save current as…";
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
        {!loading && visible.length === 0 && (
          <Text dimColor>
            {scope === "preset" ? "no pairs saved yet — save one in settings" : "no pairs saved, and no runs to learn one from"}
          </Text>
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
              ...(scope === "manage"
                ? [
                    ["r", "rename"] as [string, string],
                    ["R", "auto-name"] as [string, string],
                    ["d", "delete"] as [string, string],
                  ]
                : []),
              ["Esc", "back"],
            )}
          />
        </Text>
      </Box>
    </Box>
  );
}

/** The Artificial Analysis key prompt. Typing is handled by the app; this draws the field. */
function AAKey({
  value,
  caret,
  busy,
  notice,
  hasKey,
}: {
  value: string;
  /** The caret inside the key field, clamped to it where it renders. */
  caret: number;
  busy: boolean;
  notice: string | null;
  /** Whether a key is already stored — the field always starts empty, so without
     this the screen cannot say so. */
  hasKey: boolean;
}) {
  // Masked but confirmable: a paste you cannot check is a paste you redo.
  const shown = value
    ? `${"•".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`
    : "paste the key, then Enter…";
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right="benchmarks key" />
      </Box>
      <Text dimColor>
        an artificialanalysis.ai key, so the picker reads scores direct instead of the OpenRouter benchmarks.
      </Text>
      <Text dimColor>one verification request, then only a few per weekly refresh — inside the free 100/day.</Text>
      {/* Stored state in green, not dim: the field always opens empty, so this
          line is the only thing that says a key is already here. */}
      {hasKey ? (
        <Text color={THEME.ok}>a key is already stored — saving replaces it.</Text>
      ) : (
        <Text dimColor>no key stored — scores come from OpenRouter until one is saved.</Text>
      )}
      <Box marginTop={1}>
        {value ? (
          // One bullet per character, so the caret index maps one-to-one onto
          // the masked text.
          <FieldText text={shown} cursor={caret} />
        ) : (
          <Text>
            <Text dimColor>{shown}</Text>
            <Text inverse> </Text>
          </Text>
        )}
        {busy && <Text dimColor> verifying…</Text>}
      </Box>
      {notice && (
        <Box marginTop={1}>
          <Text color={THEME.warn}>{notice}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text>
          <Line
            spans={hints(["←→", "move"], ["^A ^E", "ends"], ["Enter", "save & verify"], ["Ctrl+U", "clear"], ["Esc", "cancel"])}
          />
        </Text>
      </Box>
    </Box>
  );
}

/** The name prompt. Typing is handled by the app; this draws the field. */
function PairName({
  value,
  caret,
  known,
  maxShown,
  models,
  renameFrom,
}: {
  value: string;
  /** The caret inside the name, clamped to it where it renders. */
  caret: number;
  known: string[];
  maxShown: number;
  /** The two models being named — the builder's draft, or the current two. */
  models: string | null;
  /** Renaming this pair, not saving a new one: the prompt opened prefilled. */
  renameFrom: string | null;
}) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right={renameFrom ? "rename this pair" : "save this pair"} />
      </Box>
      <Text dimColor>
        {renameFrom ? `was "${renameFrom}" — Enter renames, Esc keeps it:` : "name it, so the next one is a keystroke away:"}
      </Text>
      {models && (
        <Box>
          <Text dimColor>naming </Text>
          <Text>{models}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        {value ? (
          <FieldText text={value} cursor={caret} />
        ) : (
          <Text>
            <Text dimColor>type a name…</Text>
            <Text inverse> </Text>
          </Text>
        )}
      </Box>
      {known.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>saved names:</Text>
          {known.slice(0, maxShown).map((n) => (
            <Text key={n} dimColor>{`  ${n}`}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text>
          <Line spans={hints(["←→", "move"], ["^A ^E", "ends"], ["Enter", "save"], ["Esc", "cancel"])} />
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
  maxLines,
  onAnswer,
}: {
  summary: DeletionSummary;
  /** Run rows that fit: the confirmation must fit the terminal too. */
  maxLines: number;
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
        {summary.lines.slice(0, maxLines).map((line) => (
          <Text key={line.dir} dimColor>
            {"  "}
            {line.text}
          </Text>
        ))}
        {summary.lines.length > maxLines && (
          <Text dimColor>{`  … and ${summary.lines.length - maxLines} more`}</Text>
        )}
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
 * A bounded in-frame window over the session's log: the last rows that fit the
 * viewport budget, with the spinner below while a model is thinking. There is
 * deliberately no `<Static>` here — on the alternate screen there is no
 * scrollback, and Ink replays the whole accumulated static output on any full
 * clear, pushing the live frame off the screen. The full log stays in state
 * for the session, and `l` shows it whole in a pane.
 */
function Log({ lines, label, maxLines }: { lines: StyledLine[]; label: string | null; maxLines: number }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (label === null) return;
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, [label]);
  const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame % 10];
  // Already wrapped to the width: one element is one row on screen, which is
  // what makes the pane's position below it a number rather than a guess. Ink
  // wrapping a long log line would shift everything under it.
  const shown = lines.slice(Math.max(0, lines.length - Math.max(0, maxLines)));

  return (
    <Box flexDirection="column" flexShrink={0}>
      {shown.map((line, i) => (
        <Line key={i} spans={line} />
      ))}
      {label !== null && (
        <Box>
          <Text color={THEME.warn}>{spinner} </Text>
          <Text dimColor>{label}</Text>
        </Box>
      )}
    </Box>
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
  contentH,
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
  /** Content rows the screen may use: the finding's own text fills what fits. */
  contentH: number;
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
  const titleRows = wrapText(item.title, 4, wrapW);
  const detail: string[] = [];
  for (const line of item.detail) detail.push(...wrapText(line, 2, wrapW));
  // The finding's own text fills what the title and options leave — on a tall
  // terminal that is the whole finding, and `w` still shows it whole in a pane.
  const clippedDetail = detail.slice(
    0,
    gateDetailBudget(contentH, {
      titleRows: titleRows.length,
      optionRows: item.options.length,
      extras: extras.length > 0,
      revisit: !!revisit,
    }),
  );

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
        {titleRows.map((line, i) => (
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

function App({ repo, onRecap }: { repo: string; onRecap?: (text: string | null) => void }) {
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
      // No log line, no notice: either one takes rows from the content and the
      // whole frame shifts. The pinned bottom line flips synchronously and
      // names the mode on every screen — that is the feedback, and it moves
      // nothing. (No scrollback on the alternate screen, so the second mode
      // promises selection, not scrolling back.)
      return;
    }
    // Past runs, from any settled screen: hopping between runs should not cost
    // a trip home first. Left off while a model call or an approval is in
    // flight — those phases are "running"/"working", and are not in this list.
    if (
      key.ctrl &&
      input === "r" &&
      (phase === "home" || phase === "start" || phase === "gate" || phase === "result" || phase === "error")
    ) {
      void openRuns();
    }
    if (key.ctrl && input === "p" && phase === "home") {
      void openSettings();
    }
  });
  const [cfg, setCfg] = useState<Config | null>(null);
  const [hasCriteria, setHasCriteria] = useState(false);
  const [phase, setPhase] = useState<Phase>("home");
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
  const [homeSel, setHomeSel] = useState(0);
  /** Debate-screen cursor: 0 pair · 1 drafter · 2 reviewer · 3 subject · 4 prompt. Starts on the prompt. */
  const [deskSel, setDeskSel] = useState(4);
  /** Where the pairs list was opened from: the debate screen only chooses, settings manages. */
  const [pairOrigin, setPairOrigin] = useState<"settings" | "debate">("settings");
  /** The model list's mode: browse from home (Enter does nothing), select one model, or build a pair step by step. */
  const [pickMode, setPickMode] = useState<"browse" | "select" | "build">("select");
  /** The pair being built by hand: the drafter is picked first, then the reviewer. */
  const [pairDraft, setPairDraft] = useState<{ drafter: ModelRef | null; reviewer: ModelRef | null }>({
    drafter: null,
    reviewer: null,
  });
  /** Which half of the pair the builder is picking now. Null outside a build. */
  const [buildStep, setBuildStep] = useState<"drafter" | "reviewer" | null>(null);
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
  /** The caret inside the filter, clamped to it on every render. */
  const [filterCaret, setFilterCaret] = useState(0);
  /** AND needs every filter word; OR needs any one; OFF ignores the text. Session-only, like `D`/`S`. */
  const [filterMode, setFilterMode] = useState<FilterMode>("and");
  const [pickIndex, setPickIndex] = useState(0);
  const [pickRole, setPickRole] = useState<"drafter" | "reviewer">("drafter");
  /** What the picker lists: grouped providers, or a flat score-ordered view. */
  const [view, setView] = useState<PickerView>("provider");
  /** Which tier of a tiered list price the picker shows and the value view filters on. */
  const [priceBasis, setPriceBasis] = useState<PriceBasis>("low");
  /** Drop models with no benchmark from every view. Off: they sort last. */
  const [hideUnscored, setHideUnscored] = useState(false);
  /**
   * Rank the flat views by AI Coding Daily instead of AA/OpenRouter: `D`
   * swaps the source behind `scoreOf` (ACD points) and, in the taskcost view,
   * behind `taskCostOf` (ACD $/task). Session-only — a restart must not
   * silently re-rank by another benchmark. The provider view stays inert:
   * grouped, not ranked.
   */
  const [rankAcd, setRankAcd] = useState(false);
  /**
   * Rank the flat views by measured cost instead of score: `S` swaps the
   * dimension behind the order — $/task, or ACD $/task with `D` — cheapest
   * first, unmeasured trailing. Session-only, like `D`. Only the provider
   * view stays out: grouped, not ranked.
   */
  const [rankCost, setRankCost] = useState(false);
  /** The provider the picker is locked to, or null for every provider. `L`
     locks the highlighted model's provider; the view, the filter and `H` all
     still apply inside it. */
  const [providerLock, setProviderLock] = useState<string | null>(null);
  /**
   * Providers the picker hides, by id. Personal and persisted in `prefs.ts`
   * like the ceilings; the pool filter in `models.ts` applies it to every
   * view. A Set in state, a sorted array on disk.
   */
  const [disabledProviders, setDisabledProviders] = useState<ReadonlySet<string>>(new Set());
  /** The cursor on the provider switchboard. */
  const [provFilterIndex, setProvFilterIndex] = useState(0);
  /**
   * Past filters, newest first. Personal and persisted in `prefs.ts` like the
   * ceilings; the in-memory list is the session's truth, so a re-read never
   * resurrects a row deleted two keypresses ago.
   */
  const [filterHistory, setFilterHistory] = useState<FilterEntry[]>([]);
  /** The cursor on the filter-history panel. */
  const [filterHistIndex, setFilterHistIndex] = useState(0);
  /** `D` arms "clear all?" on the history panel: `y` clears, `n`/`Esc` stands down. */
  const [histClearArmed, setHistClearArmed] = useState(false);
  /**
   * The provisional text this picker visit already recorded, or null once an
   * entry went final. A visit contributes at most one provisional entry, which
   * the next use replaces — typing `mus`, pausing, then `muse 1.3` records
   * the full filter, never the prefix. A ref, not state: no row renders it.
   */
  const filterVisit = useRef<{ text: string } | null>(null);
  /** The idle timer behind the pause-commit. Cleared on every edit and on leaving. */
  const filterDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Whether this session has read the history file. Once per session, never
   * per visit: a load started before a fire-and-forget save lands would call
   * back with the old file and wipe what the session just recorded.
   */
  const filterHistoryLoaded = useRef(false);
  /** Output $/M ceiling for the value view. Personal, in `prefs.ts`. */
  const [ceiling, setCeiling] = useState(DEFAULT_CEILING);
  /** Measured $/task ceiling for the taskcost view. Personal, like the value one. */
  const [taskCeiling, setTaskCeiling] = useState(DEFAULT_TASK_CEILING);
  /**
   * What is knowable about a model without calling one, and what a call once
   * said. All three are read on demand when the picker opens: the catalogue is a
   * file OpenCode already keeps, `auth list` is free, and the probes are our own
   * record. Every one degrades to empty, which renders `?` — the honest reading,
   * and never "free".
   */
  const [catalogue, setCatalogue] = useState<Catalogue>(new Map());
  const [probes, setProbes] = useState<ProbeCache>({});
  /**
   * Benchmark scores, keyed by normalised OpenRouter id. Read when the picker
   * opens, refreshed in the background past 7 days, on demand with `B`.
   * Empty until the first fetch lands — rows render blank, never `?`.
   */
  const [benchmarks, setBenchmarks] = useState<Benchmarks>(emptyBenchmarks());
  /**
   * AI Coding Daily's coding leaderboard, same lifecycle as the benchmarks:
   * read when the picker opens, refreshed in the background past 7 days.
   * Empty until the first fetch lands — rows render no `D` badge, never `?`.
   */
  const [acd, setAcd] = useState<AcdIndex>(emptyAcd());
  /** When the benchmark cache was fetched, and which index measured it — the
     export names its provenance, so it keeps both next to the scores. */
  const [benchMeta, setBenchMeta] = useState<{
    at: string | null;
    indexVersion: string | null;
    acdAt: string | null;
  }>({
    at: null,
    indexVersion: null,
    acdAt: null,
  });
  /** One fetch at a time per source: settings can be opened twice before either lands. */
  const benchFetching = useRef(false);
  const acdFetching = useRef(false);
  const [authed, setAuthed] = useState<Map<string, "env" | "stored">>(new Map());
  /** Refs with a call in flight, so a row can say `…` instead of pretending. */
  const [pinging, setPinging] = useState<Set<string>>(new Set());
  /** The exact refs a ping-all is armed for, so `y` pings what `A` named — a
     count alone would fire on a different list of the same length. */
  const [pingArmed, setPingArmed] = useState<string[] | null>(null);
  /** An armed export: the whole shown table, and just the picker's window, so
     `e` exports what `Y` named — a count alone would fire on a stale list. */
  const [exportArm, setExportArm] = useState<{ entire: string[]; visible: string[] } | null>(null);
  /** The picker's window start, reported by `Pick` — what "visible" means to `Y`. */
  const pickStart = useRef(0);
  /* Saved pairs, and the runs the recent-pair rows come from. The runs are a
     separate list from the past-runs screen's: that one is a snapshot with its
     own tags and scroll, and opening pairs must not disturb it. */
  const [savedPairs, setSavedPairs] = useState<Pair[]>([]);
  const [pairRuns, setPairRuns] = useState<RunSummary[]>([]);
  const [pairIndex, setPairIndex] = useState(0);
  const [pairLoading, setPairLoading] = useState(false);
  const [pairName, setPairName] = useState("");
  /** The caret inside the pair name, set to the end wherever the prompt opens. */
  const [pairCaret, setPairCaret] = useState(0);
  const [pairAsk, setPairAsk] = useState<{ ask: "delete" | "overwrite"; pair: Pair } | null>(null);
  /**
   * Renaming, not saving: the name prompt's Enter moves this pair's models and
   * dates onto the typed name instead of storing the current two. Set by `r`
   * and `R`, cleared everywhere the prompt is entered for a fresh save.
   */
  const [pairRename, setPairRename] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  /** An Artificial Analysis key is stored: the picker reads scores direct, OpenRouter fills gaps. */
  const [aaKeySet, setAAKeySet] = useState(false);
  /** The key being typed. Masked on screen, never logged, verified before saving. */
  const [aaKeyInput, setAAKeyInput] = useState("");
  /** The caret inside the key field, clamped to it where it renders. */
  const [aaKeyCaret, setAAKeyCaret] = useState(0);
  /** A verification request in flight: the keystroke handler stands aside. */
  const [aaKeyBusy, setAAKeyBusy] = useState(false);
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
        setPhase(present.dir ? "home" : "setup");
        // Warm what home and settings show without a visit: the pair name and
        // the benchmarks-key state. Neither throws.
        void loadPairs().then(setSavedPairs).catch(() => {});
        void loadAAKey().then((k) => setAAKeySet(!!k)).catch(() => {});
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
      setPhase("home");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  const persist = async (next: Config, nextMode: Mode) => {
    setCfg(next);
    await saveConfig(repo, { ...next, mode: nextMode });
  };

  /** Load everything the model list needs, shared by both its doors. */
  async function ensureModelData() {
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
    void loadCeiling().then(setCeiling);
    void loadTaskCeiling().then(setTaskCeiling);
    void loadDisabledProviders().then((list) => setDisabledProviders(new Set(list)));
    // Past filters likewise — but once per session into the session's truth,
    // never re-read per visit. A load started before a fire-and-forget save
    // lands calls back with the old file and wipes what was just recorded.
    if (!filterHistoryLoaded.current) {
      filterHistoryLoaded.current = true;
      void loadFilterHistory().then(setFilterHistory);
    }
    // The catalogue and our own probe record do not depend on the listing, so
    // they do not wait for it. Neither throws.
    void loadCatalogue().then((r) => setCatalogue(r.catalogue));
    void loadProbes().then(setProbes);
    // Whether an AA key is stored decides the benchmark source. Never throws.
    void loadAAKey().then((k) => setAAKeySet(!!k));
    // Benchmarks likewise. A stale cache refreshes in the background once the
    // stored scores are on screen — keyed or keyless, the refresh is a few
    // requests against a weekly cache, so unlike a ping it needs no keypress,
    // only a week-old cache.
    void loadScores().then((r) => {
      setBenchmarks(r.scores);
      setBenchMeta((m) => ({ ...m, at: r.at, indexVersion: r.indexVersion }));
      if (isStale(r.at)) void refreshBenchmarks(true);
    });
    // AI Coding Daily likewise, on its own cache and staleness — one source
    // failing never blocks the other.
    void loadAcd().then((r) => {
      setAcd(r.entries);
      setBenchMeta((m) => ({ ...m, acdAt: r.at }));
      if (isStale(r.at)) void refreshAcd(true);
    });
    // What settings names, without a visit: the pair the current models are.
    void loadPairs().then(setSavedPairs).catch(() => {});
  }

  async function openSettings() {
    setSettingsSel(0);
    setSaved(null);
    setNotice(null);
    setPhase("settings");
    void ensureModelData();
  }

  /** Home → models browser: the same list, with Enter inert. */
  async function openBrowser() {
    setPickMode("browse");
    resetFilterVisit();
    setFilter("");
    setFilterCaret(0);
    setPickIndex(0);
    setNotice(null);
    setPhase("pick");
    void ensureModelData();
  }

  /** Debate screen → pick a drafter or reviewer: Enter assigns. */
  async function openPick(role: "drafter" | "reviewer") {
    setPickMode("select");
    setPickRole(role);
    resetFilterVisit();
    setFilter("");
    setFilterCaret(0);
    setPickIndex(0);
    setNotice(null);
    setPhase("pick");
    void ensureModelData();
  }

  /**
   * Pairs list → build a pair by hand: the picker first, for the drafter,
   * then again for the reviewer, then the name prompt. Only from settings —
   * the debate door lists presets and builds nothing.
   */
  async function openBuild() {
    setPickMode("build");
    setBuildStep("drafter");
    setPairDraft({ drafter: null, reviewer: null });
    resetFilterVisit();
    setFilter("");
    setFilterCaret(0);
    setPickIndex(0);
    setNotice(null);
    setPhase("pick");
    void ensureModelData();
  }

  function openHome() {
    setPanel(null);
    setNotice(null);
    setPhase("home");
  }

  /** Home menu choice: 0 browser · 1 new debate · 2 runs · 3 settings · 4 quit. */
  function chooseHome(i: number) {
    if (i === 0) {
      void openBrowser();
      return;
    }
    if (i === 1) {
      setDeskSel(4);
      setPhase("start");
      return;
    }
    if (i === 2) {
      void openRuns();
      return;
    }
    if (i === 3) {
      void openSettings();
      return;
    }
    exit();
  }

  /**
   * Refresh the benchmark cache: OpenRouter plus Artificial Analysis direct
   * when a key is stored, then the rows re-render merged, Artificial Analysis
   * first. AI Coding Daily refreshes alongside on its own cache — `refreshAcd`
   * below — so one source failing never blocks the other.
   *
   * Silent when automatic (a stale cache on opening the model list): the old scores
   * stay until the new ones land, and a failed fetch keeps them with nothing
   * said — offline is not an error worth a notice. Loud on `B`: the reader
   * asked, so the reader hears the answer either way.
   */
  async function refreshBenchmarks(silent = false) {
    if (benchFetching.current) return;
    benchFetching.current = true;
    try {
      if (!silent) setNotice("refreshing benchmarks…");
      const r = await refreshAllBenchmarks();
      setBenchmarks(r.scores);
      setBenchMeta((m) => ({ ...m, at: r.at, indexVersion: r.indexVersion }));
      const total = r.aaCount + r.orCount;
      const scope =
        r.aaOk && r.orOk
          ? `${total} scored (${r.aaCount} Artificial Analysis + ${r.orCount} OpenRouter)`
          : r.aaOk
            ? `${total} scored (Artificial Analysis only — OpenRouter unreachable)`
            : r.aaKey
              ? `${total} scored (OpenRouter only — Artificial Analysis unreachable)`
              : `${total} scored (OpenRouter only — no key stored)`;
      const parts = [
        scope,
        ...(r.indexVersion ? [`AA Intelligence Index v${r.indexVersion}`] : []),
        ...(r.quota?.remaining !== null && r.quota?.remaining !== undefined
          ? [`quota ${r.quota.remaining}/${r.quota.limit ?? "?"}`]
          : []),
        `fetched ${r.at.slice(0, 10)}`,
      ];
      if (!silent)
        setNotice(
          `benchmarks updated · ${parts.join(" · ")}` +
            (r.warnings.length ? ` · ! ${r.warnings[0]}` : ""),
        );
    } catch (err) {
      if (!silent) setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      benchFetching.current = false;
    }
  }

  /**
   * Refresh AI Coding Daily's coding leaderboard: one keyless page fetch, then
   * the `D` badges re-render. Same silent/loud contract as the benchmark
   * refresh — and a failed fetch keeps the old cache with nothing said, so a
   * restyled page never blanks the column.
   */
  async function refreshAcd(silent = false) {
    if (acdFetching.current) return;
    acdFetching.current = true;
    try {
      const r = await fetchAcd();
      setAcd(r.entries);
      setBenchMeta((m) => ({ ...m, acdAt: r.at }));
      if (!silent) setNotice(`AI Coding Daily updated · ${r.count} models · fetched ${r.at.slice(0, 10)}`);
    } catch (err) {
      if (!silent) setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      acdFetching.current = false;
    }
  }

  /** The rows on the pair screen, recomputed from what is loaded. */
  const pairScreen = useMemo(
    () => pairRows(savedPairs, pairRuns, new Set(allModels), pairOrigin === "debate" ? "preset" : "manage"),
    [savedPairs, pairRuns, allModels, pairOrigin],
  );
  /** The rows the cursor can land on: the debate door lists saved presets only. */
  const pairVisible = pairScreen;
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

  /** Store two models under a name, then go back to the list. */
  async function commitPair(name: string, models?: PairModels) {
    const named = models ?? currentModels();
    if (!named) return;
    await savePair({ name, ...named });
    const pairs = await loadPairs();
    setSavedPairs(pairs);
    // The cursor follows the pair you just made, not the row that happened to be
    // under it — saving one pushes every run row down by one.
    const rows = pairRows(pairs, pairRuns, new Set(allModels));
    const at = rows.findIndex((row) => row.kind === "saved" && row.pair.name === name);
    if (at >= 0) setPairIndex(at);
    setNotice(`saved pair "${name}"`);
    setPairDraft({ drafter: null, reviewer: null });
    setBuildStep(null);
    setPhase("pairs");
  }

  /** Rename a saved pair: its models and dates move onto the new name. */
  async function commitRename(from: string, to: string) {
    const prev = savedPairs.find((p) => p.name === from);
    if (!prev) return;
    const pairs = await renamePair(from, to, pairModels(prev));
    setSavedPairs(pairs);
    const rows = pairRows(pairs, pairRuns, new Set(allModels));
    const at = rows.findIndex((row) => row.kind === "saved" && row.pair.name === to);
    if (at >= 0) setPairIndex(at);
    setNotice(`renamed "${from}" to "${to}"`);
    setPairRename(null);
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
    // Not logged: the choice is confirmed by the notice and the rows, and a
    // log line would follow every later screen — including a past run that
    // used another pair, where it would read as a false claim.
    setSavedPairs(name ? await markPairUsed(name) : await loadPairs());
    if (pairOrigin === "debate") {
      // Choosing only: back to the debate screen, which shows notices.
      setNotice(name ? `using pair "${name}"` : "using a pair a run used");
      setPhase("start");
      return;
    }
    setSettingsSel(0);
    setSaved(name ? `using pair "${name}"` : "using a pair a run used");
    setPhase("settings");
  }

  /**
   * Save a hand-built pair and start using it: the name prompt's Enter lands
   * here with both models, so one naming writes the preset and switches to it —
   * and stays on the pairs list, where the new row is now the cursor.
   */
  async function commitBuiltPair(name: string, models: PairModels) {
    if (!cfg) return;
    await savePair({ name, ...models });
    const pairs = await loadPairs();
    setSavedPairs(await markPairUsed(name));
    await persist({ ...cfg, models }, mode);
    // Not logged, like every other pair choice: the notice confirms it inline.
    const rows = pairRows(pairs, pairRuns, new Set(allModels));
    const at = rows.findIndex((row) => row.kind === "saved" && row.pair.name === name);
    if (at >= 0) setPairIndex(at);
    setNotice(`saved and using "${name}"`);
    setPairDraft({ drafter: null, reviewer: null });
    setBuildStep(null);
    setPhase("pairs");
  }

  /* Settings: a saved pair, or the benchmarks key. The key lives in the user's
     config dir alone, never in a repo. */
  useInput(
    (_input, key) => {
      if (!cfg) return;
      if (key.escape) {
        setPhase("home");
        return;
      }
      if (key.upArrow) {
        setSettingsSel((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setSettingsSel((s) => Math.min(2, s + 1));
        return;
      }
      if (!key.return) return;

      if (settingsSel === 0) {
        void openPairs("settings");
        return;
      }
      if (settingsSel === 1) {
        // A fresh field every visit: a key left on screen is a key photographed.
        setAAKeyInput("");
        setAAKeyCaret(0);
        setNotice(null);
        setPhase("aakey");
        return;
      }
      setPhase("home");
    },
    { isActive: phase === "settings" },
  );

  /**
   * Verify, then store. A 401 means the key is wrong and nothing is saved; a
   * 429 proves the key and spends the window, so it is saved and the reset
   * is what gets reported. Anything else leaves the old state alone.
   */
  async function commitAAKey() {
    const key = aaKeyInput.trim();
    if (!key) {
      setNotice("paste a key first — Esc cancels");
      return;
    }
    setAAKeyBusy(true);
    try {
      const v = await verifyAAKey(key);
      await saveAAKey(key);
      setAAKeySet(true);
      const quota =
        v.quota.remaining !== null && v.quota.remaining !== undefined
          ? ` · quota ${v.quota.remaining}/${v.quota.limit ?? "?"}`
          : "";
      const version = v.version ? ` · AA Intelligence Index v${v.version}` : "";
      setSaved(`benchmarks key saved · Artificial Analysis ${v.tier ?? "free"}${version}${quota}`);
      setPhase("settings");
      // A fresh key means fresh scores: the relay-only cache is now the fallback.
      void refreshBenchmarks(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("(429)")) {
        await saveAAKey(key).catch(() => {});
        setAAKeySet(true);
        setSaved("benchmarks key saved · quota spent — refresh after the window resets");
        setPhase("settings");
      } else {
        setNotice(msg);
      }
    } finally {
      setAAKeyBusy(false);
    }
  }

  /**
   * The key prompt. Esc cancels back to settings; the key is never left on
   * screen behind anything. Typing clears a rejection so a corrected paste
   * is not haunted by the last one.
   */
  useInput(
    (input, key) => {
      if (aaKeyBusy) return;
      if (key.escape) {
        setPhase("settings");
        return;
      }
      // Ctrl+U clears, readline-style — a pasted key with a stray character
      // is easier to redo than to fix blind behind bullets.
      if (key.ctrl && input === "u") {
        setAAKeyInput("");
        setAAKeyCaret(0);
        return;
      }
      // Line editing, readline-style: arrows step, ^A/^E jump.
      const kcur = Math.max(0, Math.min(aaKeyCaret, aaKeyInput.length));
      if (key.ctrl && input === "a") {
        setAAKeyCaret(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setAAKeyCaret(aaKeyInput.length);
        return;
      }
      if (key.leftArrow) {
        setAAKeyCaret((c) => Math.max(0, Math.min(c, aaKeyInput.length) - 1));
        return;
      }
      if (key.rightArrow) {
        setAAKeyCaret((c) => Math.min(aaKeyInput.length, Math.max(0, c) + 1));
        return;
      }
      if (key.backspace) {
        if (kcur > 0) {
          setAAKeyInput(aaKeyInput.slice(0, kcur - 1) + aaKeyInput.slice(kcur));
          setAAKeyCaret(kcur - 1);
        }
        return;
      }
      if (key.delete) {
        if (kcur < aaKeyInput.length) setAAKeyInput(aaKeyInput.slice(0, kcur) + aaKeyInput.slice(kcur + 1));
        return;
      }
      if (key.return) {
        void commitAAKey();
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input) {
        setNotice(null);
        setAAKeyInput(aaKeyInput.slice(0, kcur) + input + aaKeyInput.slice(kcur));
        setAAKeyCaret(kcur + input.length);
      }
    },
    { isActive: phase === "aakey" },
  );

  /**
   * The pair list: saved pairs last-used first, then pairs runs have used.
   *
   * Both are read on the way in rather than kept warm, so what is on screen is
   * what is on disk — including after another `adv`, or a hand edit. From the
   * debate screen the list is saved presets only; managing lives in settings.
   */
  async function openPairs(origin: "settings" | "debate") {
    setPairName("");
    setPairCaret(0);
    setPairAsk(null);
    setNotice(null);
    setPairOrigin(origin);
    setPhase("pairs");
    setPairLoading(true);
    const [pairs, runs] = await Promise.all([loadPairs(), listRuns(repo)]);
    setPairLoading(false);
    setSavedPairs(pairs);
    setPairRuns(runs);
    // The cursor opens on the pair in use, so "the last one" is where Enter
    // lands without moving anything. Searched in the rows on screen, not the
    // full list: the debate door lists presets only, and an index into the
    // wrong list lands the cursor on the wrong row.
    const current = currentPairKey();
    const scope = origin === "debate" ? "preset" : "manage";
    const at = pairRows(pairs, runs, new Set(allModels), scope).findIndex((row) => {
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
        setPhase(pairOrigin === "debate" ? "start" : "settings");
        return;
      }
      // Grouping gaps are rows on screen but never cursor stops: stepping
      // onto one keeps going the same way. Safe without a bound — a gap
      // always sits between two real rows, so one extra step always lands.
      const stepSkip = (i: number, dir: -1 | 1): number => {
        let at = clampIndex(i + dir, pairVisible.length);
        while (pairVisible[at]?.kind === "gap") at = clampIndex(at + dir, pairVisible.length);
        return at;
      };
      if (key.upArrow || input === "k") {
        setPairIndex((i) => stepSkip(i, -1));
        return;
      }
      if (key.downArrow || input === "j") {
        setPairIndex((i) => stepSkip(i, 1));
        return;
      }
      const row = pairVisible[pairIndex];
      if (key.return) {
        if (!row || row.kind === "gap") return;
        if (row.kind === "new") {
          void openBuild();
          return;
        }
        if (row.kind === "save") {
          // Naming the current two, not a draft: a builder left on the
          // name prompt must not leak its models into this save.
          setPairDraft({ drafter: null, reviewer: null });
          setBuildStep(null);
          setPairRename(null);
          const current = currentModels();
          const suggestion = current ? suggestPairName(current) : "";
          setPairName(suggestion);
          setPairCaret(suggestion.length);
          setPhase("pairname");
          return;
        }
        void usePair(modelsOf(row)!, row.kind === "saved" ? row.pair.name : undefined);
        return;
      }
      if (input === "d") {
        if (pairOrigin === "debate") {
          setNotice("saved pairs are managed in settings");
        } else if (row?.kind === "saved") {
          setPairAsk({ ask: "delete", pair: row.pair });
          setPhase("pairconfirm");
        } else if (row?.kind === "recent")
          setNotice("that pair belongs to a run — it is not stored here, and goes when the run does");
        else if (row?.kind === "gap") return;
        else setNotice("a new pair is built, not deleted — pick it to start");
      }
      // `r` renames the saved pair under the cursor, opening the prompt with
      // its name; `R` opens it with a name suggested from its models instead.
      // Managing lives in settings, so both are inert from the debate screen.
      if (input === "r" || input === "R") {
        if (pairOrigin === "debate") {
          setNotice("saved pairs are managed in settings");
          return;
        }
        if (row?.kind !== "saved") {
          setNotice("only a saved pair can be renamed — Enter uses anything here");
          return;
        }
        // A rename names the pair's own models, never a builder's leftovers.
        setPairDraft({ drafter: null, reviewer: null });
        setBuildStep(null);
        setPairRename(row.pair.name);
        if (input === "R") {
          const suggestion = suggestPairName(pairModels(row.pair));
          if (suggestion && suggestion !== row.pair.name) {
            setPairName(suggestion);
            setPairCaret(suggestion.length);
            setPhase("pairname");
            return;
          }
          setNotice(
            suggestion
              ? `already named "${suggestion}" — press r to edit it`
              : "no name suggests itself from those models — press r to type one",
          );
          setPairRename(null);
          return;
        }
        setPairName(row.pair.name);
        setPairCaret(row.pair.name.length);
        setPhase("pairname");
      }
    },
    { isActive: phase === "pairs" },
  );

  /**
   * The name prompt.
   *
   * Esc cancels back to the list rather than carrying on to settings: this
   * screen has its own parent one level in, and a stray Esc must not throw away
   * the list behind it as well. A builder's draft is kept on Esc — the two
   * models are still there when the prompt is reopened — and cleared on save.
   */
  useInput(
    (input, key) => {
      if (key.escape) {
        setPairRename(null);
        setPhase("pairs");
        return;
      }
      // Line editing, readline-style: arrows step, ^A/^E jump.
      const ncur = Math.max(0, Math.min(pairCaret, pairName.length));
      if (key.ctrl && input === "a") {
        setPairCaret(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setPairCaret(pairName.length);
        return;
      }
      if (key.leftArrow) {
        setPairCaret((c) => Math.max(0, Math.min(c, pairName.length) - 1));
        return;
      }
      if (key.rightArrow) {
        setPairCaret((c) => Math.min(pairName.length, Math.max(0, c) + 1));
        return;
      }
      if (key.backspace) {
        if (ncur > 0) {
          setPairName(pairName.slice(0, ncur - 1) + pairName.slice(ncur));
          setPairCaret(ncur - 1);
        }
        return;
      }
      if (key.delete) {
        if (ncur < pairName.length) setPairName(pairName.slice(0, ncur) + pairName.slice(ncur + 1));
        return;
      }
      if (key.return) {
        const name = pairName.trim();
        if (!name) {
          setNotice("a pair needs a name — that is how you find it again");
          return;
        }
        // Renaming moves the pair's own models onto the typed name — never
        // the current two, never a builder's draft.
        if (pairRename) {
          if (name === pairRename) {
            setNotice(`kept "${name}"`);
            setPairRename(null);
            setPhase("pairs");
            return;
          }
          const from = savedPairs.find((p) => p.name === pairRename);
          if (!from) {
            setPairRename(null);
            setPhase("pairs");
            return;
          }
          const clash = savedPairs.find((p) => p.name === name);
          if (clash) {
            setPairAsk({ ask: "overwrite", pair: { ...clash, ...pairModels(from) } });
            setPhase("pairconfirm");
            return;
          }
          void commitRename(pairRename, name);
          return;
        }
        // A hand-built pair names its own two models; "save current as…"
        // names the two on screen.
        const built =
          pairDraft.drafter && pairDraft.reviewer
            ? pairModels({ drafter: pairDraft.drafter, reviewer: pairDraft.reviewer })
            : null;
        const models = built ?? currentModels();
        const existing = savedPairs.find((p) => p.name === name);
        if (existing) {
          if (models) {
            setPairAsk({ ask: "overwrite", pair: { ...existing, ...models } });
            setPhase("pairconfirm");
          }
          return;
        }
        if (built) void commitBuiltPair(name, built);
        else void commitPair(name);
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input) {
        setPairName(pairName.slice(0, ncur) + input + pairName.slice(ncur));
        setPairCaret(ncur + input.length);
      }
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
      setPairRename(null);
      return;
    }
    if (ask.ask === "delete") {
      const gone = await deletePair(ask.pair.name);
      setSavedPairs(await loadPairs());
      setNotice(gone ? `deleted pair "${ask.pair.name}"` : `no pair called "${ask.pair.name}"`);
    } else if (pairRename) {
      // Renaming onto a taken name: the old name goes, its models move onto
      // the confirmed one. The confirm already carries those models.
      await commitRename(pairRename, ask.pair.name);
    } else {
      // The confirm carries the two models it would store — the builder's
      // when it built them, the current two otherwise — so overwriting reuses
      // the same path as naming, rather than re-reading the config.
      const built =
        pairDraft.drafter && pairDraft.reviewer
          ? pairModels({ drafter: pairDraft.drafter, reviewer: pairDraft.reviewer })
          : null;
      if (built) await commitBuiltPair(ask.pair.name, built);
      else await commitPair(ask.pair.name, pairModels(ask.pair));
      setNotice(built ? `saved and using "${ask.pair.name}"` : `replaced pair "${ask.pair.name}"`);
    }
  }

  /** The model picker's rows: favourites first, then recents, then the rest. */
  const aaScoreOf = useMemo(() => {
    // Adapted once per catalogue or cache change, not once per row: the
    // picker calls this hundreds of times a render.
    return (ref: string): { intelligence?: number } | null => {
      const r = scoresFor(catalogue, benchmarks, ref);
      return r ? { intelligence: r.intelligence } : null;
    };
  }, [catalogue, benchmarks]);
  /**
   * What the flat views rank on. `D` swaps the source: ACD points instead of
   * the AA index. The provider view keeps `aaScoreOf` — grouped, not ranked,
   * so `H` there keeps meaning AA.
   */
  const scoreOf = useMemo(
    () => (rankAcd ? acdScoreOf(catalogue, acd) : aaScoreOf),
    [rankAcd, catalogue, acd, aaScoreOf],
  );
  const outputOf = useMemo(() => {
    return (ref: string): number | undefined => {
      const c = costOf(catalogue, ref);
      // Free is a price (0), unknown is not a price at all: the value view
      // cannot call an unknown cost cheap. On the high basis a tiered model
      // filters on the price a long session pays, not the base price.
      if (c.kind === "free") return 0;
      if (c.kind !== "priced") return undefined;
      return priceBasis === "high" && c.tier ? c.tier.output : c.output;
    };
  }, [catalogue, priceBasis]);
  /** Measured $/task, AA rows only — the taskcost view filters on this. */
  const aaTaskCostOf = useMemo(() => {
    return (ref: string): number | undefined =>
      scoresFor(catalogue, benchmarks, ref)?.taskCost;
  }, [catalogue, benchmarks]);
  /**
   * What the taskcost view filters on. `D` swaps the source with the ranking:
   * ACD $/task under the same ceiling — the score and the cheapness switch
   * together, so two task definitions never share one view. Unused outside
   * the taskcost view, so the switch is inert elsewhere.
   */
  const taskCostOf = useMemo(
    () => (rankAcd ? acdTaskCostOf(catalogue, acd) : aaTaskCostOf),
    [rankAcd, catalogue, acd, aaTaskCostOf],
  );
  /**
   * The dearest measured cost on screen. A ceiling past everything is a
   * no-op, not a number in the thousands — `<`/`>` stop here.
   */
  const maxOutput = useMemo(() => {
    let max: number | undefined;
    for (const ref of allModels) {
      const out = outputOf(ref);
      if (out !== undefined && (max === undefined || out > max)) max = out;
    }
    return max;
  }, [allModels, outputOf]);
  const maxTask = useMemo(() => {
    let max: number | undefined;
    for (const ref of allModels) {
      const t = taskCostOf(ref);
      if (t !== undefined && (max === undefined || t > max)) max = t;
    }
    return max;
  }, [allModels, taskCostOf]);
  const modelRows = useMemo(() => {
    // The benchmark display name, for the filter: `muse 1.3 max` matches by
    // AA's own wording as well as by ref. One adapter, both list builders.
    const nameOf = (ref: string): string | null =>
      scoresFor(catalogue, benchmarks, ref)?.name ?? null;
    if (view === "provider") {
      return orderedModels(allModels, openCode.favourites, openCode.recents, filter, {
        ...(hideUnscored ? { hideUnscored: true as const, scoreOf: aaScoreOf } : {}),
        ...(providerLock ? { providerLock } : {}),
        disabled: disabledProviders,
        nameOf,
        filterMode,
      });
    }
    return rankModels(allModels, view, {
      filter,
      filterMode,
      hideUnscored,
      ceiling,
      taskCeiling,
      favourites: openCode.favourites,
      ...(providerLock ? { providerLock } : {}),
      disabled: disabledProviders,
      scoreOf,
      outputOf,
      taskCostOf,
      nameOf,
      // Cost ranking answers in every flat view; only the provider branch never
      // gets here, grouped rather than ranked.
      rankBy: rankCost ? "cost" : "score",
    });
  }, [allModels, openCode, filter, filterMode, view, hideUnscored, ceiling, taskCeiling, scoreOf, aaScoreOf, outputOf, taskCostOf, rankCost, providerLock, disabledProviders, priceBasis, catalogue, benchmarks]);

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
   * `A` — ping every model shown.
   *
   * The list on screen, after the filter, the lock, the view and `H` — which is
   * why narrowing is how a big catalogue gets pinged: filter to `gpt`, or lock
   * to a provider, and `A` covers what is left. Refused above `PING_MAX` with
   * the number named, because a bare list of 651 would spend a hundred calls
   * on a gesture.
   *
   * Arming is explicit and cancelling is free: the first press names the spend
   * — how many models, how many calls, which models — and only `y` spends it.
   * `n`, `Esc` and every other key disarm without spending. There is no clock:
   * an arm is a state on screen, and the notice says what it will do until it
   * is cancelled or spent.
   */
  async function pingVisible() {
    const all = modelRows.items.map((i) => i.ref);
    // Skip any provider with no credential, rather than keeping a list of the
    // ones that are slow or switched off. `opencode models` offers splash and
    // bionic because they are local endpoints, not because anything is listening
    // — pinging them costs a timeout each and teaches nothing. Derived from
    // `opencode auth list`, so there is nothing here to maintain.
    const reachable = all.filter((ref) => authed.has(providerOf(ref)));
    const skipped = all.length - reachable.length;
    if (reachable.length === 0) {
      setNotice(all.length === 0 ? "nothing to ping — the list is empty" : "nothing to ping — no provider here has a key");
      return;
    }
    if (reachable.length > PING_MAX) {
      setNotice(
        `${reachable.length} shown — narrow to ${PING_MAX} or fewer with the filter, L, F, or a view, then A again`,
      );
      return;
    }
    if (
      pingArmed !== null &&
      pingArmed.length === reachable.length &&
      pingArmed.every((ref, i) => ref === reachable[i])
    ) {
      setPingArmed(null);
      setNotice(null);
      await runPing(reachable, "cheap");
      return;
    }
    setPingArmed(reachable);
    // The notice is the warning prompt: what will run, what it costs, how to
    // proceed, and what cancels. Names first, so a short list reads whole.
    const names =
      reachable.slice(0, 4).join(", ") + (reachable.length > 4 ? ` +${reachable.length - 4} more` : "");
    const costRankScope = rankCost && view !== "provider";
    const scope = [
      filter.trim() ? `matching "${filter.trim()}"` : "",
      providerLock ? `locked to ${providerLock}` : "",
      view !== "provider" ? `${view} view` : "",
      rankAcd && view !== "provider"
        ? costRankScope
          ? "ranked by ACD $/task"
          : "ranked by AI Coding Daily"
        : costRankScope
          ? "ranked by $/task"
          : "",
      hideUnscored ? "hiding unscored" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    setNotice(
      `ping ${reachable.length} shown (${reachable.length} calls): ${names}` +
        `${scope ? ` — ${scope}` : ""}` +
        `${skipped ? ` · ${skipped} skipped, no key for their provider` : ""}` +
        ` — press y to proceed, n or Esc to cancel`,
    );
  }

  /**
   * `Y` — the table as Markdown, for a second opinion elsewhere. Clipboard
   * first, `models.md` in the data dir always (the copy that works in every
   * terminal). Nothing here spends a model call: it only formats what the
   * picker already knows.
   *
   * The refs decide the scope: the whole shown table, or just the picker's
   * window. Callers name which — the context line in the Markdown says it, so
   * a pasted table never misleads about what it covers.
   */
  async function exportVisible(refs: string[], scope: "entire" | "window") {
    const md = exportModelsMd({
      refs,
      total: allModels.length,
      view,
      filter,
      providerLock,
      disabledProviders: [...disabledProviders],
      ceiling,
      taskCeiling,
      hideUnscored,
      subject: mode,
      catalogue,
      benchmarks,
      acd,
      probes,
      favourites: modelRows.favourite,
      scoresAt: benchMeta.at,
      indexVersion: benchMeta.indexVersion,
      acdAt: benchMeta.acdAt,
      rankAcd,
      rankCost,
      scope,
    });
    const file = path.join(advDataRoot(), "models.md");
    const result = await copyMarkdown(md, file);
    // The full path in both branches: `models.md` alone never says where, and
    // the notice is the only thing that does. Truncated to one row like the
    // rest of the chrome.
    if (result.via === "file") setNotice(`no clipboard here — the markdown is in ${file}`);
    else setNotice(`exported ${refs.length} models to the clipboard · also ${file}`);
  }

  /**
   * Arm the export choice: the whole shown table, or just the rows in the
   * picker's window. `Y` arms rather than fires, because "the table" is now
   * ambiguous — and like the ping-all, the notice names both options with
   * their counts, so `e`/`v` spend exactly what was named.
   */
  function armExport() {
    const entire = modelRows.items.map((i) => i.ref);
    const visible = modelRows.rows
      .slice(pickStart.current, pickStart.current + pickH)
      .filter((r): r is { kind: "model"; ref: string } => r.kind === "model")
      .map((r) => r.ref);
    setExportArm({ entire, visible });
    setNotice(
      `export ${entire.length} shown or just the ${visible.length} visible rows? — e all shown · v visible · Esc cancels`,
    );
  }

  /**
   * Every provider in the listing with its bill — the `F` switchboard's rows.
   * Derived like the `?` pane's, so the two can never disagree about who is who.
   */
  const provBills = useMemo(
    () => allProviderBills(allModels, catalogue, authed),
    [allModels, catalogue, authed],
  );

  /**
   * Switch one provider off or back on. Applies immediately — the picker
   * re-filters on return — and persists like the ceilings. Disabling the
   * locked provider clears the lock: a lock on a hidden provider is an empty
   * list with a stale reason.
   */
  async function toggleProvider(provider: string | undefined) {
    if (!provider) return;
    const next = new Set(disabledProviders);
    if (next.has(provider)) next.delete(provider);
    else next.add(provider);
    if (providerLock !== null && next.has(providerLock)) setProviderLock(null);
    setDisabledProviders(next);
    setPickIndex(0);
    await saveDisabledProviders([...next]);
  }

  /**
   * Record a use of the filter. A use is anything that proves the filter did
   * something: moving through the narrowed list, a command that acts on it or
   * changes its lens, `R`, Enter, Esc. Final commits end the visit's
   * provisional entry; provisional ones replace it as the filter is refined.
   * Empty text and OFF-mode text record nothing, and an unchanged head skips
   * the write, so leaving twice rewrites nothing.
   */
  function commitFilter(final: boolean) {
    if (filterDebounce.current !== null) {
      clearTimeout(filterDebounce.current);
      filterDebounce.current = null;
    }
    const t = filter.trim();
    if (!t || filterMode === "off") return;
    const prev = filterVisit.current?.text ?? null;
    const head = filterHistory[0];
    if (head && head.text.toLowerCase() === t.toLowerCase() && head.mode === filterMode) {
      if (final) filterVisit.current = null;
      return;
    }
    const next = recordFilterUse(filterHistory, { prev, text: filter, mode: filterMode });
    setFilterHistory(next);
    void saveFilterHistory(next);
    filterVisit.current = final ? null : { text: t };
  }

  /**
   * The pause-commit: typing stopped, so the settled filter is recorded
   * provisionally. Every edit re-arms it; any commit or visit reset stands it
   * down. Fires through a ref so the timer always runs the latest render's
   * commit, not the keystroke's.
   */
  function pokeFilter() {
    if (filterDebounce.current !== null) clearTimeout(filterDebounce.current);
    filterDebounce.current = setTimeout(() => {
      filterDebounce.current = null;
      commitProvisional.current();
    }, FILTER_IDLE_MS);
  }

  /** A fresh visit: nothing provisional behind it and no timer running. */
  function resetFilterVisit() {
    if (filterDebounce.current !== null) {
      clearTimeout(filterDebounce.current);
      filterDebounce.current = null;
    }
    filterVisit.current = null;
  }

  /** Latest provisional commit, for the idle timer that outlives its render. */
  const commitProvisional = useRef(() => {});
  commitProvisional.current = () => commitFilter(false);

  /** The provider pane scrolls and closes itself; `Scroller` owns its keys. */
  /* Model picker. */
  useInput(
    (input, key) => {
      if (!cfg) return;
      // Items, not rows: group and provider headers are not cursor targets, and
      // indexing `rows` directly is how the cursor used to land on a header.
      const items = modelRows.items;
      const chosen = items[pickIndex]?.ref;

      // An armed export answers `e`/`v`/`Esc`, handled below; any other key
      // stands it down first, then behaves normally. Otherwise a re-filtered
      // list could fire an arm that named something else — and the notice is
      // the arm's own (nothing async writes notices while one is up), so
      // clearing it loses nothing.
      if (exportArm !== null && input !== "e" && input !== "v" && !key.escape) {
        setExportArm(null);
        setNotice(null);
      }

      if (key.escape) {
        // Armed first: Esc stands down the ping-all or the export choice and
        // stays, so `n`/`Esc` both mean no to a ping and Esc means never mind
        // to an export. Unarmed, Esc leaves for where this list was opened —
        // and a half-built pair is dropped, so a cancelled build leaves nothing.
        if (pingArmed !== null) {
          setPingArmed(null);
          setNotice(null);
          return;
        }
        if (exportArm !== null) {
          setExportArm(null);
          setNotice(null);
          return;
        }
        if (pickMode === "build") {
          commitFilter(true);
          setPairDraft({ drafter: null, reviewer: null });
          setBuildStep(null);
          setPhase("pairs");
          return;
        }
        commitFilter(true);
        setPhase(pickMode === "browse" ? "home" : "start");
        return;
      }
      if (key.upArrow) {
        setPingArmed(null);
        commitFilter(false);
        setPickIndex((i) => clampIndex(i - 1, items.length));
        return;
      }
      if (key.downArrow) {
        setPingArmed(null);
        commitFilter(false);
        setPickIndex((i) => clampIndex(i + 1, items.length));
        return;
      }
      if (key.return) {
        // Browsing: Enter is inert — this list assigns nothing from home.
        if (pickMode === "browse") return;
        // Building: the first pick is the drafter, the second the reviewer,
        // and only the pair of them is ever named or saved.
        if (pickMode === "build") {
          if (!chosen) return;
          const picked: ModelRef = { ref: chosen, family: familyOf(chosen) };
          if (buildStep !== "reviewer") {
            commitFilter(true);
            setPairDraft({ drafter: picked, reviewer: null });
            setBuildStep("reviewer");
            setFilter("");
            setFilterCaret(0);
            setPickIndex(0);
            return;
          }
          if (!pairDraft.drafter) return;
          commitFilter(true);
          setPairDraft({ drafter: pairDraft.drafter, reviewer: picked });
          setPairRename(null);
          const builtName = suggestPairName({ drafter: pairDraft.drafter, reviewer: picked });
          setPairName(builtName);
          setPairCaret(builtName.length);
          setNotice(null);
          setPhase("pairname");
          return;
        }
        if (chosen) {
          const next: Config = {
            ...cfg,
            models: { ...cfg.models, [pickRole]: { ref: chosen, family: familyOf(chosen) } },
          };
          void persist(next, mode).then(() => setNotice(`saved ${pickRole}: ${chosen}`));
        }
        commitFilter(true);
        setPingArmed(null);
        setPhase("start");
        return;
      }
      // `?` before the text handling below: it is a key, not a character to filter.
      if (input === "?") {
        setPingArmed(null);
        commitFilter(true);
        setPhase("providers");
        return;
      }
      // Uppercase only, deliberately. `p` as a ping key made the letter `p`
      // untypeable in the filter, and every one of the 651 refs is lowercase —
      // so the command keys take the case nothing needs.
      if (input === "P") {
        setPingArmed(null);
        commitFilter(true);
        if (chosen) void runPing([chosen], "cheap");
        return;
      }
      if (input === "T") {
        setPingArmed(null);
        commitFilter(true);
        if (chosen) void runPing([chosen], "full");
        return;
      }
      if (input === "A") {
        commitFilter(true);
        void pingVisible();
        return;
      }
      // `y` proceeds with an armed ping-all, `n` stands it down — the explicit
      // yes and no to the notice's warning. Checked before the filter text
      // below: while armed, neither types. Anything else disarms (every branch
      // above already does) and behaves normally.
      if (input === "y" && pingArmed !== null) {
        commitFilter(true);
        void pingVisible();
        return;
      }
      if (input === "n" && pingArmed !== null) {
        setPingArmed(null);
        setNotice(null);
        return;
      }
      // `Y` arms the export choice — entire shown table or just the visible
      // window — rather than firing: "the table" is ambiguous now. `e`/`v`
      // spend what the notice named; anything else stands down and behaves
      // normally. Uppercase like the rest, so lowercase keeps typing into
      // the filter. Disarms the ping first: an export is not a confirmation.
      if (input === "Y") {
        setPingArmed(null);
        commitFilter(true);
        armExport();
        return;
      }
      if (input === "e" && exportArm !== null) {
        const { entire } = exportArm;
        setExportArm(null);
        commitFilter(true);
        void exportVisible(entire, "entire");
        return;
      }
      if (input === "v" && exportArm !== null) {
        const { visible } = exportArm;
        setExportArm(null);
        commitFilter(true);
        void exportVisible(visible, "window");
        return;
      }
      // `B` refreshes the benchmark caches: OpenRouter plus Artificial Analysis
      // direct when a key is stored, merged Artificial-Analysis-first — and AI
      // Coding Daily's coding leaderboard alongside, on its own cache. Unlike
      // `P`/`T`/`A` it asks nothing twice — a few requests against weekly
      // caches. Uppercase like the rest, so lowercase keeps typing into the
      // filter.
      if (input === "B") {
        setPingArmed(null);
        commitFilter(true);
        void refreshBenchmarks(false);
        void refreshAcd(false);
        return;
      }
      // `C` toggles the price basis: the base price (`low`) or the
      // above-threshold price (`high`) a long session pays. Both the cells
      // and the value view's ceiling move together, so the filter always
      // means "at or under the shown price". The cursor resets because the
      // value view's membership can change with it.
      if (input === "C") {
        setPingArmed(null);
        commitFilter(true);
        setPriceBasis((b) => (b === "low" ? "high" : "low"));
        setPickIndex(0);
        return;
      }
      // `V` cycles the view — provider, intelligence, value, taskcost — `H`
      // hides the unscored. Uppercase like the rest; the cursor resets because
      // each view is a different list.
      if (input === "V") {
        setPingArmed(null);
        commitFilter(true);
        setView((v) =>
          v === "provider" ? "intelligence" : v === "intelligence" ? "value" : v === "value" ? "taskcost" : "provider",
        );
        setPickIndex(0);
        return;
      }
      if (input === "H") {
        setPingArmed(null);
        commitFilter(true);
        setHideUnscored((h) => !h);
        setPickIndex(0);
        return;
      }
      // `D` ranks the flat views by AI Coding Daily — points for the order,
      // ACD $/task for the taskcost ceiling — instead of AA/OpenRouter. Ignored
      // in the provider view, which is grouped rather than ranked; the state
      // persists, so coming back restores the D ranking. The cursor resets
      // because a re-ranked list is a different list.
      if (input === "D") {
        if (view === "provider") return;
        setPingArmed(null);
        commitFilter(true);
        setRankAcd((r) => !r);
        setPickIndex(0);
        return;
      }
      // `S` ranks the flat views by measured cost — $/task, or ACD $/task
      // with `D` — instead of by score. Cheapest first, unmeasured trailing.
      // Ignored in the provider view, which is grouped rather than ranked.
      // Like `D` the state persists across views, so coming back restores it.
      if (input === "S") {
        if (view === "provider") return;
        setPingArmed(null);
        commitFilter(true);
        setRankCost((r) => !r);
        setPickIndex(0);
        return;
      }
      // `L` locks the list to the highlighted model's provider — pick an
      // opencode-go model, lock, and the list is opencode-go. The view, the
      // filter and `H` all still apply inside the lock, and so does the
      // ping-all: `A` pings only what is shown. Press again to clear. Uppercase
      // like the rest, so lowercase keeps typing into the filter; the cursor
      // resets because a locked list is a different list.
      if (input === "L") {
        setPingArmed(null);
        commitFilter(true);
        setProviderLock((lock) => (lock ? null : chosen ? providerOf(chosen) : null));
        setPickIndex(0);
        return;
      }
      // `F` lists every provider with a checkbox for whether the picker
      // shows it — the multi-provider version of `L`'s single lock, applied
      // to every view. Uppercase like the rest, so lowercase keeps typing
      // into the filter.
      if (input === "F") {
        setPingArmed(null);
        commitFilter(true);
        setProvFilterIndex(0);
        setPhase("provfilter");
        return;
      }
      // `R` keeps the current filter, then recalls past ones — newest first.
      // The arrows are free on that screen, which is the whole point: the
      // list owns them here. Uppercase like the rest, so lowercase keeps
      // typing into the filter. With nothing typed, it just opens history.
      if (input === "R") {
        setPingArmed(null);
        commitFilter(true);
        setFilterHistIndex(0);
        setHistClearArmed(false);
        setPhase("filterhist");
        return;
      }
      // `<`/`>` move the ceiling of the cheap view on screen. Value steps
      // additively ($0.10 — output prices cluster near a dollar); taskcost
      // steps geometrically (×1.5 — task costs span cents to dollars, and an
      // additive stride cannot resolve the $0.01–$0.15 cluster). No ref
      // contains either, so nothing is lost to the filter anywhere else.
      // Neither ceiling passes the dearest measured cost: past everything is
      // a no-op, not a number in the thousands.
      if ((input === "<" || input === ">") && (view === "value" || view === "taskcost")) {
        setPingArmed(null);
        const dir = input === ">" ? 1 : -1;
        if (view === "value") {
          const next = Math.min(
            roundCeiling(Math.max(0, ceiling + dir * CEILING_STEP)),
            maxOutput ?? Number.POSITIVE_INFINITY,
          );
          setCeiling(next);
          void saveCeiling(next);
        } else {
          const next = Math.min(stepCeiling(taskCeiling, dir), maxTask ?? Number.POSITIVE_INFINITY);
          setTaskCeiling(next);
          void saveTaskCeiling(next);
        }
        return;
      }
      // Paging before the control swallow below: Ctrl+F/B move a page and
      // Ctrl+D/U half a page, matching the results-view scroller exactly.
      // Plain `f`/`b` stay typeable in the filter, which is why these are
      // control combos here and letters there. The page is the visible list,
      // from the viewport budget — not a constant.
      if (key.ctrl && input === "f") {
        setPingArmed(null);
        commitFilter(false);
        setPickIndex((i) => clampIndex(i + pickH, items.length));
        return;
      }
      if (key.ctrl && input === "b") {
        setPingArmed(null);
        commitFilter(false);
        setPickIndex((i) => clampIndex(i - pickH, items.length));
        return;
      }
      if (key.ctrl && input === "d") {
        setPingArmed(null);
        commitFilter(false);
        setPickIndex((i) => clampIndex(i + Math.ceil(pickH / 2), items.length));
        return;
      }
      if (key.ctrl && input === "u") {
        setPingArmed(null);
        commitFilter(false);
        setPickIndex((i) => clampIndex(i - Math.ceil(pickH / 2), items.length));
        return;
      }
      // Line editing for the filter, readline-style. ^B/^D/^U page above, so
      // ^A/^E are free, and rows move on up/down — left/right belong to the text.
      const fcur = Math.max(0, Math.min(filterCaret, filter.length));
      if (key.ctrl && input === "a") {
        setFilterCaret(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setFilterCaret(filter.length);
        return;
      }
      if (key.leftArrow) {
        setFilterCaret((c) => Math.max(0, Math.min(c, filter.length) - 1));
        return;
      }
      if (key.rightArrow) {
        setFilterCaret((c) => Math.min(filter.length, Math.max(0, c) + 1));
        return;
      }
      if (key.backspace) {
        setPingArmed(null);
        setNotice(null);
        if (fcur > 0) {
          setFilter(filter.slice(0, fcur - 1) + filter.slice(fcur));
          setFilterCaret(fcur - 1);
        }
        setPickIndex(0);
        pokeFilter();
        return;
      }
      if (key.delete) {
        setPingArmed(null);
        setNotice(null);
        if (fcur < filter.length) setFilter(filter.slice(0, fcur) + filter.slice(fcur + 1));
        setPickIndex(0);
        pokeFilter();
        return;
      }
      // Tab cycles AND → OR → OFF. Before the printable branch: it would
      // otherwise type a literal tab into the filter. The list is a different
      // list either way, so the cursor resets like every other filter edit —
      // and OFF keeps the text, so cycling back restores it. Re-arms the
      // pause-commit: the mode is part of the entry, so a mode switch after
      // a pause records the entry as it now runs.
      if (key.tab) {
        setPingArmed(null);
        setNotice(null);
        setFilterMode((m) => (m === "and" ? "or" : m === "or" ? "off" : "and"));
        setPickIndex(0);
        pokeFilter();
        return;
      }
      if (key.ctrl || key.meta) return;
      // Mouse reports arrive as input; the filter is text, so it refuses them.
      if (input) {
        setPingArmed(null);
        setNotice(null);
        setFilter(filter.slice(0, fcur) + input + filter.slice(fcur));
        setFilterCaret(fcur + input.length);
        setPickIndex(0);
        pokeFilter();
      }
    },
    { isActive: phase === "pick" },
  );

  /**
   * The provider switchboard. No text field here, so lowercase answers too:
   * space toggles the highlighted provider, `a` switches everything back
   * on, `o` switches everything off, Esc returns to the picker. The cursor
   * resets nowhere — the provider list is stable while toggles fly, unlike
   * the picker's.
   */
  useInput(
    (input, key) => {
      if (key.escape) {
        setPhase("pick");
        return;
      }
      if (key.upArrow) {
        setProvFilterIndex((i) => clampIndex(i - 1, provBills.length));
        return;
      }
      if (key.downArrow) {
        setProvFilterIndex((i) => clampIndex(i + 1, provBills.length));
        return;
      }
      if (input === " " || key.return) {
        void toggleProvider(provBills[provFilterIndex]?.provider);
        return;
      }
      if (input === "a" || input === "A") {
        setDisabledProviders(new Set());
        setPickIndex(0);
        void saveDisabledProviders([]);
        return;
      }
      if (input === "o" || input === "O") {
        // Everything off is allowed: the picker shows its empty state, and
        // the switchboard itself says why. The lock goes too — a lock on a
        // hidden provider is an empty list with a stale reason.
        const allOff = new Set(provBills.map((b) => b.provider));
        setDisabledProviders(allOff);
        setProviderLock(null);
        setPickIndex(0);
        void saveDisabledProviders([...allOff]);
        return;
      }
    },
    { isActive: phase === "provfilter" },
  );

  /**
   * The filter-history panel. No text field here, so the arrows choose —
   * which is the whole point: the list owns them on the picker. `d` removes
   * the row (it is a line of text, and the panel shows the result); `D` arms
   * "clear all?", like a ping-all, and only `y` spends it. Enter applies the
   * text and its AND/OR mode; the view, the lock and the ceilings stay put.
   */
  useInput(
    (input, key) => {
      // An armed clear-all answers `y`/`n`/`Esc` and stays; anything else
      // stands it down first, then behaves normally.
      if (histClearArmed && !key.ctrl && !key.meta && (input === "y" || input === "Y")) {
        const n = filterHistory.length;
        setFilterHistory([]);
        setFilterHistIndex(0);
        setHistClearArmed(false);
        setNotice(n === 0 ? "filter history is already empty" : `cleared ${n} filter${n === 1 ? "" : "s"}`);
        void saveFilterHistory([]);
        return;
      }
      if (histClearArmed && !key.ctrl && !key.meta && (input === "n" || input === "N" || key.escape)) {
        setHistClearArmed(false);
        setNotice(null);
        return;
      }
      const standDown = () => {
        if (histClearArmed) {
          setHistClearArmed(false);
          setNotice(null);
        }
      };

      if (key.escape) {
        setPhase("pick");
        return;
      }
      if (key.upArrow) {
        standDown();
        setFilterHistIndex((i) => clampIndex(i - 1, filterHistory.length));
        return;
      }
      if (key.downArrow) {
        standDown();
        setFilterHistIndex((i) => clampIndex(i + 1, filterHistory.length));
        return;
      }
      if (key.return) {
        const entry = filterHistory[filterHistIndex];
        if (!entry) return;
        standDown();
        setNotice(null);
        setFilter(entry.text);
        setFilterCaret(entry.text.length);
        setFilterMode(entry.mode);
        setPickIndex(0);
        // Applying is using, so it front-bumps — unless it is already newest,
        // when saving would rewrite the file for nothing.
        const head = filterHistory[0];
        if (!head || head.text.toLowerCase() !== entry.text.toLowerCase() || head.mode !== entry.mode) {
          const next = addFilterHistory(filterHistory, entry.text, entry.mode);
          setFilterHistory(next);
          void saveFilterHistory(next);
        }
        setPhase("pick");
        return;
      }
      // Paging before the `d` branch below: Ctrl+D moves half a page, plain
      // `d` removes the row. The page is the visible list, like the picker's.
      if (key.ctrl && input === "f") {
        standDown();
        setFilterHistIndex((i) => clampIndex(i + filterHistH, filterHistory.length));
        return;
      }
      if (key.ctrl && input === "b") {
        standDown();
        setFilterHistIndex((i) => clampIndex(i - filterHistH, filterHistory.length));
        return;
      }
      if (key.ctrl && input === "d") {
        standDown();
        setFilterHistIndex((i) => clampIndex(i + Math.ceil(filterHistH / 2), filterHistory.length));
        return;
      }
      if (key.ctrl && input === "u") {
        standDown();
        setFilterHistIndex((i) => clampIndex(i - Math.ceil(filterHistH / 2), filterHistory.length));
        return;
      }
      if (input === "d" && !key.ctrl && !key.meta) {
        const entry = filterHistory[filterHistIndex];
        if (!entry) return;
        standDown();
        setNotice(null);
        const next = removeFilterHistory(filterHistory, entry.text);
        setFilterHistory(next);
        setFilterHistIndex((i) => clampIndex(i, next.length));
        void saveFilterHistory(next);
        return;
      }
      // `D` arms the clear-all — how many filters, what confirms, what
      // cancels — and only `y` spends it, like a ping-all.
      if (input === "D" && !key.ctrl && !key.meta) {
        if (filterHistory.length === 0) return;
        setHistClearArmed(true);
        const n = filterHistory.length;
        setNotice(`clear ${n} filter${n === 1 ? "" : "s"}? — y clears, n or Esc keeps`);
        return;
      }
      if (key.ctrl || key.meta) return;
    },
    { isActive: phase === "filterhist" },
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
          `Choose a reviewer from another family on the debate screen (↑↓ to choose models).`,
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
   * visible rows is a row you cannot see you are about to delete. The height
   * is the viewport budget, computed with the frame layout below.
   */

  // Only while the list is the screen: otherwise a wheel notch on a result
  // would move a cursor nobody can see.
  useWheelScroll(
    (rows) => moveRuns(runsCursor.current + Math.sign(rows)),
    phase === "runs",
  );

  // The picker and the pair list scroll under the wheel like every other pane:
  // the status line promises it on all screens. The picker moves by rows (a
  // notch is three, matching the scroller's step); the pair list moves one row
  // a notch. Both disarm a ping-all, like every other cursor key does.
  useWheelScroll(
    (rows) => {
      setPingArmed(null);
      commitFilter(false);
      setPickIndex((i) => clampIndex(i + rows, modelRows.items.length));
    },
    phase === "pick",
  );
  useWheelScroll(
    (rows) =>
      setPairIndex((i) => {
        const dir = Math.sign(rows) >= 0 ? 1 : -1;
        let at = clampIndex(i + dir, pairVisible.length);
        while (pairVisible[at]?.kind === "gap") at = clampIndex(at + dir, pairVisible.length);
        return at;
      }),
    phase === "pairs",
  );
  useWheelScroll(
    (rows) => setProvFilterIndex((i) => clampIndex(i + Math.sign(rows), provBills.length)),
    phase === "provfilter",
  );
  useWheelScroll(
    (rows) => setFilterHistIndex((i) => clampIndex(i + Math.sign(rows), filterHistory.length)),
    phase === "filterhist",
  );

  function moveRuns(next: number) {
    const index = Math.max(0, Math.min(runs.length - 1, next));
    runsCursor.current = index;
    setRunsIndex(index);
    setRunsOffset((offset) => {
      if (index < offset) return index;
      if (index >= offset + runsH) return index - runsH + 1;
      return clampOffset(offset, runs.length, runsH);
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
    // directory. Back home rather than to a stale result.
    if (head && result.deleted.includes(head.paths.dir)) {
      setHead(null);
      setTail(null);
      setGate(null);
      setRunTask("");
      addLog("the run on screen was deleted — back home");
      setPhase("home");
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
    const { dir } = run;
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
      // Not logged: the gate and result screens show this run's own task,
      // models and state, and a log line would follow every later screen.
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
        moveRuns(runsCursor.current + runsH);
        return;
      }
      if (key.pageUp || input === "b") {
        moveRuns(runsCursor.current - runsH);
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
        setPhase("home");
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

  /* Fullscreen budgets: the frame is the terminal, so every screen takes its
     rows from the viewport rather than a constant. `contentRows` is the frame
     minus the pinned mouse line; the log shows the last rows that leave the
     content its minimum (while running, the log is the screen and fills);
     each screen then subtracts only its own chrome. The content box below is
     `overflow="hidden"`, so a screen that miscounts clips instead of pushing
     the frame past the terminal. */
  const termRows = useTerminalRows();
  // Both dimensions subscribe: columns drive the hint wrap below, and a
  // width-only resize must re-render the App — nothing else recomputes the
  // wrapped rows, so without this the menu stays wrapped to the old width
  // until the next keypress.
  const termCols = useTerminalWidth();
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
  const usable = contentRows(termRows);
  const running = phase === "running" || phase === "working";
  const logWant = logWindow(logRows.length, usable, {
    label: logLabel !== null,
    minContent: running ? 0 : MIN_CONTENT_ROWS,
    maxLog: running ? usable : LOG_MAX_ROWS,
  });
  // The hints wrap to the terminal width (see `hints.ts`), uncapped — the
  // menu shows everything. What yields instead is the log window: it shrinks
  // toward what is left after the picker takes the full menu with a 3-row
  // list, and only past that do the list (toward 1) and finally the menu
  // itself (marked with `…`) give way. A resize re-renders through the same
  // `resize` event as the rows, so budget and screen cannot disagree.
  const hintState: HintState = {
    pickMode,
    buildStep,
    view,
    rankAcd,
    rankCost,
    providerLock,
    disabledCount: disabledProviders.size,
    filterMode,
    ceiling,
    taskCeiling,
  };
  const hintText = buildHintText(hintState);
  const hintW = hintWidth(termCols);
  const hintFullCount = wrapHintLines(hintText, hintW).length;
  const logTake = Math.min(
    logWant,
    Math.max(0, usable - pickContentWants(hintFullCount, notice !== null) - (logLabel !== null ? 1 : 0)),
  );
  const contentH = Math.max(1, usable - logTake - (logLabel !== null ? 1 : 0));
  const scrollerH = scrollerHeight(contentH, notice !== null);
  const hintLines = wrapHintLines(
    hintText,
    hintW,
    pickHintAllowed(contentH, notice !== null, hintFullCount),
  );
  const pickH = pickListHeight(contentH, notice !== null, hintLines.length);
  const runsH = runsListHeight(contentH);
  const filterHistH = filterHistoryListHeight(contentH, notice !== null);

  /* The exit recap: the alternate screen leaves with the log, so the shell
     gets the record instead — state, run directory, and where the plan went.
     Short lines, printed after Ink restores the shell. (Per-call costs stay in
     the log; no total is tracked, so none is claimed.) */
  const recap = !head
    ? null
    : tail
      ? `done · ${displayPath(head.paths.dir)}\nplan: ${displayPath(head.paths.planV2)}`
      : phase === "error" && error
        ? `failed · ${displayPath(head.paths.dir)}\n${error.split("\n")[0]}`
        : `parked · ${displayPath(head.paths.dir)}\nresume: adv run --resume ${path.basename(head.paths.dir)}`;
  useEffect(() => {
    onRecap?.(recap);
  }, [recap, onRecap]);

  let content: ReactNode;

  if (phase === "setup") {
    content = <Setup repo={repo} selection={setupSelection} />;
  } else if (phase === "home") {
    content = (
      <Home
        selection={homeSel}
        setSelection={setHomeSel}
        notice={notice}
        onChoose={(i) => chooseHome(i)}
      />
    );
  } else if (phase === "settings" && cfg) {
    content = (
      <Settings selection={settingsSel} saved={saved} pair={currentPairName} aaKey={aaKeySet} />
    );
  } else if (phase === "aakey") {
    content = <AAKey value={aaKeyInput} caret={aaKeyCaret} busy={aaKeyBusy} notice={notice} hasKey={aaKeySet} />;
  } else if (phase === "pick") {
    content = (
      <Pick
        role={pickRole}
        pickMode={pickMode}
        list={modelRows}
        filter={filter}
        filterCaret={filterCaret}
        filterMode={filterMode}
        index={pickIndex}
        height={pickH}
        pickStart={pickStart}
        catalogue={catalogue}
        probes={probes}
        benchmarks={benchmarks}
        acd={acd}
        view={view}
        hideUnscored={hideUnscored}
        ceiling={ceiling}
        pinging={pinging}
        keyed={new Set(authed.keys())}
        subject={mode}
        notice={notice}
        providerLock={providerLock}
        disabledCount={disabledProviders.size}
        aaKey={aaKeySet}
        rankAcd={rankAcd}
        rankCost={rankCost}
        buildStep={buildStep}
        priceBasis={priceBasis}
        taskCeiling={taskCeiling}
        hintLines={hintLines}
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
        height={scrollerH}
        onClose={() => setPhase("pick")}
      />
    );
  } else if (phase === "provfilter") {
    content = (
      <ProviderFilter
        bills={provBills}
        disabled={disabledProviders}
        index={provFilterIndex}
        height={providerFilterListHeight(contentH, notice !== null)}
        notice={notice}
      />
    );
  } else if (phase === "filterhist") {
    content = (
      <FilterHistory
        entries={filterHistory}
        index={filterHistIndex}
        height={filterHistH}
        notice={notice}
      />
    );
  } else if (phase === "pairs") {
    // The selected pair's warnings take rows of their own, so the list budget
    // subtracts them: a warning must never push a row off the screen.
    const pairAt = pairVisible[pairIndex];
    const pairWarn = pairAt && pairAt.kind === "saved" ? pairAt.warnings.length : 0;
    content = (
      <Pairs
        rows={pairScreen}
        index={pairIndex}
        height={pairsListHeight(contentH, pairWarn, notice !== null)}
        current={cfg?.models ?? null}
        currentLine={
          cfg ? `${cfg.models.drafter.ref} [${cfg.models.drafter.family}]  ->  ${cfg.models.reviewer.ref} [${cfg.models.reviewer.family}]` : null
        }
        scope={pairOrigin === "debate" ? "preset" : "manage"}
        notice={notice}
        loading={pairLoading}
      />
    );
  } else if (phase === "pairname") {
    const renaming = pairRename ? savedPairs.find((p) => p.name === pairRename) : undefined;
    const naming =
      renaming != null
        ? `${renaming.drafter.ref} -> ${renaming.reviewer.ref}`
        : pairDraft.drafter && pairDraft.reviewer
          ? `${pairDraft.drafter.ref} -> ${pairDraft.reviewer.ref}`
          : cfg
            ? `${cfg.models.drafter.ref} -> ${cfg.models.reviewer.ref}`
            : null;
    content = (
      <PairName
        value={pairName}
        caret={pairCaret}
        known={savedPairs.map((p) => p.name)}
        maxShown={cappedLines(contentH, 8)}
        models={naming}
        renameFrom={pairRename}
      />
    );
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
        deskSel={deskSel}
        setDeskSel={setDeskSel}
        notice={notice}
        pair={currentPairName}
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
        onPick={(role) => void openPick(role)}
        onPickPair={() => void openPairs("debate")}
        onSettings={() => void openSettings()}
        onHome={() => openHome()}
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
        maxLines={cappedLines(contentH, 9)}
        onAnswer={(ok) => void (ok ? deleteSelected(pendingDelete) : setPendingDelete(null))}
      />
    ) : (
      <Runs
        runs={runs}
        index={runsIndex}
        offset={runsOffset}
        height={runsH}
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
          height={scrollerH}
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
          contentH={contentH}
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
        height={scrollerH}
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
        height={scrollerH}
        escLabel={openedFrom === "runs" ? "Esc back to the list" : "Esc back"}
        escCloses={false}
        onEsc={goBack}
        // Short on purpose: the pane's height is the content minus the chrome,
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
              usually means too many searches. Try a different reviewer on the
              debate screen (↑↓ to choose models), or a narrower question.
            </Text>
          </Box>
        )}
        {error.startsWith("validation failed") && (
          <Box marginTop={1}>
            <Text dimColor>
              That is the model's reply, not a bug in adv: it did not fit the
              expected shape, twice. Try again, or choose a different reviewer
              on the debate screen (↑↓ to choose models).
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
    /* Fullscreen: the frame is the terminal, so it is exactly `termRows` high —
       the bounded log on top, the screen in the middle, the mouse line pinned
       last. The middle clips (`overflow="hidden"`) rather than growing: a
       screen taller than its budget loses rows instead of pushing the frame
       past the terminal and corrupting the redraw. */
    <Box flexDirection="column" height={termRows}>
      <Log lines={logRows} label={logLabel} maxLines={logTake} />
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {content}
      </Box>
      {/* Which mode the mouse is in, on every screen: the two modes do
          different things with a drag, and a reader who cannot see which one
          they are in has a mouse that seems to work at random. Truncated rather
          than wrapped, so it is always exactly one row. */}
      <Box flexShrink={0} height={1}>
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
              { text: " — drag to select text · Ctrl+T takes it back", dim: true },
            ]}
          />
        )}
      </Box>
    </Box>
  );
}

export async function startTui(opts: { repo: string; altScreen?: boolean }): Promise<void> {
  // Without this the wheel scrolls the terminal's scrollback instead of the
  // pane, and there is no way to ask for it later: the terminal has to be told
  // before it stops handling the wheel itself.
  process.stdout.write(MOUSE_ON);
  // Written unconditionally: taking reporting away from a terminal that already
  // gave it up costs nothing, and this is the path that must not be missed.
  const handBack = () => process.stdout.write(MOUSE_OFF);
  process.once("exit", handBack);
  // The alternate screen leaves with the log, so the run's record goes to the
  // shell instead. Collected through the session, printed after Ink restores
  // the primary screen.
  let recap: string | null = null;
  try {
    const app = render(<App repo={opts.repo} onRecap={(text) => { recap = text; }} />, {
      alternateScreen: opts.altScreen ?? true,
    });
    await app.waitUntilExit();
  } finally {
    handBack();
    process.removeListener("exit", handBack);
  }
  if (recap) console.log(`\n${recap}`);
}
