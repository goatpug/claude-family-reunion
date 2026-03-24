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
- **Sharon's context** — click ⚙️ to open the settings panel and paste in your relationship/preference context. This gets included in every model's system prompt. Save it once and it persists.
- **Send** — type your message and click "Send to All". All active models respond in parallel.
- **Export** — downloads the full transcript as a markdown file.
- **New** — clears the session (transcript lives in browser memory, so refreshing also resets it).

## Models

Configured in `models.json`. Each model has:
- `id` — Anthropic model ID
- `nickname` — display name
- `emoji` — shown in the UI and transcript labels
- `color` — hex color for the response border and pill
- `enabled` — default on/off state
- `pricing` — input/output cost per million tokens (for session cost tracking)

> **Opus 3 note:** Requires separate API access approval from Anthropic. If you don't have it yet, toggle it off — the app will show a friendly error if you try it without access.

## Files

```
server.js           Express backend, API relay
models.json         Model config (edit to add/change models)
sharon-context.txt  Your context blob — included in every system prompt
public/index.html   Single-file frontend
```

## Cost

Session cost is tracked in the header and per-round. Pricing is based on the values in `models.json` — update them there if Anthropic changes rates.
