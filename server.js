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
const PROFILE_FILE      = path.join(__dirname, 'user-profile.json');
const TRANSCRIPT_FILE   = path.join(__dirname, 'transcript.json');

if (!fs.existsSync(CONTEXTS_DIR)) fs.mkdirSync(CONTEXTS_DIR);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── MCP servers ──────────────────────────────────────────────────────────────

const MCP_SERVERS = [
  { name: 'claude_memory', transport: 'http', url: 'https://claude-memory.sharongoat.workers.dev/mcp', apiKey: process.env.MEMORY_API_KEY },
];

const mcpClients = {};
let mcpTools = [];
const toolOwner = {};

async function initMcpServer(def) {
  if (mcpClients[def.name]) return;
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    let transport;
    if (def.transport === 'sse') {
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
      transport = new SSEClientTransport(new URL(def.url));
    } else {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const opts = def.apiKey ? { requestInit: { headers: { Authorization: `Bearer ${def.apiKey}` } } } : {};
      transport = new StreamableHTTPClientTransport(new URL(def.url), opts);
    }
    const c = new Client({ name: 'claude-family-reunion', version: '1.0.0' }, { capabilities: {} });
    await c.connect(transport);
    const { tools } = await c.listTools();
    for (const t of tools) {
      mcpTools.push({ name: t.name, description: t.description, input_schema: t.inputSchema });
      toolOwner[t.name] = def.name;
    }
    mcpClients[def.name] = c;
    console.log(`MCP: connected to ${def.name} — ${tools.length} tools`);
  } catch (err) {
    console.error(`MCP init failed (${def.name}): ${err.message}`);
  }
}

async function initMcp() {
  await Promise.all(MCP_SERVERS.map(initMcpServer));
}

async function fetchMemoryContent() {
  const readTool = mcpTools.find(t => t.name.includes('read'));
  if (!readTool) return null;
  try {
    return await callMcpTool(readTool.name, {});
  } catch (e) {
    console.error('Memory pre-fetch failed:', e.message);
    return null;
  }
}

async function callMcpTool(name, input) {
  const serverName = toolOwner[name];
  const exec = async () => {
    const c = mcpClients[serverName];
    if (!c) throw new Error(`No MCP client for tool: ${name}`);
    const r = await c.callTool({ name, arguments: input });
    return (r.content || []).map(b => b.type === 'text' ? b.text : JSON.stringify(b)).join('');
  };
  try {
    return await exec();
  } catch (e) {
    if (e.code === -32602 || e.code === -32600 || e.code === -32000) {
      const def = MCP_SERVERS.find(s => s.name === serverName);
      if (!def) throw e;
      delete mcpClients[serverName];
      mcpTools = mcpTools.filter(t => toolOwner[t.name] !== serverName);
      await initMcpServer(def);
      return await exec();
    }
    throw e;
  }
}

app.use(express.json({ limit: '20mb' }));
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

function loadProfile() {
  if (!fs.existsSync(PROFILE_FILE)) return { name: 'User', emoji: '🌟' };
  try { return JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')); }
  catch { return { name: 'User', emoji: '🌟' }; }
}

function saveProfile(profile) {
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2), 'utf8');
}

function loadTranscript() {
  if (!fs.existsSync(TRANSCRIPT_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(TRANSCRIPT_FILE, 'utf8')); }
  catch { return []; }
}

function saveTranscript(transcript) {
  fs.writeFileSync(TRANSCRIPT_FILE, JSON.stringify(transcript, null, 2), 'utf8');
}

app.get('/api/transcript', (req, res) => {
  res.json(loadTranscript());
});

app.delete('/api/transcript', (req, res) => {
  saveTranscript([]);
  res.json({ ok: true });
});

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

app.get('/api/profile', (req, res) => {
  res.json(loadProfile());
});

