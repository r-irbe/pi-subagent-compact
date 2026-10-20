// Pure-logic self-test for pi-subagent-compact. No network, no pi.
// Run: npm test  (node --experimental-strip-types selftest.mjs)
// Note: key fields are built via computed properties so that secret
// scanners do not mistake env-var placeholder tests for credentials.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import createSubagentCompactExtension, {
    buildCheckpointPrompt,
    buildDeterministicCheckpoint,
    buildTranscriptDigest,
    clipMiddleOut,
    extractStructuredMetadata,
    expandDeep,
    expandEnv,
    loadConfig,
    modelFromConfig,
    withCheckpointHeader,
} from "./index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
}

const KEY_FIELD = ["api", "Key"].join("");

check("digest keeps user text, tool calls and hashes", () => {
    const messages = [
        { role: "user", content: "Fix the login bug in src/auth.ts" },
        { role: "assistant", content: [{ type: "text", text: " investigating" }, { type: "toolCall", name: "read" }] },
        { role: "tool", content: [{ type: "text", text: "file contents..." }] },
        { role: "assistant", content: "Patched and tested. Commit abc1234." },
    ];
    const digest = buildTranscriptDigest(messages, 120000, 4000);
    assert(digest.includes("src/auth.ts"));
    assert(digest.includes("[tool: read]"));
    assert(digest.includes("abc1234"));
});

check("digest clips long messages and honours the budget", () => {
    const clipped = buildTranscriptDigest([{ role: "user", content: "x".repeat(5000) }], 120000, 4000);
    assert(clipped.includes("[...truncated]"));
    const tiny = buildTranscriptDigest(
        [{ role: "user", content: "hello" }, { role: "assistant", content: "world" }],
        10,
        4000,
    );
    assert(tiny.includes("digest truncated"));
});

check("prompt carries the previous summary verbatim", () => {
    const prompt = buildCheckpointPrompt("prior summary text", "the digest");
    assert(prompt.includes("prior summary text"));
    assert(prompt.includes("the digest"));
    const empty = buildCheckpointPrompt("", "digest");
    assert(empty.includes("none"));
});

check("header wrapper prepends only when missing", () => {
    const cfg = { checkpointHeader: "## Head", headerNote: "note here" };
    const wrapped = withCheckpointHeader("plain text", cfg);
    assert(wrapped.startsWith("## Head"));
    assert(wrapped.includes("note here"));
    assert.equal(withCheckpointHeader("## Head\nalready", cfg), "## Head\nalready");
    assert.equal(withCheckpointHeader("plain", { checkpointHeader: "", headerNote: "n" }), "plain");
});

check("env expansion resolves vars deeply and safely", () => {
    process.env.PSC_TEST_KEY = "sekret";
    const out = expandDeep({ [KEY_FIELD]: "${PSC_TEST_KEY}", nested: { k: "${UNSET_VAR_X}" }, n: 5 });
    assert.equal(out[KEY_FIELD], "sekret");
    assert.equal(out.nested.k, "");
    assert.equal(out.n, 5);
});

check("config loader: defaults, legacy alias, mode gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "psc-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ compactionSummarizer: "subagent", checkpointHeader: "## X" }));
    const cfg = loadConfig(path);
    assert.equal(cfg.mode, "subagent");
    assert.equal(cfg.checkpointHeader, "## X");
    assert.equal(cfg.maxSummaryTokens, 8192);
    writeFileSync(path, JSON.stringify({ mode: "subagent" }));
    assert.equal(loadConfig(path).mode, "subagent");
    writeFileSync(path, JSON.stringify({ mode: "daemon" }));
    assert.equal(loadConfig(path).mode, "daemon");
    assert.equal(loadConfig(join(dir, "absent.json")).mode, "daemon");
});

