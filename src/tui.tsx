import { Box, Text, render, useApp, useInput } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import { loadConfig, saveConfig } from "./config.ts";
import type { Config } from "./config.ts";
import type { Claims, Gate, Review } from "./contracts.ts";
import { hasAdvDir, initRepo } from "./init.ts";
import { familyOf, listModels, sameFamily } from "./models.ts";
import { appendDecisions, displayPath, readCriteria, readDecisions } from "./orchestrator.ts";
import { runHead, runTail, saveGate, type Head, type Tail } from "./pipeline.ts";
import { renderResult } from "./render.ts";
import type { Mode } from "./runner.ts";

type Phase = "setup" | "start" | "settings" | "pick" | "running" | "gate" | "working" | "result" | "error";

interface GateItem {
  id: string;
  kind: "judgment" | "finding";
  title: string;
  detail: string[];
  options: string[];
  values: string[];
}

function buildItems(claims: Claims, review: Review): GateItem[] {
  const items: GateItem[] = [];
  for (const j of claims.judgment) {
    const tradeoffs = review.tradeoffs.find((t) => t.id === j.id);
    items.push({
      id: j.id,
      kind: "judgment",
      title: j.text,
      detail: j.options.map((option) => {
        const against = tradeoffs?.per_option.find((p) => p.option === option)?.against ?? [];
        return `${option}${against.length ? `  — ${against.join("; ")}` : ""}`;
      }),
      options: [...j.options, "leave it open"],
      values: [...j.options, "open"],
    });
  }
  for (const f of review.extra_findings) {
    items.push({
      id: f.id,
      kind: "finding",
      title: f.text,
      detail: f.evidence ? [`[${f.evidence}]`] : f.note ? [f.note] : [],
      options: ["accept", "dismiss"],
      values: ["accepted", "dismissed"],
    });
  }
  return items;
}

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

/* ------------------------------------------------------------------ */

