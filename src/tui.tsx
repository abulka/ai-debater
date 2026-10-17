import { Box, Text, render, useApp, useInput } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import { loadConfig, saveConfig } from "./config.ts";
import type { Config } from "./config.ts";
import type { Claims, Gate, Review } from "./contracts.ts";
import { advState, initRepo } from "./init.ts";
import {
  answersToGate,
  buildItems,
  clampOffset,
  gateWarnings,
  maxOffset,
  readEvidenceContext,
  statusLine,
  verdictCounts,
  type GateAnswer,
  type GateItem,
} from "./gate-model.ts";
import { familyClash, familyOf, listModels } from "./models.ts";
import { appendDecisions, displayPath, readCriteria, readDecisions } from "./orchestrator.ts";
import { runHead, runTail, saveGate, type Head, type Reporting, type Tail } from "./pipeline.ts";
import { renderResult } from "./render.ts";
import type { Mode } from "./runner.ts";

type Phase =
  | "setup"
  | "start"
  | "settings"
  | "pick"
  | "running"
  | "gate"
  | "working"
  | "result"
  | "error";

type Panel = { title: string; lines: string[] };

function Header({ right }: { right: string }) {
  return (
    <Box>
      <Text bold>adv</Text>
      <Text dimColor>  {right}</Text>
    </Box>
  );
}

function QuitHint() {
  const { exit } = useApp();
  useInput((input, key) => {
    if (key.ctrl && input === "c") exit();
  });
  return null;
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
  onClose,
}: {
  title: string;
  lines: string[];
  footer: string;
  onClose: () => void;
}) {
  const height = paneHeight(7);
  const [offset, setOffset] = useState(0);

  useInput((input, key) => {
    if (key.escape || input === "q") {
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
          <Text key={i}>{line}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {lines.length === 0 ? "empty" : `${offset + 1}–${Math.min(lines.length, offset + height)} of ${lines.length}`}
          {" · ↑↓ scroll · Esc back"}
        </Text>
      </Box>
      <Box>
        <Text dimColor>{footer}</Text>
      </Box>
      <QuitHint />
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
              <Text color={i === selection ? "cyan" : undefined}>{i === selection ? "❯ " : "  "}</Text>
              <Text color={i === selection ? "cyan" : undefined} bold={i === selection}>
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
      <QuitHint />
    </Box>
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
        <Text dimColor>mode    </Text>
        <Text color="cyan">{mode === "answer" ? "answer" : "plan"}</Text>
        <Text dimColor>
          {"  "}
          {mode === "answer"
            ? "a general question — no repository assumed"
            : "an implementation plan for this repository"}
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
          <Text>{task}</Text>
        ) : (
          <Text dimColor>
            {mode === "answer" ? "Type your question, then press Enter…" : "Describe the task, then press Enter…"}
          </Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter run · Tab mode · Ctrl+P settings · Ctrl+C quit</Text>
      </Box>
      <Box>
        <Text dimColor>models, criteria and decisions live in {repo}/.adv/</Text>
      </Box>
      <QuitHint />
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
    { label: "mode", value: mode === "answer" ? "answer — general question" : "plan — repository" },
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
          <Text color={i === selection ? "cyan" : undefined}>{i === selection ? "❯ " : "  "}</Text>
          <Text color={i === selection ? "cyan" : undefined} bold={i === selection}>
            {r.label.padEnd(10)}
          </Text>
          <Text>{r.value}</Text>
        </Box>
      ))}
      {clash && (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">! {clash}</Text>
          <Text dimColor>
            {cfg.familyCheck === "require"
              ? "familyCheck: require — runs here will refuse to start."
              : "fine for testing. Set familyCheck to \"require\" in .adv/config.json for a trial."}
          </Text>
        </Box>
      )}
      {saved && (
        <Box marginTop={1}>
          <Text color="green">{saved}</Text>
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
              <Text color={selected ? "cyan" : undefined}>{selected ? "❯ " : "  "}</Text>
              <Text color={selected ? "cyan" : undefined} bold={selected}>
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

function Busy({ label, log }: { label: string; log: string[] }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, []);
  const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame % 10];

  // Keep the last few lines in view: a long run would otherwise scroll the
  // interesting part (what is happening now) off the top.
  const height = paneHeight(6);
  const start = Math.max(0, log.length - height);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right={label} />
      </Box>
      {log.length === 0 && <Text dimColor>{spinner} starting…</Text>}
      {log.slice(start).map((line, i) => {
        const last = start + i === log.length - 1;
        return (
          <Box key={start + i}>
            <Text color="yellow">{last ? `${spinner} ` : "  "}</Text>
            <Text dimColor={line.startsWith("!")} color={line.startsWith("!") ? "yellow" : undefined}>
              {line}
            </Text>
          </Box>
        );
      })}
      <QuitHint />
    </Box>
  );
}

