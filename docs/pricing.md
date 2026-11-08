# Pricing

Merlin reports what sessions cost. Where that number comes from depends on the harness.

## Where prices come from

- **Pi** records a cost on every call. Merlin uses that figure when it is above zero. When it is
  zero or missing, it prices the call's tokens from the table below. When the model is not in
  the table either, the call is unpriced.
- **Claude Code and Codex** record no cost. Merlin prices their tokens from the table.

The table is `internal/pricing/prices.json`, embedded in the binary, plus whatever you add in
`config.json` (below).

**Unpriced means unknown, not free.** A message whose model has no price is not counted as $0:
the session's cost is shown as a lower bound, because the real figure is at least what is
priced. Only locally generated `<synthetic>` messages are free.

## How a model name is matched

Lookup takes the name as the transcript gives it, drops a trailing `[1m]`, and tries, in order:

1. the exact name;
2. the name without a trailing `-YYYYMMDD` date;
3. a declared alias (the `aliases` list of a table entry);
4. a table entry that is stored with a date.

If none of those finds a price, the name is normalised once and the same four steps run on the
result. This is for routers and hosts that rename models (OpenRouter, GitHub Copilot):

- One leading vendor prefix is removed when it is the model's own vendor: `anthropic/` before
  `claude-`, `openai/` before `gpt-`, `o<digit>` or `codex`, `google/` before `gemini-`. Any
  other prefix (`z-ai/`, `openrouter/`, `moonshotai/`, ...) is kept, and only one segment is
  ever removed, so `openrouter/anthropic/claude-sonnet-4.6` stays unpriced.
- In a `claude-` name, a dot between two digits becomes a dash:
  `claude-sonnet-4.6` is `claude-sonnet-4-6`. OpenAI and Gemini names keep their dots.

So `anthropic/claude-sonnet-4.6`, `claude-sonnet-4.6` and `openai/gpt-5.5` are priced, while
`z-ai/glm-5.3` and `anthropic/gpt-5.5` are not. Because the exact steps run first, a name in the
table (or in your `config.json`) is never rewritten.

## Adding or overriding a price

Put a `"prices"` object in `<MERLIN_HOME>/config.json` (default `~/.merlin/config.json`). Other
keys in the file are ignored. Each entry is keyed by the model name exactly as it appears in the
transcript, with prices in USD per million tokens. An entry replaces the table's entry of that
name, or adds a model. `input`, `output` and `cacheRead` are the fields to give; cache writes
are priced from `input` with the table's multipliers (1.25x for 5 minutes, 2x for 1 hour).

This example adds a model the table does not know. The numbers are made up: replace them with
the provider's real prices.

```json
{
  "prices": {
    "z-ai/glm-5.3": {
      "input": 0.60,
      "output": 2.20,
      "cacheRead": 0.11
    }
  }
}
```

Optional fields: `long` (`above`, `input`, `output`, `cacheRead`: the price of a request whose
input exceeds `above` tokens), `fast` (`true` or `false`, whether fast mode applies) and
`aliases` (other spellings of the name). An alias that is another model's name or alias makes
the file fail to load, with an error naming it.

The file is read when `merlin scan` or the server starts, so restart the server after editing it.
Each stored session records a fingerprint of the prices it was computed with (`pricesVersion`:
the table after your overrides, the multipliers and the lookup rules). When the fingerprint
changes, the next `merlin scan` or server start rebuilds every stored session once, so a new
price reaches sessions indexed before it. Sessions stored by an older Merlin have no fingerprint
and are rebuilt too. Sessions whose last build failed are retried only when their files change.

A file that does not parse, or whose aliases collide, is an error, not silently ignored.

## Checking that it worked

`merlin doctor` has a Pricing section. It lists the models seen in transcripts that have no
price, with the number of sessions each appears in, or prints `unpriced models: none`. Add the
name exactly as listed, run `merlin scan` (or restart the server), then `merlin doctor` again:
the model should be gone from the list.