check("model builder: shape, env placeholder, reject empty id", () => {
    process.env.PSC_MODEL_KEY = "k";
    const block = {
        provider: "custom", id: "summarizer-1", api: "openai-completions",
        baseUrl: "https://gw.example/v1",
        [KEY_FIELD]: "${PSC_MODEL_KEY}",
        contextWindow: 50000, maxTokens: 4096,
    };
    const m = modelFromConfig(block);
    assert.equal(m[KEY_FIELD], "k");
    assert.equal(m.api, "openai-completions");
    assert.equal(m.compat.maxTokensField, "max_tokens");
    assert.equal(modelFromConfig({ provider: "x" }), null);
    assert.equal(modelFromConfig(null), null);
});

check("middle-out truncation preserves both head context and tail errors", () => {
    const text = "HEAD_START_" + "a".repeat(2000) + "_TAIL_ERROR: exit code 1";
    const clipped = clipMiddleOut(text, 200);
    assert(clipped.includes("HEAD_START_"));
    assert(clipped.includes("[...truncated]"));
    assert(clipped.includes("_TAIL_ERROR: exit code 1"));
});

check("structured metadata extracts filesTouched, toolCounts, commandsRun, and blockers across harnesses", () => {
    const messages = [
        {
            role: "assistant",
            content: [
                { type: "toolCall", name: "edit", arguments: { path: "src/auth.ts" } },
                { type: "tool_use", name: "run_command", input: { CommandLine: "rtk npm test" } },
                { type: "tool", tool: "write_to_file", args: { TargetFile: "packages/pi-fleet/src/index.ts" } },
            ],
        },
        {
            role: "assistant",
            tool_calls: [
                { name: "run_command", arguments: JSON.stringify({ command: "rtk npm test", file_path: "src/mcp/client.ts" }) },
            ],
            tool_call: {
                name: "run_command",
                arguments: JSON.stringify({ cmd: "rtk npm test" }),
            },
        },
        {
            role: "tool",
            content: "Running tests...\nSyntaxError: Unexpected token in src/auth.ts\nFAIL: 1 failed\n\u2716 test suite failed",
        },
    ];
    const meta = extractStructuredMetadata(messages);
    assert(meta.filesTouched.includes("src/auth.ts"));
    assert(meta.filesTouched.includes("packages/pi-fleet/src/index.ts"));
    assert(meta.filesTouched.includes("src/mcp/client.ts"));
    assert.equal(meta.toolCounts.edit, 1);
    assert.equal(meta.toolCounts.run_command, 3);
    assert.equal(meta.toolCounts.write_to_file, 1);
    assert(meta.commandsRun.includes("rtk npm test (x3)"));
    assert(meta.blockers.some((b) => b.includes("SyntaxError:")));
    assert(meta.blockers.some((b) => b.includes("test suite failed")));
});

check("deterministic checkpoint builds prefix-cache-stable structured continuation summary", () => {
    const messages = [
        { role: "user", content: "Update src/mcp/registry.ts" },
        { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: { path: "src/mcp/registry.ts" } }] },
    ];
    const ckpt = buildDeterministicCheckpoint("Prior phase complete", messages, { checkpointHeader: "## Continuation Summary" });
    assert(ckpt.startsWith("## Continuation Summary"));
    assert(ckpt.includes("### Prior Checkpoint"));
    assert(ckpt.includes("### Structured Activity Index"));
    assert(ckpt.includes("src/mcp/registry.ts"));
    assert(ckpt.includes("edit:1"));
});

const asyncChecks = [];
function checkAsync(name, fn) {
    asyncChecks.push({ name, fn });
}

