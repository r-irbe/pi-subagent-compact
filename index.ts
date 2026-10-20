/**
 * pi-subagent-compact: a pi extension that takes over compaction summaries.
 *
 * Registers a session_before_compact handler. When active (mode "subagent"
 * or "deterministic") it summarizes the messages being discarded with either:
 *   - "subagent": a one-shot LLM call (with optional deterministicFallback)
 *   - "deterministic": a zero-token, prefix-cache-stable structured digest
 * and returns the summary in a checkpoint format you control. When anything
 * fails and deterministicFallback is disabled, it returns undefined so any
 * other compaction handler keeps authority.
 *
 * Includes middle-out truncation (preserving both head context and tail
 * compiler/test errors) and structured metadata extraction (filesTouched,
 * toolCounts, commandsRun, blockers) across Pi, Antigravity, and OpenCode
 * message shapes.
 *
 * ASCII-only invariant.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULT_HEADER = "## Continuation Summary";
const DEFAULT_HEADER_NOTE = "This checkpoint was created during context compaction.";
const DEFAULT_PROMPT_PATH = join(HERE, "prompt.default.md");

/** Expand "${VAR}" occurrences from the environment; unknown vars -> "". */
export function expandEnv(value) {
    return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) =>
        process.env[name] ?? "",
    );
}

/** Expand "${VAR}" occurrences deeply through objects and arrays. */
export function expandDeep(value) {
    if (typeof value === "string") return expandEnv(value);
    if (Array.isArray(value)) return value.map(expandDeep);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandDeep(v)]));
    }
    return value;
}

/** Load config.json; unknown modes fall back to daemon (register nothing). */
export function loadConfig(configPath) {
    const defaults = {
        mode: "daemon",
        model: null,
        systemPromptPath: null,
        checkpointHeader: DEFAULT_HEADER,
        headerNote: DEFAULT_HEADER_NOTE,
        maxSummaryTokens: 8192,
        maxDigestChars: 120000,
        perMessageClipChars: 4000,
        notifyOnFallback: true,
        deterministicFallback: false,
        detailsMarker: "subagentCompact",
    };
    let raw = {};
    try {
        raw = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
        return { ...defaults, _loaded: false };
    }
    const cfg = { ...defaults, ...expandDeep(raw), _loaded: true };
    // Legacy alias from the remnic-private prototype.
    if (!raw.mode && raw.compactionSummarizer) cfg.mode = raw.compactionSummarizer;
    if (cfg.mode !== "subagent" && cfg.mode !== "deterministic") cfg.mode = "daemon";
    return cfg;
}

function loadSystemPrompt(cfg) {
    const path = cfg.systemPromptPath
        ? resolve(HERE, cfg.systemPromptPath)
        : DEFAULT_PROMPT_PATH;
    try {
        const text = readFileSync(path, "utf-8");
        if (/[\u0080-\uFFFF]/.test(text)) {
            throw new Error(`system prompt ${path} must be ASCII only`);
        }
        return text;
    } catch (err) {
        throw new Error(`pi-subagent-compact: cannot read system prompt: ${err.message}`);
    }
}

/**
 * Middle-out truncation: preserves the first 60% (head) and last 40% (tail)
 * of a long message or tool output so trailing compiler errors, stack traces,
 * and exit codes are retained alongside the opening context.
 */
export function clipMiddleOut(text, maxChars) {
    if (!maxChars || maxChars <= 0 || text.length <= maxChars) return text;
    const headLen = Math.max(1, Math.floor(maxChars * 0.6));
    const tailLen = Math.max(0, maxChars - headLen);
    if (tailLen === 0) return `${text.slice(0, headLen)}\n[...truncated]`;
    return `${text.slice(0, headLen)}\n[...truncated]\n${text.slice(text.length - tailLen)}`;
}

