# pi-subagent-compact

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that takes
over compaction summaries: instead of the built-in summary (or a memory
daemon's HTTP round-trip), it summarizes the messages being discarded with a
one-shot LLM call on **the session's own model** -- or any model you
configure -- and returns the result in a checkpoint format you control.

## Why

Pi's `session_before_compact` hook lets extensions replace the summary that a
compacted session resumes from. That summary is the single most-read document
in a long-running session: every resume, every recovery tool, every follow-on
agent reads it. This extension gives you direct control over how it is
written:

- **Your model.** Use the session's own model (no extra configuration, no
  API keys) or pin a dedicated cheap/fast summarizer model.
- **Your format.** Ship a custom system prompt; the default produces a
  continuation checkpoint with `Previous Summary`, `Conversation Excerpt`,
  `modified-files`, `Active goal`, and `Pick up here` sections.
- **Your header.** Wrap the summary in a recognizable top-line header
  (recovery tools can grep for it), or disable the wrapper entirely.
- **A true fallback.** On any failure the handler returns `undefined`, so any
  other compaction handler keeps authority. A broken summarizer can never
  break a compaction.

## Install

Clone into pi's extension directory. The directory name decides load order:
pi loads extensions alphabetically and the **last** compaction handler's
summary wins, so to override another extension's summary, sort after it
(`zz-` beats nearly everything):

```sh
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/r-irbe/pi-subagent-compact.git \
  ~/.pi/agent/extensions/zz-subagent-compact
cp ~/.pi/agent/extensions/zz-subagent-compact/config.json.example \
  ~/.pi/agent/extensions/zz-subagent-compact/config.json
```

`config.json` is required only to switch the mode on; without it the
extension stays inert and your existing compaction path is untouched.

## Configuration

All keys are optional; the defaults are shown in `config.json.example`.

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `"daemon"` | `"subagent"` activates this extension; anything else keeps it inert. (`compactionSummarizer` is accepted as a legacy alias.) |
| `model` | `null` | `null` = use the session's own model. Otherwise an object: `{ "provider", "id", "api", "baseUrl", "apiKey", "reasoning", "contextWindow", "maxTokens", "compat" }` -- a custom provider entry in the shape of pi's `models.json`. |
| `systemPromptPath` | `null` | Path to a custom system prompt file (relative paths resolve against the extension directory). Defaults to the bundled `prompt.default.md`. |
| `checkpointHeader` | `"## Continuation Summary"` | Top-line header prepended when missing. Set to `""` to disable the wrapper. |
| `headerNote` | `"This checkpoint was created during context compaction."` | One-line note directly under the header. |
| `maxSummaryTokens` | `8192` | Completion budget for the summary call. Thinking models spend from this budget; raise it if summaries come back empty. |
| `maxDigestChars` | `120000` | Total character budget for the transcript digest. |
| `perMessageClipChars` | `4000` | Per-message clip inside the digest. |
| `notifyOnFallback` | `true` | Surface a warning in the session when falling back. |
| `detailsMarker` | `"subagentCompact"` | Key under `compaction.details` marking extension-produced summaries (`null` disables). |

Every string value of the form `${VAR}` is expanded from the environment at
load time, so secrets can stay out of the config file:

```json
{
  "mode": "subagent",
  "model": {
    "provider": "custom",
    "id": "my-summarizer",
    "api": "openai-completions",
    "baseUrl": "https://my-gateway.example/v1",
    "apiKey": "${MY_SUMMARIZER_KEY}",
    "contextWindow": 131072,
    "maxTokens": 32768
  }
}
```

### Example: a memory-daemon setup

The extension was built alongside a memory daemon that flushes pending
summaries during compaction and also produces a checkpoint. Installing this
extension to sort after the daemon's directory keeps the daemon's flush and
checkpoint side effects running while this extension's summary becomes the
one pi stores. This repository's origin configuration does exactly that with
`remnic` (see `docs/` there if you want the full daemon story).

## How it works

1. Pi fires `session_before_compact` with `preparation.messagesToSummarize`
   (the entries about to be discarded), `preparation.previousSummary`, and
   an abort signal.
2. The extension flattens the messages into a bounded digest (role-tagged,
   per-message clipped, total-budgeted).
3. One completion call produces the checkpoint. Error results
   (`stopReason: "error"`) are treated as failures, not summaries.
4. The summary is returned to pi as the compaction result. Handlers that
   ran earlier keep their side effects.

## Development

```sh
npm test        # pure-logic self-test (no network, no pi)
```

The self-test covers digest building, clipping and budget truncation,
previous-summary carry, and the header wrapper.

## Compatibility

- pi with the extension API (`session_before_compact`), including the
  extension runner's last-non-null-result semantics for before-events.
- Any OpenAI-compatible endpoint (the `openai-completions` API), which
  covers llama.cpp, Ollama, vLLM, LiteLLM, and most gateways.

## License

Apache-2.0