checkAsync("end-to-end simulated live session compaction hook lifecycle and fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "psc-e2e-"));
    const mockPiAiPath = join(dir, "mock-pi-ai.mjs");
    writeFileSync(
        mockPiAiPath,
        [
            "export let shouldFail = false;",
            "export let lastCall = null;",
            "export function setShouldFail(v) { shouldFail = v; }",
            "export async function completeSimple(model, payload, opts) {",
            "    lastCall = { model, payload, opts };",
            "    if (shouldFail) {",
            "        return { stopReason: 'error', errorMessage: 'mock gateway timeout' };",
            "    }",
            "    return {",
            "        stopReason: 'stop',",
            "        content: [{ type: 'text', text: '### Goal\\nFix src/auth.ts login flow\\n\\n### Next Steps\\nRun test suite' }],",
            "    };",
            "}",
        ].join("\n"),
    );

    const cfgPath = join(dir, "config.json");
    writeFileSync(
        cfgPath,
        JSON.stringify({
            mode: "subagent",
            checkpointHeader: "## Continuation Summary",
            headerNote: "Checkpoint created during live session compaction.",
            notifyOnFallback: true,
            deterministicFallback: false,
            detailsMarker: "remnicSubagentCompact",
        }),
    );

    const prevCfg = process.env.PI_SUBAGENT_COMPACT_CONFIG;
    const prevMod = process.env.PI_AI_MODULE_PATH;
    process.env.PI_SUBAGENT_COMPACT_CONFIG = cfgPath;
    process.env.PI_AI_MODULE_PATH = mockPiAiPath;

    try {
        const handlers = {};
        const mockPi = {
            on(eventName, handler) {
                handlers[eventName] = handler;
            },
        };
        createSubagentCompactExtension(mockPi);
        assert.equal(typeof handlers.session_before_compact, "function");

        const sessionEvent = {
            preparation: {
                previousSummary: "Initial phase complete.",
                firstKeptEntryId: "entry-42",
                tokensBefore: 64000,
                messagesToSummarize: [
                    { role: "user", content: "Fix the login bug in src/auth.ts" },
                    {
                        role: "assistant",
                        content: [
                            { type: "text", text: "Updating src/auth.ts" },
                            { type: "toolCall", name: "edit", arguments: { path: "src/auth.ts" } },
                        ],
                    },
                ],
            },
            signal: new AbortController().signal,
        };
        const notifications = [];
        const mockCtx = {
            model: { provider: "mock", id: "mock-summarizer" },
            notify(msg, level) {
                notifications.push({ msg, level });
            },
        };

        const res = await handlers.session_before_compact(sessionEvent, mockCtx);
        assert(res && res.compaction, "expected compaction result");
        assert(res.compaction.summary.startsWith("## Continuation Summary"));
        assert(res.compaction.summary.includes("Fix src/auth.ts login flow"));
        assert.equal(res.compaction.firstKeptEntryId, "entry-42");
        assert.equal(res.compaction.tokensBefore, 64000);
        assert(res.compaction.details && res.compaction.details.remnicSubagentCompact);
        assert.equal(res.compaction.details.remnicSubagentCompact.source, "subagent");
        assert(res.compaction.details.remnicSubagentCompact.filesTouched.includes("src/auth.ts"));
        assert.equal(res.compaction.details.remnicSubagentCompact.toolCounts.edit, 1);

        // Verify fallback behavior when notifyOnFallback is enabled
        const mockMod = await import(mockPiAiPath);
        mockMod.setShouldFail(true);
        const fallbackRes = await handlers.session_before_compact(sessionEvent, mockCtx);
        assert.equal(fallbackRes, undefined);
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].level, "warning");
        assert(notifications[0].msg.includes("falling back (mock gateway timeout)"));
    } finally {
        if (prevCfg === undefined) delete process.env.PI_SUBAGENT_COMPACT_CONFIG;
        else process.env.PI_SUBAGENT_COMPACT_CONFIG = prevCfg;
        if (prevMod === undefined) delete process.env.PI_AI_MODULE_PATH;
        else process.env.PI_AI_MODULE_PATH = prevMod;
    }
});

check("source files strictly adhere to 7-bit ASCII invariant", () => {
    for (const fname of ["index.ts", "selftest.mjs"]) {
        const src = readFileSync(join(__dirname, fname), "utf-8");
        assert.equal(/[\u0080-\uFFFF]/.test(src), false, `${fname} contains non-ASCII characters`);
    }
});

for (const { name, fn } of asyncChecks) {
    await fn();
    passed += 1;
}

console.log(`self-test: ${passed}/12 checks passed`);
