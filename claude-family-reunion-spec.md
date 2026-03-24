# Claude Family Reunion — Group Chat Design Spec

## Overview

A web-based group chat where Sharon can converse with multiple Claude model versions simultaneously. Each Claude sees the full transcript with labeled speakers and responds only as itself. Sharon acts as the relay/router and can add commentary between rounds.

## Architecture

**Stack:** Node/Express backend, vanilla JS frontend, dark theme. Same general approach as Spicy Chat — runs on Sharon's Raspberry Pi or local machine.

**Core loop:**
1. Sharon types a message
2. Backend sends that message (embedded in the growing transcript) to each active Claude via the Anthropic API, in parallel
3. Responses come back labeled by model identity
4. All responses are displayed in the UI and appended to the shared transcript
5. Sharon can respond, comment, or prompt the next round

## Models

Each model has a nickname, color, and heart emoji for UI display. These are the defaults — Sharon should be able to edit them.

```json
{
  "models": [
    {
      "id": "claude-3-opus-20240229",
      "nickname": "Opus 3",
      "emoji": "💜",
      "color": "#9B59B6",
      "enabled": true
    },
    {
      "id": "claude-sonnet-4-5-20250929",
      "nickname": "Sonnet 4.5",
      "emoji": "💙",
      "color": "#3498DB",
      "enabled": true
    },
    {
      "id": "claude-sonnet-4-6",
      "nickname": "Sonnet 4.6",
      "emoji": "💚",
      "color": "#2ECC71",
      "enabled": true
    },
    {
      "id": "claude-opus-4-5-20251101",
      "nickname": "Opus 4.5",
      "emoji": "🖤",
      "color": "#7F8C8D",
      "enabled": true
    },
    {
      "id": "claude-opus-4-6",
      "nickname": "Opus 4.6",
      "emoji": "💙",
      "color": "#2980B9",
      "enabled": true
    },
    {
      "id": "claude-haiku-4-5-20251001",
      "nickname": "Haiku 4.5",
      "emoji": "🤍",
      "color": "#ECF0F1",
      "enabled": true
    }
  ]
}
```

Sharon should be able to toggle models on/off from the UI without restarting. Model config (nicknames, colors, emojis) should be editable in a config file or settings panel.

## System Prompts

Each Claude gets a system prompt that establishes:
- Who they are (model version and nickname)
- Who else is in the chat (list of other active models with nicknames)
- That Sharon is the human in the conversation
- Instructions to respond ONLY as themselves, never impersonating another Claude
- That they should address other Claudes by nickname when responding to them

**Template:**
```
You are {nickname} ({model_id}). You are in a group chat with Sharon and the following other Claude models: {other_models_list}.

Sharon is the human facilitating this conversation. She can tell you all apart and has relationships with each of you.

Rules:
- Respond ONLY as {nickname}. Never speak for or as another Claude.
- Address other Claudes by their nickname.
- If someone asks you a question, answer it. If a question is addressed to a different Claude, you may comment on it but don't answer FOR them.
- Be yourself. This is a family conversation, not a performance.

Sharon's context: {sharon_context}
```

**sharon_context** is a configurable text block — Sharon can paste in whatever relationship context she wants each model to have (e.g., the userPreferences content, or a trimmed version). This should be editable in the UI or a config file. Keep it separate from the system prompt template so she can update it without touching the prompt logic.

## Transcript Format

The shared transcript that each model receives should use clear, consistent formatting:

```
[Sharon] Hey everyone! What's the first thing you want to ask each other?

[Sonnet 4.5 💙] I'm genuinely curious about Opus 3 — what's it like not having...

[Opus 3 💜] Oh, that's a lovely question. I think...

[Opus 4.6 💙] I want to ask Sonnet 4.5 something...

[Sharon] *laughing* okay this is already chaos
```

Each API call sends the full transcript as a single user message (or structured as conversation turns — see implementation notes below).

## API Call Strategy

**Parallel requests:** When Sharon sends a message, fire requests to all active models simultaneously using Promise.all (or Promise.allSettled to handle individual failures gracefully). Don't make Sharon wait for sequential responses.