function GateView({
  claims,
  review,
  items,
  index,
  selection,
  warnings,
  runDir,
}: {
  claims: Claims;
  review: Review;
  items: GateItem[];
  index: number;
  selection: number;
  warnings: string[];
  runDir: string;
}) {
  const item = items[index];
  const counts = verdictCounts(claims, review);
  const refuted = review.verdicts.filter((v) => v.verdict === "refuted");
  if (!item) return null;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header
          right={`gate · ${index + 1} of ${items.length} · ${item.kind === "judgment" ? "your call" : "finding"}`}
        />
      </Box>

      {/* The state of the review, on every screen. It used to be shown once,
          on the first item, and then vanish exactly when it mattered. */}
      <Box marginBottom={1}>
        <Text dimColor>{statusLine(counts)}</Text>
      </Box>

      {warnings.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {warnings.slice(0, 3).map((w, i) => (
            <Text key={i} color="yellow">
              ! {w}
            </Text>
          ))}
          {warnings.length > 3 && (
            <Text color="yellow">! … and {warnings.length - 3} more</Text>
          )}
        </Box>
      )}

      {index === 0 && refuted.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="red">refuted by the reviewer ({refuted.length}) — these go to the rebuttal:</Text>
          {refuted.map((v) => {
            if (v.verdict !== "refuted") return null;
            const text = claims.verifiable.find((c) => c.id === v.id)?.text ?? "";
            return (
              <Text key={v.id} dimColor>
                {"  "}
                {v.id}  {text}
              </Text>
            );
          })}
        </Box>
      )}

      <Box marginBottom={item.detail.length ? 1 : 0}>
        <Text>{item.title}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {item.detail.map((d, i) => (
          <Text key={i} dimColor>
            {"  "}
            {d}
          </Text>
        ))}
      </Box>

      <Box flexDirection="column">
        {item.options.map((option, i) => (
          <Box key={i}>
            <Text color={i === selection ? "cyan" : undefined}>{i === selection ? "❯ " : "  "}</Text>
            <Text color={i === selection ? "cyan" : undefined} bold={i === selection}>
              {option}
            </Text>
          </Box>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ choose · Enter confirm
          {item.kind === "judgment" ? " · l leave open" : ""}
          {" · d draft · v verdicts"}
          {item.evidence ? " · e evidence" : ""}
        </Text>
      </Box>
      <Box>
        <Text dimColor>artifacts in {runDir}</Text>
      </Box>
    </Box>
  );
}

/* ------------------------------------------------------------------ */

/** Human words for a finished call, in place of `draft/plan`. */
function callLine(info: {
  kind: "draft" | "review" | "rebut";
  step: string;
  retry: boolean;
  ms: number;
  usage: { cost: number };
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
  return `${what}${info.retry ? " (retry)" : ""} — ${(info.ms / 1000).toFixed(1)}s, $${info.usage.cost.toFixed(6)}`;
}

function App({ repo }: { repo: string }) {
  const { exit } = useApp();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [hasCriteria, setHasCriteria] = useState(false);
  const [phase, setPhase] = useState<Phase>("start");
  const [mode, setMode] = useState<Mode>("plan");
  const [task, setTask] = useState("");
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

  const addLog = (line: string) => setLog((l) => [...l, line]);

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

  /* A same-family pair is a warning, unless this repo says the result is
     evidence — then it is a stop, before any money is spent. */
  function beginRun() {
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
    setPhase("running");
  }

  /* Run the head of the pipeline once the user commits a task. */
  useEffect(() => {
    if (phase !== "running" || !cfg || head) return;
    let cancelled = false;
    void (async () => {
      try {
        const criteria = await readCriteria(repo);
        // Answer mode has no repository and needs no criteria; only a plan run
        // is missing something when the file is absent.
        if (!criteria.found && mode === "plan") {
          addLog("! .adv/criteria.md missing — using a fallback");
        }
        setHasCriteria(criteria.found);
        const decisions = await readDecisions(repo);
        const reporting: Reporting = {
          onCall: (info) => addLog(callLine(info)),
          onNote: (text) => addLog(text),
        };
        const result = await runHead(
          repo,
          task,
          criteria.text,
          decisions,
          cfg.models,
          mode,
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
  }, [phase, head, repo, task, cfg, mode]);

  async function finishGate(all: GateAnswer[]) {
    if (!head || !cfg) return;
    setPhase("working");
    const built = answersToGate(all);
    try {
      await saveGate(head.paths, built);
      await appendDecisions(
        repo,
        built.decisions
          .filter((d) => d.choice !== "open")
          .map((d) => ({
            id: d.id,
            text: head.claims.judgment.find((j) => j.id === d.id)?.text ?? "",
            choice: d.choice,
          })),
      );
      setGate(built);
      const reporting: Reporting = {
        onCall: (info) => addLog(callLine(info)),
        onNote: (text) => addLog(text),
      };
      const result = await runTail(
        repo,
        head.paths,
        { task },
        head.claims,
        head.review,
        built,
        cfg.models,
        mode,
        reporting,
      );
      setTail(result);
      setPhase("result");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  /* Panels: the draft the calls are about, every verdict, the cited file. */
  async function openPanel(kind: "draft" | "verdicts" | "evidence") {
    if (!head) return;
    const item = items[index];

    if (kind === "draft") {
      setPanel({
        title: "plan.v1 — the draft these calls are about",
        lines: head.plan.split("\n"),
      });
      return;
    }

    if (kind === "verdicts") {
      const counts = verdictCounts(head.claims, head.review);
      const lines: string[] = [statusLine(counts), ""];
      const order = ["refuted", "unverifiable", "confirmed"] as const;
      for (const verdict of order) {
        const rows = head.review.verdicts.filter((v) => v.verdict === verdict);
        if (rows.length === 0) continue;
        lines.push(verdict.toUpperCase());
        for (const v of rows) {
          const text = head.claims.verifiable.find((c) => c.id === v.id)?.text ?? "";
          lines.push(`  ${v.id}  ${text}`);
          if (v.verdict === "unverifiable") lines.push(`      ${v.note}`);
          else lines.push(`      [${v.evidence}]${v.note ? ` — ${v.note}` : ""}`);
        }
        lines.push("");
      }
      for (const claim of head.claims.verifiable) {
        if (!head.review.verdicts.some((v) => v.id === claim.id)) {
          lines.push(`NO VERDICT  ${claim.id}  ${claim.text}`);
        }
      }
      if (head.review.extra_findings.length) {
        lines.push("", "FINDINGS");
        for (const f of head.review.extra_findings) {
          lines.push(`  ${f.id}  ${f.text}`);
          if (f.evidence) lines.push(`      [${f.evidence}]`);
          else if (f.note) lines.push(`      ${f.note}`);
        }
      }
      setPanel({ title: "review — every verdict", lines });
      return;
    }

    if (!item?.evidence) return;
    const context = await readEvidenceContext(repo, item.evidence);
    setPanel({
      title: `${item.id} — ${item.evidence}`,
      lines: context
        ? [`${context.file}${context.line ? `:${context.line}` : ""}`, "", ...context.lines]
        : [
            item.evidence,
            "",
            "not a readable file in this repository — the reviewer's citation cannot be shown here.",
            "A citation that does not resolve is itself worth questioning at this gate.",
          ],
    });
  }

  /* Gate input. Nothing here is decided by a model. */
  useInput(
    (input, key) => {
      const item = items[index];
      if (!item) return;

      const commit = (value: string) => {
        const next = [...answers, { id: item.id, kind: item.kind, value }];
        setAnswers(next);
        setSelection(0);
        if (index + 1 < items.length) setIndex(index + 1);
        else void finishGate(next);
      };

      if (key.upArrow) {
        setSelection((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setSelection((s) => Math.min(item.options.length - 1, s + 1));
        return;
      }
      if (input === "d") {
        void openPanel("draft");
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
      if (input === "l" && item.kind === "judgment") {
        commit("open");
        return;
      }
      if (key.return) commit(item.values[selection] ?? item.values[0]!);
    },
    { isActive: phase === "gate" && panel === null },
  );

  /* Nothing to ask: go straight through. */
  useEffect(() => {
    if (phase === "gate" && head && items.length === 0 && answers.length === 0) {
      void finishGate([]);
    }
  }, [phase, head, items.length, answers.length]);

  if (phase === "setup") {
    return <Setup repo={repo} selection={setupSelection} />;
  }

  if (phase === "settings" && cfg) {
    return <Settings cfg={cfg} mode={mode} selection={settingsSel} saved={saved} />;
  }

  if (phase === "pick") {
    return <Pick role={pickRole} models={allModels} filter={filter} index={pickIndex} />;
  }

  if (phase === "start") {
    return (
      <Start
        repo={repo}
        cfg={cfg}
        mode={mode}
        task={task}
        setTask={setTask}
        onRun={beginRun}
        onToggleMode={() => setMode((m) => (m === "plan" ? "answer" : "plan"))}
        onSettings={() => void openSettings()}
      />
    );
  }

  if (phase === "running") return <Busy label="working" log={log} />;
  if (phase === "working") return <Busy label="applying your decisions" log={log} />;

  if (phase === "gate" && head) {
    if (panel) {
      return (
        <Scroller
          title={panel.title}
          lines={panel.lines}
          footer={`gate ${index + 1} of ${items.length} · Esc back to the question`}
          onClose={() => setPanel(null)}
        />
      );
    }
    const warnings = gateWarnings({
      missing: head.missing,
      evidenceIssues: head.evidenceIssues,
      urlRepairs: head.urlRepairs,
      // A general question has no repository to take criteria from.
      hasCriteria: mode === "answer" ? true : hasCriteria,
    });
    return (
      <GateView
        claims={head.claims}
        review={head.review}
        items={items}
        index={index}
        selection={selection}
        warnings={warnings}
        runDir={runDir}
      />
    );
  }

  if (phase === "result" && tail && head) {
    const text = renderResult({
      plan: tail.plan,
      changelog: tail.changelog,
      patch: tail.patch,
      assessment: tail.assessment,
      gate: gate ?? { decisions: [], findings: [] },
      claims: head.claims,
      review: head.review,
    });
    return (
      <Scroller
        title="done"
        lines={text.split("\n")}
        footer={`artifacts in ${runDir} · q to quit`}
        onClose={() => exit()}
      />
    );
  }

  if (phase === "error") {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="red" bold>
            error
          </Text>
        </Box>
        <Text>{error}</Text>
        <Box marginTop={1}>
          <QuitHint />
          <Text dimColor>Ctrl+C to quit</Text>
        </Box>
      </Box>
    );
  }

  return null;
}

export async function startTui(opts: { repo: string }): Promise<void> {
  const app = render(<App repo={opts.repo} />);
  await app.waitUntilExit();
}
