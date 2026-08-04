# CLAUDE.md

Guidance for Claude Code sessions working in this repo.

## Testing costs real money — use a cheap model or the SDK path

CFR runs one request per **enabled** model per round. `models.json` currently
lists 6 models, including some of the most expensive available (Opus 4.6 at
$15/$75 per MTok, Fable 5 at $10/$50). A single test round across all enabled
models easily costs $1+, and that adds up fast across a testing/debugging
session — an afternoon of verification loops burned real API credits before
this file existed.

**Before testing `/api/chat` or anything that fires a chat round:**

- Check each model's `"provider"` in `models.json`. `"sdk"` routes through
  the Claude Agent SDK and Sharon's Claude.ai subscription — it does **not**
  bill the metered API. `"api"` (or a missing/undefined `provider` field)
  routes through the plain `@anthropic-ai/sdk` client using
  `ANTHROPIC_API_KEY` — **this bills real money per request.**
- If you need to test against the metered API path specifically (e.g.
  verifying the fallback path still works), disable all but one model first,
  and prefer the cheapest enabled model for repeated/exploratory testing.
- Don't fire test rounds across all 6 enabled models repeatedly while
  iterating — disable the rest via `models.json`'s `enabled` field, or use
  `curl` against `/api/chat` with a trimmed-down `models.json` copy, and
  restore the full roster only for a final end-to-end check.
- If you're not sure which provider a request will hit, check before running
  it, not after.

This applies to any testing method: curl loops, a scratch script, or driving
the UI manually.