function parseToolArgs(part) {
    if (!part || typeof part !== "object") return {};
    const fnObj = part.function && typeof part.function === "object" ? part.function : null;
    const raw = part.arguments ?? part.args ?? part.input ?? (fnObj ? fnObj.arguments : undefined);
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") return parsed;
        } catch {
            return {};
        }
        return {};
    }
    if (raw && typeof raw === "object") return raw;
    return {};
}

function getToolName(part) {
    if (!part || typeof part !== "object") return "unknown";
    const fnObj = part.function && typeof part.function === "object" ? part.function : null;
    return String(part.name || part.tool || (fnObj && fnObj.name) || "unknown");
}

function collectMessageToolParts(msg) {
    if (!msg || typeof msg !== "object") return [];
    const parts = [];
    if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
            if (part && typeof part === "object" && (part.type === "toolCall" || part.type === "tool_use" || part.type === "tool")) {
                parts.push(part);
            }
        }
    }
    if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
            if (tc && typeof tc === "object") parts.push(tc);
        }
    }
    if (msg.tool_call && typeof msg.tool_call === "object") {
        parts.push(msg.tool_call);
    }
    return parts;
}

function formatToolPart(part) {
    const name = getToolName(part);
    const args = parseToolArgs(part);
    if (args && typeof args === "object") {
        const target = args.path || args.TargetFile || args.AbsolutePath || args.filePath || args.file_path || args.DirectoryPath;
        const cmd = args.command || args.CommandLine || args.cmd;
        if (typeof target === "string" && target) {
            return `[tool: ${name} path=${target}]`;
        }
        if (typeof cmd === "string" && cmd) {
            const shortCmd = cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
            return `[tool: ${name} cmd="${shortCmd}"]`;
        }
    }
    return `[tool: ${name}]`;
}

function messageText(message) {
    if (!message || typeof message !== "object") return "";
    const segments = [];
    const content = message.content;
    if (typeof content === "string") {
        if (content) segments.push(content);
    } else if (Array.isArray(content)) {
        for (const part of content) {
            if (typeof part === "string") {
                if (part) segments.push(part);
            } else if (part && typeof part.text === "string") {
                if (part.text) segments.push(part.text);
            } else if (part && (part.type === "toolCall" || part.type === "tool_use" || part.type === "tool")) {
                segments.push(formatToolPart(part));
            } else if (part && part.type) {
                segments.push(`[${part.type}]`);
            }
        }
    } else if (typeof message.text === "string" && message.text) {
        segments.push(message.text);
    }
    if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
            if (tc && typeof tc === "object") segments.push(formatToolPart(tc));
        }
    }
    if (message.tool_call && typeof message.tool_call === "object") {
        segments.push(formatToolPart(message.tool_call));
    }
    return segments.filter(Boolean).join("\n");
}

/**
 * Extract deterministic structured metadata across Pi, Antigravity, and OpenCode
 * message arrays: touched files, tool call histogram, recent commands, and blockers.
 */