function Setup({
  repo,
  selection,
  onChoose,
}: {
  repo: string;
  selection: number;
  onChoose: (action: "init" | "skip") => void;
}) {
  const options = [
    { label: "Initialise .adv/ here", hint: "creates criteria, decisions, config and the agents" },
    {
      label: "Continue without it",
      hint: "no criteria — the reviewer may invent them (repo runs still get the agents)",
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
        .adv/ holds your criteria, settled decisions and model choice. Without it, a run
        still works but the reviewer has no criteria to check trade-offs against.
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
        <Text dimColor>
          You can choose models on the next screen with Ctrl+P.
        </Text>
      </Box>
      <Box>
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
      <Box marginBottom={1}>
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
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        {task ? (
          <Text>{task}</Text>
        ) : (
          <Text dimColor>{mode === "answer" ? "Type your question, then press Enter…" : "Describe the task, then press Enter…"}</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Enter run · Tab mode · Ctrl+P settings · Ctrl+C quit
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          models, criteria and decisions live in {repo}/.adv/
        </Text>
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
  const warn = sameFamily(cfg.models.drafter.ref, cfg.models.reviewer.ref);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right="settings" />
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
      {warn && (
        <Box marginTop={1}>
          <Text color="yellow">
            ! both look like the same family ({familyOf(cfg.models.drafter.ref)}) — the review will
            add less
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
  const shown = models
    .filter((m) => m.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 500);
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

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header right={label} />
      </Box>
      {log.length === 0 && <Text dimColor>{spinner} starting…</Text>}
      {log.map((line, i) => (
        <Box key={i}>
          <Text color="yellow">{i === log.length - 1 ? `${spinner} ` : "  "}</Text>
          <Text>{line}</Text>
        </Box>
      ))}
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
}: {
  claims: Claims;
  review: Review;
  items: GateItem[];
  index: number;
  selection: number;
  warnings: string[];
}) {
  const item = items[index];
  const refuted = review.verdicts.filter((v) => v.verdict === "refuted");
  if (!item) return null;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Header
          right={`gate · ${index + 1} of ${items.length} · ${item.kind === "judgment" ? "your call" : "finding"}`}
        />
      </Box>

      {index === 0 && warnings.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {warnings.map((w, i) => (
            <Text key={i} color="yellow">
              ! {w}
            </Text>
          ))}
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
          ↑↓ choose · Enter to confirm
          {item.kind === "judgment" ? " · l to leave it open" : ""}
        </Text>
      </Box>
    </Box>
  );
}

function Result({ text, runDir }: { text: string; runDir: string }) {
  const { exit } = useApp();
  const lines = useMemo(() => text.split("\n"), [text]);
  const height = Math.max(6, (process.stdout.rows ?? 24) - 6);
  const maxOffset = Math.max(0, lines.length - height);
  const [offset, setOffset] = useState(0);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) exit();
    if (key.downArrow || input === "j") setOffset((o) => Math.min(maxOffset, o + 1));
    if (key.upArrow || input === "k") setOffset((o) => Math.max(0, o - 1));
    if (key.pageDown || input === " ") setOffset((o) => Math.min(maxOffset, o + height));
    if (key.pageUp) setOffset((o) => Math.max(0, o - height));
    if (input === "g") setOffset(0);
    if (input === "G") setOffset(maxOffset);
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Header right="done" />
      </Box>
      <Box flexDirection="column">
        {lines.slice(offset, offset + height).map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {offset + 1}–{Math.min(lines.length, offset + height)} of {lines.length} · ↑↓ scroll · q quit
        </Text>
      </Box>
      <Box>
        <Text dimColor>artifacts in {runDir}</Text>
      </Box>
    </Box>
  );
}

/* ------------------------------------------------------------------ */

function App({ repo }: { repo: string }) {
  const { exit } = useApp();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [hasAdv, setHasAdv] = useState<boolean | null>(null);
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
  const [answers, setAnswers] = useState<{ id: string; value: string; kind: GateItem["kind"] }[]>([]);
  const [settingsSel, setSettingsSel] = useState(0);
  const [allModels, setAllModels] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [pickIndex, setPickIndex] = useState(0);
  const [pickRole, setPickRole] = useState<"drafter" | "reviewer">("drafter");
  const [saved, setSaved] = useState<string | null>(null);

  const addLog = (line: string) => setLog((l) => [...l, line]);

  useEffect(() => {
    void (async () => {
      try {
        const present = await hasAdvDir(repo);
        const config = await loadConfig(repo);
        setCfg(config);
        setMode(config.mode);
        setHasAdv(present);
        // First run in a repo with no .adv/: ask, rather than silently using defaults.
        setPhase(present ? "start" : "setup");
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
        setHasAdv(true);
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

  /* Run the head of the pipeline once the user commits a task. */
  useEffect(() => {
    if (phase !== "running" || !cfg || head) return;
    let cancelled = false;
    void (async () => {
      try {
        const criteria = await readCriteria(repo);
        if (!criteria.found) addLog("warning: .adv/criteria.md missing — using a fallback");
        const decisions = await readDecisions(repo);
        const result = await runHead(
          repo,
          task,
          criteria.text,
          decisions,
          cfg.models,
          mode,
          (info) => {
            addLog(
              `${info.kind}/${info.step}${info.retry ? " (retry)" : ""}  ${(info.ms / 1000).toFixed(1)}s  $${info.usage.cost.toFixed(6)}`,
            );
          },
        );
        if (cancelled) return;
        addLog(
          `drafted ${result.claims.verifiable.length} verifiable, ${result.claims.judgment.length} judgment`,
        );
        addLog(
          `reviewed ${result.review.verdicts.length} verdicts, ${result.review.extra_findings.length} findings`,
        );
        setHead(result);
        setPhase("gate");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, head, repo, task, cfg, mode]);

  async function finishGate(all: { id: string; value: string; kind: GateItem["kind"] }[]) {
    if (!head || !cfg) return;
    setPhase("working");
    const built: Gate = {
      decisions: all
        .filter((a) => a.kind === "judgment")
        .map((a) => ({ id: a.id, choice: a.value })),
      findings: all
        .filter((a) => a.kind === "finding")
        .map((a) => ({
          id: a.id,
          disposition: a.value === "accepted" ? ("accepted" as const) : ("dismissed" as const),
        })),
    };
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
      const result = await runTail(
        repo,
        head.paths,
        { task },
        head.claims,
        head.review,
        built,
        cfg.models,
        mode,
        (info) =>
          addLog(`rebut/${info.step}  ${(info.ms / 1000).toFixed(1)}s  $${info.usage.cost.toFixed(6)}`),
      );
      setTail(result);
      setPhase("result");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  /* Gate input. Nothing here is decided by a model. */
  useInput(
    (input, key) => {
      const item = items[index];
      if (!item) return;

      const commit = (value: string) => {
        const next = [...answers, { id: item.id, value, kind: item.kind }];
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
      if (input === "l" && item.kind === "judgment") {
        commit("open");
        return;
      }
      if (key.return) commit(item.values[selection] ?? item.values[0]!);
    },
    { isActive: phase === "gate" },
  );

  /* Nothing to ask: go straight through. */
  useEffect(() => {
    if (phase === "gate" && head && items.length === 0 && answers.length === 0) {
      void finishGate([]);
    }
  }, [phase, head, items.length, answers.length]);

  const runDir = head ? displayPath(head.paths.dir) : ".adv/runs";

  if (phase === "setup") {
    return <Setup repo={repo} selection={setupSelection} onChoose={(a) => void chooseSetup(a)} />;
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
        onRun={() => setPhase("running")}
        onToggleMode={() => setMode((m) => (m === "plan" ? "answer" : "plan"))}
        onSettings={() => void openSettings()}
      />
    );
  }

  if (phase === "running") return <Busy label="working" log={log} />;
  if (phase === "working") return <Busy label="applying your decisions" log={log} />;

  if (phase === "gate" && head) {
    const warnings = [
      ...head.missing.map((id) => `no verdict returned for ${id}`),
      ...head.evidenceIssues.map((i) => `${i.id} cites a file that does not exist: ${i.evidence}`),
      ...(hasAdv ? [] : ["no .adv/ — criteria are a fallback"]),
    ];
    return (
      <GateView
        claims={head.claims}
        review={head.review}
        items={items}
        index={index}
        selection={selection}
        warnings={warnings}
      />
    );
  }

  if (phase === "result" && tail && head) {
    return (
      <Result
        runDir={runDir}
        text={renderResult({
          plan: tail.plan,
          changelog: tail.changelog,
          patch: tail.patch,
          assessment: tail.assessment,
          gate: gate ?? { decisions: [], findings: [] },
          claims: head.claims,
          review: head.review,
        })}
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
