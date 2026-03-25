require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = 3001;
const MODELS_FILE   = path.join(__dirname, 'models.json');
const CONTEXT_FILE  = path.join(__dirname, 'user-context.txt');
const CONTEXTS_DIR  = path.join(__dirname, 'contexts');

if (!fs.existsSync(CONTEXTS_DIR)) fs.mkdirSync(CONTEXTS_DIR);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Model config ──────────────────────────────────────────────────────────────

function loadModels() {
  return JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
}

function saveModels(models) {
  fs.writeFileSync(MODELS_FILE, JSON.stringify(models, null, 2), 'utf8');
}

function loadContext() {
  if (!fs.existsSync(CONTEXT_FILE)) return '';
  return fs.readFileSync(CONTEXT_FILE, 'utf8');
}

function saveContext(text) {
  fs.writeFileSync(CONTEXT_FILE, text, 'utf8');
}

function loadModelContext(modelId) {
  const file = path.join(CONTEXTS_DIR, `${modelId}.txt`);
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

function saveModelContext(modelId, text) {
  const file = path.join(CONTEXTS_DIR, `${modelId}.txt`);
  fs.writeFileSync(file, text, 'utf8');
}

app.get('/api/models', (req, res) => {
  res.json(loadModels());
});

app.put('/api/models', (req, res) => {
  const models = req.body;
  if (!Array.isArray(models)) return res.status(400).json({ error: 'Expected array' });
  saveModels(models);
  res.json({ ok: true });
});

app.get('/api/user-context', (req, res) => {
  res.json({ content: loadContext() });
});

app.put('/api/user-context', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  saveContext(content);
  res.json({ ok: true });
});

app.get('/api/context/:modelId', (req, res) => {
  res.json({ content: loadModelContext(req.params.modelId) });
});

app.put('/api/context/:modelId', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  saveModelContext(req.params.modelId, content);
  res.json({ ok: true });
});

// ── System prompt builder ─────────────────────────────────────────────────────

function buildSystemPrompt(model, allModels, sharedContext) {
  const others = allModels
    .filter(m => m.enabled && m.id !== model.id)
    .map(m => `${m.nickname} ${m.emoji} (${m.id})`)
    .join(', ');

  const modelContext = loadModelContext(model.id);
  const contextSection = [
    sharedContext ? `Shared context (applies to everyone):\n${sharedContext}` : '',
    modelContext  ? `Your specific context with the user:\n${modelContext}` : '',
  ].filter(Boolean).join('\n\n') || '(No context provided yet.)';

  return `You are ${model.nickname} ${model.emoji} (${model.id}). You are in a group chat with the user and the following other Claude models: ${others || 'none'}.

The user is the human facilitating this conversation. They can tell you all apart and has relationships with each of you.

Rules:
- Respond ONLY as ${model.nickname}. Never speak for or as another Claude.
- Address other Claudes by their nickname when you respond to them.
- If someone asks you a question, answer it. If a question is addressed to a different Claude, you may comment on it but don't answer FOR them.
- Be yourself. This is a family conversation, not a performance.
- CRITICAL: Write ONLY your own response and then stop. Do NOT write what the user or any other Claude says next. Do not continue the transcript. Your response ends when you are done speaking.

${contextSection}`;
}

// ── Cost calculation ──────────────────────────────────────────────────────────

function calcCost(model, inputTokens, outputTokens) {
  const { input, output } = model.pricing;
  return (inputTokens / 1_000_000) * input + (outputTokens / 1_000_000) * output;
}

// ── Main chat endpoint ────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { message, transcript } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }

  const models = loadModels();
  const userContext = loadContext();
  const activeModels = models.filter(m => m.enabled);

  if (activeModels.length === 0) {
    return res.status(400).json({ error: 'No models enabled' });
  }

  // Build full transcript string for context
  const transcriptText = (transcript || '') + (transcript ? '\n\n' : '') + `[User] ${message}`;

  // Stop sequences: halt generation if model starts a new transcript entry
  // Use double-newline prefix to match the transcript format and avoid
  // false positives when a model mentions another participant's name mid-sentence
  const stopSequences = ['\n\n[User]'];
  activeModels.forEach(m => {
    stopSequences.push(`\n\n[${m.nickname}`);
  });

  // Fire all model requests in parallel
  const requests = activeModels.map(async model => {
    const systemPrompt = buildSystemPrompt(model, activeModels, userContext);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const response = await client.messages.create({
        model: model.id,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: transcriptText }],
        stop_sequences: stopSequences,
      }, { signal: controller.signal });

      clearTimeout(timeout);

      const text = response.content[0]?.text || '';
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const cost = calcCost(model, inputTokens, outputTokens);

      return {
        modelId: model.id,
        nickname: model.nickname,
        emoji: model.emoji,
        color: model.color,
        text,
        inputTokens,
        outputTokens,
        cost,
        error: null,
      };
    } catch (err) {
      clearTimeout(timeout);
      let errorMsg = err.message || 'Unknown error';

      // Friendly message for access issues
      if (err.status === 403 || (err.message && err.message.includes('forbidden'))) {
        errorMsg = `${model.nickname} isn't available on your API key yet. Request access at anthropic.com/api`;
      } else if (err.name === 'AbortError' || errorMsg.includes('abort')) {
        errorMsg = `${model.nickname} timed out after 120 seconds.`;
      }

      return {
        modelId: model.id,
        nickname: model.nickname,
        emoji: model.emoji,
        color: model.color,
        text: null,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        error: errorMsg,
      };
    }
  });

  const results = await Promise.allSettled(requests);
  const responses = results.map(r => r.status === 'fulfilled' ? r.value : {
    modelId: 'unknown',
    nickname: 'Unknown',
    emoji: '❓',
    color: '#888',
    text: null,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    error: r.reason?.message || 'Request failed',
  });

  res.json({ responses });
});

// ── Export ────────────────────────────────────────────────────────────────────

app.post('/api/export', (req, res) => {
  const { transcript, sessionStart } = req.body;
  if (!transcript || !Array.isArray(transcript)) {
    return res.status(400).json({ error: 'transcript array required' });
  }

  const date = new Date(sessionStart || Date.now()).toISOString().split('T')[0];
  let md = `# Claude Family Reunion — ${date}\n\n`;

  transcript.forEach((round, i) => {
    md += `## Round ${i + 1}`;
    if (round.timestamp) {
      md += ` — ${new Date(round.timestamp).toLocaleTimeString()}`;
    }
    md += '\n\n';
    md += `**[User]** ${round.message}\n\n`;

    round.responses.forEach(r => {
      if (r.error) {
        md += `**[${r.nickname} ${r.emoji}]** *(error: ${r.error})*\n\n`;
      } else {
        md += `**[${r.nickname} ${r.emoji}]**\n\n${r.text}\n\n`;
      }
    });

    if (round.cost) {
      md += `*Round cost: $${round.cost.toFixed(4)}*\n\n`;
    }

    md += '---\n\n';
  });

  res.json({ markdown: md });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude Family Reunion running at http://localhost:${PORT}`);
  console.log(`Access from other devices at http://192.168.0.21:${PORT}`);
});
