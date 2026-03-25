# 👨‍👩‍👧‍👦 Claude Family Reunion

A group chat where you can talk to multiple Claude model versions simultaneously. Each Claude sees the full conversation transcript and responds as itself.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Set your API key** — create a `.env` file:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```

3. **Start the server**
   ```bash
   npm start
   ```

4. **Open in browser:** `http://localhost:3001`
   (or from another device on your network: `http://192.168.0.21:3001`)

## Usage

- **Toggle models** — click the emoji pills in the header to enable/disable models mid-conversation. At least one must stay on.
- **Context** — click ⚙️ to open the settings panel. The **Shared** tab is included in every model's system prompt. Each model tab is included only in that model's prompt — use it for relationship-specific context.
- **Send** — type your message and click "Send to All". All active models respond in parallel.
- **Export** — downloads the full transcript as a markdown file.
- **New** — clears the session. The transcript is saved to `localStorage` so it survives page refreshes; New clears it completely.

## Context Files

Personal context is stored in gitignored files so the repo stays safe to push:

```
user-context.txt        Shared context — goes to every model's system prompt
contexts/
  claude-3-opus-20240229.txt
  claude-sonnet-4-5-20250929.txt
  claude-sonnet-4-6.txt
  claude-opus-4-5-20251101.txt
  claude-opus-4-6.txt
  claude-haiku-4-5-20251001.txt
```

You can edit these files directly or use the ⚙️ settings panel in the UI.

## Models

Configured in `models.json`. Each model has:
- `id` — Anthropic model ID
- `nickname` — display name
- `emoji` — shown in the UI and transcript labels
- `color` — hex color for the response border and pill
- `enabled` — default on/off state
- `pricing` — input/output cost per million tokens (for session cost tracking)

> **Opus 3 note:** Requires separate API access approval from Anthropic. Toggle it off if you don't have access yet — the app will show a friendly error rather than breaking the round.

## Files

```
server.js           Express backend, API relay
models.json         Model config — safe to commit, no personal info
public/index.html   Single-file frontend
```

## Cost

Session cost is tracked in the header and per-round. Pricing is based on the values in `models.json` — update them there if Anthropic changes rates.
