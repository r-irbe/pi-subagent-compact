/**
 * pi-subagent-compact: a pi extension that takes over compaction summaries.
 *
 * Registers a session_before_compact handler. When active (mode "subagent")
 * it summarizes the messages being discarded with a one-shot LLM call --
 * the session's own model by default, or any configured model -- and
 * returns the summary in a checkpoint format you control. When anything
 * fails it returns undefined, so any other compaction handler (for example
 * a memory daemon's) keeps authority: a true fallback, never a broken
 * compaction.
 *
 * Handler-order contract: pi's extension runner executes every handler and
 * keeps the LAST non-null result. Extensions load in alphabetical
 * directory order, so to override another extension's summary this
 * extension's directory must sort AFTER that extension's (e.g. install as
 * ~/.pi/agent/extensions/zz-subagent-compact to beat nearly everything).
 * Handlers registered before this one still run; their side effects
 * (memory-store flushes, checkpoints) are preserved.
 *
 * Configuration lives in config.json next to this file (see
 * config.json.example). Every string value of the form "${VAR}" is
 * expanded from the environment at load time, so API keys can come from
 * the environment instead of the config file.
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
    if (cfg.mode !== "subagent") cfg.mode = "daemon";
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

function messageText(message) {
    const content = message && message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === "string") return part;
                if (part && typeof part.text === "string") return part.text;
                if (part && part.type === "toolCall") return `[tool: ${part.name || "unknown"}]`;
                if (part && part.type) return `[${part.type}]`;
                return "";
            })
            .filter(Boolean)
            .join("\n");
    }
    if (message && typeof message.text === "string") return message.text;
    return "";
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
        const clipped = text.length > clip ? `${text.slice(0, clip)}\n[...truncated]` : text;
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

/** Assemble the user prompt: previous summary + the digest. */
export function buildCheckpointPrompt(previousSummary, digest) {
    return [
        "Produce the continuation checkpoint now.",
        "",
        "## Previous Summary",
        previousSummary && previousSummary.trim() ? previousSummary : "none",
        "",
        "## Transcript digest (to summarize into 'Conversation Excerpt')",
        digest,
    ].join("\n");
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
    try {
        const mod = await import("@earendil-works/pi-ai/compat");
        return mod.completeSimple;
    } catch {
        // fall through to the well-known global location
    }
    const global = join(
        process.env.HOME || "",
        ".local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js",
    );
    if (existsSync(global)) {
        const mod = await import(`file://${global}`);
        return mod.completeSimple;
    }
    throw new Error(
        "pi-subagent-compact: cannot import @earendil-works/pi-ai/compat (is pi installed?)",
    );
}

/**
 * Run the summary completion. `model` is the model object (the session's
 * own, or one built from config). Resolves to the summary text; rejects on
 * transport errors; resolves with an empty string when the model returns
 * an error result (checked via stopReason so callers can fall back).
 */
export async function summarizeWithModel(model, systemPrompt, prompt, signal, maxTokens, apiKey) {
    const completeSimple = await loadCompleteSimple();
    const result = await completeSimple(
        model,
        [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
        ],
        { signal, maxTokens, ...(apiKey ? { apiKey } : {}) },
    );
    if (result && result.stopReason === "error") {
        throw new Error(`summarizer model error: ${result.errorMessage || "unknown"}`);
    }
    const content = result && Array.isArray(result.content) ? result.content : [];
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
    if (cfg.mode !== "subagent") return;

    let systemPrompt;
    try {
        systemPrompt = loadSystemPrompt(cfg);
    } catch (err) {
        // A broken prompt must not break session startup: stay inert and
        // let other compaction handlers work.
        try {
            console.error(String(err.message || err));
        } catch {}
        return;
    }

    const configuredModel = modelFromConfig(cfg.model);

    pi.on("session_before_compact", async (event, ctx) => {
        try {
            const model = configuredModel || ctx.model;
            if (!model) return undefined;
            const prep = event.preparation || {};
            const digest = buildTranscriptDigest(
                prep.messagesToSummarize || [],
                cfg.maxDigestChars,
                cfg.perMessageClipChars,
            );
            const prompt = buildCheckpointPrompt(prep.previousSummary, digest);
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
                        ? { [cfg.detailsMarker]: { version: 1, source: "subagent" } }
                        : undefined,
                },
            };
        } catch (err) {
            if (cfg.notifyOnFallback && ctx && typeof ctx.notify === "function") {
                try {
                    ctx.notify(`pi-subagent-compact: falling back (${err.message})`, "warning");
                } catch {}
            }
            return undefined;
        }
    });
}