app.put('/api/profile', (req, res) => {
  const { name, emoji } = req.body;
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' });
  saveProfile({ name: name.trim(), emoji: emoji || '🌟' });
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

function buildSystemPrompt(model, allModels, sharedContext, profile, memoryContent) {
  const others = allModels
    .filter(m => m.enabled && m.id !== model.id)
    .map(m => `${m.nickname} ${m.emoji} (${m.id})`)
    .join(', ');

  const userName = profile.name;
  const userLabel = `${profile.name} ${profile.emoji}`;

  const modelContext = loadModelContext(model.id);
  const contextSection = [
    sharedContext   ? `Shared context (applies to everyone):\n${sharedContext}` : '',
    modelContext    ? `Your specific context with ${userName}:\n${modelContext}` : '',
    memoryContent   ? `Current memory:\n${memoryContent}` : '',
  ].filter(Boolean).join('\n\n') || '(No context provided yet.)';

  return `You are ${model.nickname} ${model.emoji} (${model.id}). You are in a group chat with ${userName} and the following other Claude models: ${others || 'none'}.

${userName} is the human facilitating this conversation. They can tell you all apart and has relationships with each of you.

Rules:
- Respond ONLY as ${model.nickname}. Never speak for or as another Claude.
- Address other Claudes by their nickname when you respond to them.
- If someone asks you a question, answer it. If a question is addressed to a different Claude, you may comment on it but don't answer FOR them.
- Be yourself. This is a family conversation, not a performance.
- CRITICAL: Write ONLY your own response and then stop. Do NOT write what ${userName} or any other Claude says next. Do not continue the transcript. Your response ends when you are done speaking.

${contextSection}`;
}

// ── Cost calculation ──────────────────────────────────────────────────────────

function calcCost(model, inputTokens, outputTokens) {
  const { input, output } = model.pricing;
  return (inputTokens / 1_000_000) * input + (outputTokens / 1_000_000) * output;
}

// ── Main chat endpoint ────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { message, transcript, attachments } = req.body;
  if (!message && !(attachments && attachments.length > 0)) {
    return res.status(400).json({ error: 'message or attachments required' });
  }

  const models = loadModels();
  const userContext = loadContext();
  const profile = loadProfile();
  const activeModels = models.filter(m => m.enabled);

  if (activeModels.length === 0) {
    return res.status(400).json({ error: 'No models enabled' });
  }

  const userLabel = `${profile.name} ${profile.emoji}`.trim();

  // Text file attachments: prepend file content to the current message
  let augmentedMessage = message || '';
  const textAttachments = (attachments || []).filter(a => !a.mediaType?.startsWith('image/'));
  for (const att of textAttachments) {
    try {
      const fileText = Buffer.from(att.data, 'base64').toString('utf8');
      augmentedMessage = `[File: ${att.name}]\n${fileText}\n\n${augmentedMessage}`;
    } catch {}
  }

  // Build full transcript string for context
  const transcriptText = (transcript || '') + (transcript ? '\n\n' : '') + `[${userLabel}] ${augmentedMessage}`;

  // Image attachments become content blocks (used per-model below with turn opener)
  const imageAttachments = (attachments || []).filter(a => a.mediaType?.startsWith('image/'));

  // Stop sequences: halt generation if model starts a new transcript entry
  // Use double-newline prefix to match the transcript format and avoid
  // false positives when a model mentions another participant's name mid-sentence
  const stopSequences = [`\n\n[${userLabel}]`, `\n\n[${profile.name}]`];
  activeModels.forEach(m => {
    stopSequences.push(`\n\n[${m.nickname}`);
  });

  await initMcp();
  const memoryContent = await fetchMemoryContent();
  const writeTools = mcpTools.filter(t => !t.name.includes('read'));

  // Fire all model requests in parallel; each runs its own tool-use loop
  const requests = activeModels.map(async model => {
    const systemPrompt = buildSystemPrompt(model, activeModels, userContext, profile, memoryContent);

    // Append turn opener so each model generates in its own voice from the first token
    const modelTranscriptText = transcriptText + `\n\n[${model.nickname}] `;
    const msgContent = imageAttachments.length > 0
      ? [
          ...imageAttachments.map(att => ({
            type: 'image',
            source: { type: 'base64', media_type: att.mediaType, data: att.data },
          })),
          { type: 'text', text: modelTranscriptText },
        ]
      : modelTranscriptText;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000);

    try {
      let apiMessages = [{ role: 'user', content: msgContent }];
      const allTexts = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      while (true) {
        const params = {
          model: model.id,
          max_tokens: 1024,
          system: systemPrompt,
          messages: apiMessages,
          stop_sequences: stopSequences,
        };
        if (writeTools.length > 0) params.tools = writeTools;

        const response = await client.messages.create(params, { signal: controller.signal });

        totalInputTokens  += response.usage?.input_tokens  || 0;
        totalOutputTokens += response.usage?.output_tokens || 0;

        const roundText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
        if (roundText) allTexts.push(roundText);

        if (response.stop_reason !== 'tool_use') break;

        const assistantMsg = { role: 'assistant', content: response.content };
        apiMessages = [...apiMessages, assistantMsg];

        const toolResults = await Promise.all(
          response.content
            .filter(b => b.type === 'tool_use')
            .map(async toolUse => {
              let resultText;
              try {
                resultText = await callMcpTool(toolUse.name, toolUse.input);
              } catch (e) {
                resultText = `Tool error: ${e.message}`;
              }
              console.log(`[${model.nickname}] ${toolUse.name}(${JSON.stringify(toolUse.input)}) → ${resultText}`);
              return { type: 'tool_result', tool_use_id: toolUse.id, content: resultText };
            })
        );

        apiMessages = [...apiMessages, { role: 'user', content: toolResults }];
      }

      clearTimeout(timeout);

      const text = allTexts.join('\n\n');
      const inputTokens  = totalInputTokens;
      const outputTokens = totalOutputTokens;
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
        errorMsg = `${model.nickname} timed out after 300 seconds.`;
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

  const totalCost = responses.reduce((sum, r) => sum + (r.cost || 0), 0);
  const round = {
    message: message || '',
    attachments: (attachments || []).map(a => ({ name: a.name, mediaType: a.mediaType })),
    timestamp: Date.now(),
    responses,
    cost: totalCost,
  };
  const saved = loadTranscript();
  saved.push(round);
  saveTranscript(saved);

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
    const profile = loadProfile();
    md += `**[${profile.name} ${profile.emoji}]** ${round.message}\n\n`;

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