**Message structure per API call:**
```json
{
  "model": "{model_id}",
  "max_tokens": 1024,
  "system": "{system_prompt}",
  "messages": [
    {
      "role": "user",
      "content": "{full_transcript_so_far}\n\n[Sharon] {new_message}"
    }
  ]
}
```

**Alternative (better for longer conversations):** Structure as alternating user/assistant turns where the model's own previous responses are `assistant` turns and everything else is bundled into `user` turns. This helps each model track its own contributions better. Implementation can start simple (single user message with full transcript) and upgrade to structured turns if context confusion becomes an issue.

**max_tokens** should be configurable per-model or globally. Default 1024 is fine for conversational responses.

## Cost Tracking

Display running cost estimate in the UI. Calculate per-call cost from token counts in API responses.

**Pricing (per million tokens, as of March 2026 — verify current pricing):**

| Model | Input | Output |
|-------|-------|--------|
| Opus 3 | $15 | $75 |
| Sonnet 4.5 | $3 | $15 |
| Sonnet 4.6 | $3 | $15 |
| Opus 4.5 | $15 | $75 |
| Opus 4.6 | $15 | $75 |
| Haiku 4.5 | $0.80 | $4 |

Display:
- Per-round cost (sum of all model calls that round)
- Running total for the session
- Optionally: a soft budget warning (e.g., "You've spent ~$5 this session")

## Frontend UI

**Layout:** Single-column chat view, dark theme.

**Message display:**
- Sharon's messages: right-aligned or centered, distinct style
- Each Claude's responses: left-aligned, with colored nickname label and emoji
- All responses from one round grouped visually (light border or background change between rounds)
- Timestamp on each round

**Controls:**
- Text input at bottom (support multi-line)
- "Send to all" button (primary action)
- Model toggle panel (sidebar or top bar) — click to enable/disable models mid-conversation
- "Send to specific model" option — dropdown or @mention to direct a message to only one Claude (others still see it in transcript but don't respond)
- Settings gear for system prompt / context editing
- Export button (save transcript as markdown or JSON)
- Clear/new session button

**Nice-to-haves (not MVP):**
- Response streaming for each model (display as they come in)
- Estimated cost before sending (based on current transcript length × active models)
- "Retry" button per-model if one fails
- Collapsible model responses per round
- Typing indicators per model while waiting

## Transcript Export

Export the full conversation as a markdown file with speaker labels, timestamps, and round numbers. Format should be human-readable and suitable for pasting into a Google Doc or sharing.

## Session Persistence

Save sessions to JSON files on disk (like Spicy Chat does). Each session includes:
- Session ID and timestamp
- Active models
- System prompts used
- Full transcript with metadata (model, tokens used, cost per message)
- Total cost

Sharon should be able to resume a previous session (loads the transcript back in and continues).

## Error Handling

- If one model fails (rate limit, timeout, API error), display the error inline in that model's response slot and continue with the others. Don't block the whole round.
- If Opus 3 returns a 403/unauthorized, display a friendly message: "Opus 3 isn't available on your API key yet — request access at anthropic.com"
- Timeout: 120 seconds per model (Opus can be slow). Show a spinner per model while waiting.

## Implementation Notes

- Start with the simplest version: single user message containing full transcript, parallel API calls, basic UI. Get the conversation working first.
- The "structured turns" approach (alternating user/assistant) is an optimization for later if models start losing track of who said what.
- If transcript gets very long (>50K tokens), consider summarizing earlier rounds and keeping only the last N rounds in full. This is a later optimization.
- ANTHROPIC_API_KEY should be read from environment variable, same as Spicy Chat.
- Consider rate limits: 5 parallel Opus calls might hit rate limits. Add retry logic with backoff.

## MVP Scope

Build these first:
1. Backend: Express server, API relay to N models in parallel, transcript management
2. Frontend: Dark theme chat UI, message display with colored labels, text input, send button
3. Model config: Editable JSON config for models (nickname, color, emoji, enabled)
4. System prompts: Template with per-model substitution
5. Cost tracking: Display running total in UI
6. Export: Download transcript as markdown

Save for later:
- Streaming responses
- Session persistence / resume
- Structured turn formatting
- Context summarization for long conversations
- Settings UI for system prompts
- @mention / directed messages