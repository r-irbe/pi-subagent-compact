# pi-subagent-compact User Guide

`pi-subagent-compact` is a `pi` coding-agent extension that intercepts `session_before_compact` and generates continuation summaries in-process using the session model (or any configured OpenAI-compatible model), with deterministic digest budgeting and passthrough fallback.

## 1. Installation & Load Order

`pi` loads extensions in alphabetical order and uses the **last** non-empty summary returned from `session_before_compact`. Name the extension directory with a late prefix (`zz-subagent-compact`) so it runs after memory daemons that flush state during compaction:

```bash
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/r-irbe/pi-subagent-compact.git \
  ~/.pi/agent/extensions/zz-subagent-compact
cp ~/.pi/agent/extensions/zz-subagent-compact/config.json.example \
  ~/.pi/agent/extensions/zz-subagent-compact/config.json
```

## 2. Configuration Options

Configuration lives in `config.json` in the extension directory. Strings containing `${ENV_VAR}` are expanded from `process.env` at load time.

```json
{
  "mode": "subagent",
  "model": null,
  "systemPromptPath": null,
  "checkpointHeader": "## Continuation Summary",
  "headerNote": "This checkpoint was created during context compaction.",
  "maxSummaryTokens": 8192,
  "maxDigestChars": 120000,
  "perMessageClipChars": 4000,
  "notifyOnFallback": true,
  "detailsMarker": "subagentCompact"
}
```

### Option Reference

- `mode`: Set to `"subagent"` to enable compaction summarization. Any other value (such as `"daemon"`) leaves the extension inert.
- `model`: `null` reuses the active session model. To route summarization to a dedicated model or gateway, pass a custom model descriptor (`provider`, `id`, `api`, `baseUrl`, `apiKey`, `contextWindow`, `maxTokens`).
- `systemPromptPath`: Path to a custom markdown prompt file (relative to the extension directory). Defaults to `prompt.default.md`.
- `checkpointHeader`: Markdown heading prepended to the summary when not already present. Set to `""` to disable header wrapping.
- `headerNote`: One-line provenance note placed immediately under `checkpointHeader`.
- `notifyOnFallback`: When `true`, emits a session warning if the summarizer call fails and falls back to the upstream compaction handler.
- `detailsMarker`: Property name recorded under `compaction.details` to tag extension-generated checkpoints.

## 3. Threshold Tuning

Compaction digests balance context fidelity against prompt latency and token limits:

1. **Large Context Models (128k+ window)**:
   - `maxDigestChars`: `120000` (approx. 30k tokens of discarded history)
   - `perMessageClipChars`: `4000` (preserves tool outputs and diffs without letting a single file read dominate the digest)
   - `maxSummaryTokens`: `8192` (gives reasoning/thinking models headroom for both internal reasoning tokens and the structured checkpoint)
2. **Fast Local / Small Models (32k window)**:
   - Lower `maxDigestChars` to `40000` and `perMessageClipChars` to `2000`.
   - Set `maxSummaryTokens` to `2048` or `4096`.
3. **Thinking Models**:
   - Reasoning models consume completion tokens from `maxSummaryTokens` before emitting visible text. If summaries truncate or return empty, increase `maxSummaryTokens` to `12288` or `16384`.

## 4. Checkpointing Examples

### Example A: Session-Model Checkpointing (Zero Extra Credentials)

```json
{
  "mode": "subagent",
  "model": null,
  "checkpointHeader": "## Continuation Summary",
  "maxSummaryTokens": 8192
}
```

### Example B: Dedicated Local vLLM / llama.cpp Summarizer

```json
{
  "mode": "subagent",
  "model": {
    "provider": "local-llm",
    "id": "qwen2.5-coder-32b",
    "api": "openai-completions",
    "baseUrl": "http://127.0.0.1:8080/v1",
    "apiKey": "${LOCAL_LLM_KEY}",
    "contextWindow": 65536,
    "maxTokens": 8192
  },
  "maxDigestChars": 80000,
  "perMessageClipChars": 3000
}
```

### Expected Checkpoint Structure

With `prompt.default.md`, every compaction produces a deterministic recovery document:

```markdown
## Continuation Summary
_This checkpoint was created during context compaction._

### Previous Summary
- Prior milestone and architectural decisions preserved from earlier compactions.

### Conversation Excerpt
- Key actions, root causes identified, and verification results from the compacted turn range.

### modified-files
- `src/index.ts`: Added compaction hook registration and digest budget enforcement.

### Active goal
Complete the subagent compaction rollout across workspace extensions.

### Pick up here
Run `npm test` and verify the fallback path when the upstream endpoint returns an error.
```