export function extractStructuredMetadata(messages) {
    const filesSet = new Set();
    const toolCounts = {};
    const rawCommands = [];
    const blockersSet = new Set();
    const pathRe = /(?:^|[\s"'`(])((?:\/[A-Za-z0-9._-]+){2,}|(?:src|test|packages|lib|docs|ggml|examples)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)/g;
    const errRe = /(?:^|\n)\s*((?:Error|SyntaxError|TypeError|AssertionError|FAIL|fatal):[^\n]{1,160}|\u2716[^\n]{1,160})/g;

    for (const msg of messages || []) {
        if (!msg || typeof msg !== "object") continue;
        const toolParts = collectMessageToolParts(msg);
        for (const part of toolParts) {
            const name = getToolName(part);
            toolCounts[name] = (toolCounts[name] || 0) + 1;
            const args = parseToolArgs(part);
            if (args && typeof args === "object") {
                for (const k of ["path", "TargetFile", "AbsolutePath", "filePath", "file_path", "DirectoryPath", "SearchPath"]) {
                    if (typeof args[k] === "string" && args[k].trim()) filesSet.add(args[k].trim());
                }
                const cmd = args.command || args.CommandLine || args.cmd;
                if (typeof cmd === "string" && cmd.trim()) {
                    rawCommands.push(cmd.trim().slice(0, 120));
                }
            }
        }
        const txt = messageText(msg);
        if (txt) {
            let m;
            while ((m = pathRe.exec(txt)) !== null) {
                filesSet.add(m[1]);
            }
            while ((m = errRe.exec(txt)) !== null) {
                const clean = m[1].replace(/[^\x20-\x7E]/g, "").trim();
                if (clean) blockersSet.add(clean);
            }
        }
    }

    const collapsedCommands = [];
    for (const cmd of rawCommands) {
        const prev = collapsedCommands[collapsedCommands.length - 1];
        if (prev && prev.cmd === cmd) {
            prev.count += 1;
        } else {
            collapsedCommands.push({ cmd, count: 1 });
        }
    }
    const commandsRun = collapsedCommands
        .map((entry) => (entry.count > 1 ? `${entry.cmd} (x${entry.count})` : entry.cmd))
        .slice(-15);

    return {
        filesTouched: [...filesSet].sort().slice(0, 40),
        toolCounts,
        commandsRun,
        blockers: [...blockersSet].slice(0, 15),
    };
}

/** Flatten the messages to summarize into a bounded plain-text digest. */
export function buildTranscriptDigest(messages, maxChars, perMessageClipChars) {
    const parts = [];
    let total = 0;
    for (const message of messages) {
        const role = (message && message.role) || "unknown";
        const text = messageText(message).trim();
        if (!text) continue;
        const clip = perMessageClipChars > 0 ? perMessageClipChars : text.length;
        const clipped = clipMiddleOut(text, clip);
        const block = `### ${role}\n${clipped}`;
        if (maxChars > 0 && total + block.length > maxChars) {
            parts.push("[digest truncated: older messages omitted]");
            break;
        }
        parts.push(block);
        total += block.length;
    }
    return parts.join("\n\n");
}

/** Assemble the user prompt: previous summary + structured metadata + the digest. */
export function buildCheckpointPrompt(previousSummary, digest, metadata = null) {
    const lines = [
        "Produce the continuation checkpoint now.",
        "",
        "## Previous Summary",
        previousSummary && previousSummary.trim() ? previousSummary : "none",
    ];
    if (metadata && typeof metadata === "object") {
        lines.push("", "## Structured Activity Index");
        if (Array.isArray(metadata.filesTouched) && metadata.filesTouched.length > 0) {
            lines.push(`- Files Touched: ${metadata.filesTouched.join(", ")}`);
        }
        if (metadata.toolCounts && Object.keys(metadata.toolCounts).length > 0) {
            const tools = Object.entries(metadata.toolCounts)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => `${k}(${v})`)
                .join(", ");
            lines.push(`- Tool Calls: ${tools}`);
        }
        if (Array.isArray(metadata.commandsRun) && metadata.commandsRun.length > 0) {
            lines.push(`- Recent Commands: ${metadata.commandsRun.slice(-5).join(" ; ")}`);
        }
        if (Array.isArray(metadata.blockers) && metadata.blockers.length > 0) {
            lines.push(`- Detected Errors/Blockers: ${metadata.blockers.join(" | ")}`);
        }
    }
    lines.push(
        "",
        "## Transcript digest (to summarize into 'Conversation Excerpt')",
        digest,
    );
    return lines.join("\n");
}

/**
 * Build a zero-token, deterministic, prefix-cache-stable continuation checkpoint
 * when running in "deterministic" mode or when the LLM summarizer falls back.
 */
export function buildDeterministicCheckpoint(previousSummary, messages, cfg = {}) {
    const meta = extractStructuredMetadata(messages || []);
    const digest = buildTranscriptDigest(
        (messages || []).slice(-12),
        Math.min(cfg.maxDigestChars || 24000, 24000),
        Math.min(cfg.perMessageClipChars || 1200, 1200),
    );
    const sections = [];
    if (previousSummary && previousSummary.trim()) {
        sections.push("### Prior Checkpoint\n" + previousSummary.trim());
    }
    const indexLines = ["### Structured Activity Index"];
    indexLines.push(`- Files Touched (${meta.filesTouched.length}): ${meta.filesTouched.length ? meta.filesTouched.join(", ") : "none"}`);
    const tools = Object.entries(meta.toolCounts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}:${v}`)
        .join(", ");
    indexLines.push(`- Tool Calls: ${tools || "none"}`);
    if (meta.commandsRun.length > 0) {
        indexLines.push(`- Recent Commands: ${meta.commandsRun.slice(-5).join(" ; ")}`);
    }
    if (meta.blockers.length > 0) {
        indexLines.push(`- Active Blockers/Errors: ${meta.blockers.join(" | ")}`);
    }
    sections.push(indexLines.join("\n"));
    if (digest) {
        sections.push("### Recent Conversation Excerpt\n" + digest);
    }
    return withCheckpointHeader(sections.join("\n\n"), {
        checkpointHeader: cfg.checkpointHeader ?? DEFAULT_HEADER,
        headerNote: cfg.headerNote ?? DEFAULT_HEADER_NOTE,
    });
}

/** Wrap (or not) the raw summary in the configured checkpoint header. */
export function withCheckpointHeader(text, cfg) {
    const body = text.trim();
    if (!cfg.checkpointHeader) return body;
    if (body.includes(cfg.checkpointHeader)) return body;
    const note = cfg.headerNote ? `\n\n${cfg.headerNote}` : "";
    return `${cfg.checkpointHeader}${note}\n\n${body}`;
}

/** Resolve the completion function: bare specifier first, then a global install. */
async function loadCompleteSimple() {
    const candidates = ["@mariozechner/pi-ai"];
    if (process.env.PI_AI_MODULE_PATH) candidates.unshift(process.env.PI_AI_MODULE_PATH);
    let lastErr;
    for (const spec of candidates) {
        try {
            const mod = await import(spec);
            if (typeof mod.completeSimple === "function") return mod.completeSimple;
        } catch (err) {
            lastErr = err;
        }
    }
    throw new Error(`cannot resolve @mariozechner/pi-ai: ${lastErr?.message || "not found"}`);
}

async function summarizeWithModel(model, systemPrompt, userPrompt, signal, maxTokens, apiKey) {
    const completeSimple = await loadCompleteSimple();
    const response = await completeSimple(
        model,
        {
            systemPrompt,
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: userPrompt }],
                    timestamp: Date.now(),
                },
            ],
        },
        { maxTokens, signal, apiKey },
    );
    if (response && response.stopReason === "error") {
        throw new Error(response.errorMessage || "summarizer returned error");
    }
    const content = (response && response.content) || [];
    const text = content
        .map((part) => (part && typeof part.text === "string" ? part.text : ""))
        .join("");
    return text;
}

/** Build a model object from a config block (for a dedicated summarizer model). */
export function modelFromConfig(block) {
    if (!block || typeof block !== "object") return null;
    const model = {
        provider: String(block.provider || "custom"),
        id: String(block.id || ""),
        api: String(block.api || "openai-completions"),
        name: String(block.name || block.id || "configured summarizer"),
        baseUrl: block.baseUrl ? String(block.baseUrl) : undefined,
        contextWindow: Number(block.contextWindow) || 131072,
        maxTokens: Number(block.maxTokens) || 32768,
        reasoning: Boolean(block.reasoning),
        input: Array.isArray(block.input) ? block.input : ["text"],
        compat: block.compat && typeof block.compat === "object" ? block.compat : { maxTokensField: "max_tokens" },
        cost: block.cost && typeof block.cost === "object"
            ? block.cost
            : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    if (!model.id) return null;
    if (block.apiKey) model.apiKey = expandEnv(String(block.apiKey));
    return model;
}

export default function createSubagentCompactExtension(pi) {
    const configPath = process.env.PI_SUBAGENT_COMPACT_CONFIG
        ? resolve(process.env.PI_SUBAGENT_COMPACT_CONFIG)
        : join(HERE, "config.json");
    const cfg = loadConfig(configPath);
    if (cfg.mode !== "subagent" && cfg.mode !== "deterministic") return;

    let systemPrompt = "";
    if (cfg.mode === "subagent") {
        try {
            systemPrompt = loadSystemPrompt(cfg);
        } catch (err) {
            try {
                console.error(String(err.message || err));
            } catch {}
            if (!cfg.deterministicFallback) return;
        }
    }

    const configuredModel = modelFromConfig(cfg.model);

    pi.on("session_before_compact", async (event, ctx) => {
        const prep = event.preparation || {};
        const messages = prep.messagesToSummarize || [];
        const meta = extractStructuredMetadata(messages);
        try {
            if (cfg.mode === "deterministic") {
                const summary = buildDeterministicCheckpoint(prep.previousSummary, messages, cfg);
                return {
                    compaction: {
                        summary,
                        firstKeptEntryId: prep.firstKeptEntryId,
                        tokensBefore: prep.tokensBefore,
                        details: cfg.detailsMarker
                            ? {
                                  [cfg.detailsMarker]: {
                                      version: 2,
                                      source: "deterministic",
                                      filesTouched: meta.filesTouched,
                                      toolCounts: meta.toolCounts,
                                      blockersCount: meta.blockers.length,
                                  },
                              }
                            : undefined,
                    },
                };
            }
            const model = configuredModel || ctx.model;
            if (!model) return undefined;
            const digest = buildTranscriptDigest(
                messages,
                cfg.maxDigestChars,
                cfg.perMessageClipChars,
            );
            const prompt = buildCheckpointPrompt(prep.previousSummary, digest, meta);
            const raw = await summarizeWithModel(
                model,
                systemPrompt,
                prompt,
                event.signal,
                cfg.maxSummaryTokens,
                configuredModel ? configuredModel.apiKey : undefined,
            );
            if (!raw.trim()) return undefined;
            const summary = withCheckpointHeader(raw, cfg);
            return {
                compaction: {
                    summary,
                    firstKeptEntryId: prep.firstKeptEntryId,
                    tokensBefore: prep.tokensBefore,
                    details: cfg.detailsMarker
                        ? {
                              [cfg.detailsMarker]: {
                                  version: 2,
                                  source: "subagent",
                                  filesTouched: meta.filesTouched,
                                  toolCounts: meta.toolCounts,
                                  blockersCount: meta.blockers.length,
                              },
                          }
                        : undefined,
                },
            };
        } catch (err) {
            if (cfg.deterministicFallback) {
                const summary = buildDeterministicCheckpoint(prep.previousSummary, messages, cfg);
                return {
                    compaction: {
                        summary,
                        firstKeptEntryId: prep.firstKeptEntryId,
                        tokensBefore: prep.tokensBefore,
                        details: cfg.detailsMarker
                            ? {
                                  [cfg.detailsMarker]: {
                                      version: 2,
                                      source: "deterministic-fallback",
                                      filesTouched: meta.filesTouched,
                                      toolCounts: meta.toolCounts,
                                      blockersCount: meta.blockers.length,
                                  },
                              }
                            : undefined,
                    },
                };
            }
            if (cfg.notifyOnFallback && ctx && typeof ctx.notify === "function") {
                try {
                    ctx.notify(`pi-subagent-compact: falling back (${err.message})`, "warning");
                } catch {}
            }
            return undefined;
        }
    });
}
