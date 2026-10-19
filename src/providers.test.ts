import { describe, expect, test } from "bun:test";
import { allProviderBills, noteForModel, parseAuthList, providerBill, PROVIDER_NOTES } from "./providers.ts";
import { parseCatalogue } from "./catalogue.ts";

/** The real shape of `opencode auth list`, captured 18 Oct 2026. */
const AUTH_OUTPUT = `
OpenCode Go         OPENCODE_API_KEY            environment
Anthropic           ANTHROPIC_API_KEY           environment
DeepSeek            DEEPSEEK_API_KEY            environment
GitHub Copilot      OAuth                       stored
Google              GEMINI_API_KEY              environment
Groq                GROQ_API_KEY                environment
Mistral             MISTRAL_API_KEY             environment
OpenAI              OPENAI_API_KEY              environment
OpenCode Console    Default                     stored
OpenCode Console    OPENCODE_API_KEY            environment
OpenRouter          OPENROUTER_API_KEY          environment
Together AI         TOGETHER_API_KEY            environment
`;

const PROVIDERS = [
  "opencode-go", "opencode", "anthropic", "deepseek", "github-copilot", "google",
  "groq", "mistral", "openai", "openrouter", "togetherai", "bionic", "local", "lithos",
];

describe("parseAuthList", () => {
  test("OpenCode Go is the subscription and OpenCode Console is not", () => {
    const found = parseAuthList(AUTH_OUTPUT, PROVIDERS);
    expect(found.has("opencode-go")).toBe(true);
    expect(found.has("opencode")).toBe(true);
  });

  test("longest provider id wins, or the subscription is reported as the dead account", () => {
    // The failure this guards: "OpenCode Go" alphanumerically is "opencodego",
    // which also prefix-matches "opencode" — the Console account with no
    // credit. Matching the shorter id first inverts the entire answer.
    const found = parseAuthList(AUTH_OUTPUT, PROVIDERS);
    expect(found.get("opencode-go")).toBe("env");
    expect(found.get("opencode")).toBe("stored");
  });

  test("display names that are not provider ids still resolve", () => {
    const found = parseAuthList(AUTH_OUTPUT, PROVIDERS);
    expect(found.get("togetherai")).toBe("env");
    expect(found.get("github-copilot")).toBe("stored");
    expect(found.get("openrouter")).toBe("env");
  });

  test("a provider with no line is absent, which is what `✗ no key` reads", () => {
    const found = parseAuthList(AUTH_OUTPUT, PROVIDERS);
    expect(found.has("bionic")).toBe(false);
    expect(found.has("local")).toBe(false);
  });

  test("an empty or unrelated listing is empty, not an error", () => {
    expect(parseAuthList("", PROVIDERS).size).toBe(0);
    expect(parseAuthList("nothing here\n\n", PROVIDERS).size).toBe(0);
  });
});

describe("providerBill", () => {
  const catalogue = parseCatalogue(
    JSON.stringify({
      opencode: {
        models: {
          "muse-spark-1.3": { cost: { input: 1.25, output: 4.25 }, tool_call: true },
          "mimo-v2.6-flash-free": { cost: { input: 0, output: 0 }, tool_call: true },
          "beam-free": null,
        },
      },
    }),
  );

  test("counts what the catalogue knows and admits what it does not", () => {
    const bill = providerBill(
      "opencode",
      ["opencode/muse-spark-1.3", "opencode/mimo-v2.6-flash-free", "opencode/beam-free"],
      catalogue,
      "stored",
    );
    expect(bill).toMatchObject({ listed: 3, free: 1, priced: 1, unknown: 1, keyed: "stored" });
  });

  test("a provider the catalogue has never heard of is `unknown`, not free", () => {
    const bill = providerBill("lithos", ["lithos/thing"], new Map(), null);
    expect(bill).toMatchObject({ billing: "unknown", free: 0, priced: 0, keyed: null });
  });

  test("a provider whose every model is free says so", () => {
    const bill = providerBill("opencode", ["opencode/mimo-v2.6-flash-free"], catalogue, "env");
    expect(bill.billing).toBe("free only");
  });

  test("one priced model makes the whole provider metered", () => {
    const bill = providerBill("opencode", ["opencode/muse-spark-1.3", "opencode/mimo-v2.6-flash-free"], catalogue, "env");
    expect(bill.billing).toBe("metered");
  });

  test("models that cannot call tools are counted, because they cannot be a drafter", () => {
    const noTools = parseCatalogue(JSON.stringify({ x: { models: { m: { cost: null, tool_call: false } } } }));
    expect(providerBill("x", ["x/m"], noTools, "env").noTools).toBe(1);
    expect(providerBill("x", ["x/m"], new Map(), "env").noTools).toBe(0);
  });

  test("a dated account note rides along", () => {
    expect(providerBill("opencode-go", [], new Map(), "env").note).toBe(PROVIDER_NOTES["opencode-go"]);
  });
});

describe("allProviderBills", () => {
  test("groups the listing by provider, alphabetically", () => {
    const bills = allProviderBills(
      ["openrouter/z-ai/glm", "opencode-go/glm", "opencode-go/qwen", "opencode/muse"],
      new Map(),
      new Map([["opencode-go", "env" as const]]),
    );
    expect(bills.map((b) => b.provider)).toEqual(["opencode", "opencode-go", "openrouter"]);
    expect(bills.map((b) => b.listed)).toEqual([1, 2, 1]);
    expect(bills.find((b) => b.provider === "opencode-go")?.keyed).toBe("env");
    expect(bills.find((b) => b.provider === "openrouter")?.keyed).toBeNull();
  });
});

describe("noteForModel", () => {
  test("a contributor model carries the privacy note", () => {
    expect(noteForModel("opencode-go/muse-spark-1.3-contributor")).toContain("privacy");
  });

  test("a free model says free is not the same as reachable", () => {
    expect(noteForModel("opencode-go/space-bunny-free")).toContain("not mean reachable");
  });

  test("an ordinary model has no note", () => {
    expect(noteForModel("anthropic/claude-haiku-5-5")).toBeUndefined();
  });

  test("the note matches the model id, not the provider", () => {
    // A provider literally called "contributor" must not trigger it.
    expect(noteForModel("contributor/some-model")).toBeUndefined();
  });
});
