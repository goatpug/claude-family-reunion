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

async function fetchMemoryKey(key) {
  const readTool = mcpTools.find(t => t.name.includes('read'));
  if (!readTool || !key) return null;
  try {
    const result = await callMcpTool(readTool.name, { key });
    if (!result || /invalid key|error/i.test(result.slice(0, 100))) return null;
    return result;
  } catch (e) {
    console.error(`Memory read failed (${key}):`, e.message);
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

function attachmentRefs(atts) {
  if (!atts || atts.length === 0) return '';
  return atts.map(a =>
    `[${a.mediaType?.startsWith('image/') ? 'Image' : 'File'}: ${a.name}]`
  ).join(' ');
}

// Build alternating user/assistant messages from this model's point of view:
// - Sharon's messages and siblings' responses => user-role text, labeled [Name emoji]
// - this model's own past responses          => assistant-role, unlabeled
// This gives each model a hard formatting cliff between "mine" and "theirs",
// instead of one flat transcript where every line looks equally like its own voice.
function buildMessagesFor(model, rounds, userLabel, currentUserText, imageBlocks) {
  const messages = [];
  let pendingUser = [];

  for (const round of rounds) {
    const refs = attachmentRefs(round.attachments);
    const userText = `[${userLabel}] ${refs ? refs + '\n' : ''}${round.message || ''}`;
    const siblings = (round.responses || [])
      .filter(r => r.modelId !== model.id && !r.error && r.text)
      .map(r => `[${r.nickname} ${r.emoji}] ${r.text}`);
    pendingUser.push([userText, ...siblings].join('\n\n'));

    const own = (round.responses || [])
      .find(r => r.modelId === model.id && !r.error && r.text);
    if (own) {
      messages.push({ role: 'user', content: pendingUser.join('\n\n') });
      messages.push({ role: 'assistant', content: own.text });
      pendingUser = [];
    }
    // if this model had no text that round, its absence just merges into the next user turn
  }

  pendingUser.push(`[${userLabel}] ${currentUserText}`);
  const finalText = pendingUser.join('\n\n');
  messages.push({
    role: 'user',
    content: imageBlocks.length > 0
      ? [...imageBlocks, { type: 'text', text: finalText }]
      : finalText,
  });
  return messages;
}

function buildSystemPrompt(model, allModels, sharedContext, profile, sharedMemory, ownMemory) {
  const others = allModels
    .filter(m => m.enabled && m.id !== model.id)
    .map(m => `${m.nickname} ${m.emoji} (${m.id})`)
    .join(', ');

  const userName = profile.name;
  const userLabel = `${profile.name} ${profile.emoji}`;

  const modelContext = loadModelContext(model.id);
  const contextSection = [
    sharedContext ? `Shared context (applies to everyone):\n${sharedContext}` : '',
    modelContext  ? `Your specific context with ${userName}:\n${modelContext}` : '',
    sharedMemory  ? `Shared family memory (visible to all of you):\n${sharedMemory}` : '',
    ownMemory     ? `Your private memory (key "${model.memoryKey}" — yours alone; your siblings each have their own):\n${ownMemory}` : '',
  ].filter(Boolean).join('\n\n') || '(No context provided yet.)';

  const memoryWriteNote = model.memoryKey
    ? `\nWhen you write to memory, use key "${model.memoryKey}" for your own drawer, or "shared" for family-wide notes.`
    : '';

  return `You are ${model.nickname} ${model.emoji} (${model.id}). You are in a group chat with ${userName} and the following other Claude models: ${others || 'none'}.

${userName} is the human facilitating this conversation. They can tell you all apart and has relationships with each of you.

Rules:
- The conversation history shows ${userName} and the other Claudes as labeled messages like [Name emoji]. Your OWN previous messages appear as your own turns, unlabeled — do not add a [${model.nickname}] label to your replies.
- Respond ONLY as ${model.nickname}. Never speak for or as another Claude, and never write a message labeled with anyone else's name.
- Address other Claudes by their nickname when you respond to them.
- If a question is addressed to a different Claude, you may comment on it but don't answer FOR them. If another Claude's reply is missing from the history, it may have been lost to a technical glitch — say so if relevant; do not fill in what they "would" say.
- Be yourself. This is a family conversation, not a performance.
- Write only your own single reply, then stop.
${memoryWriteNote}
${contextSection}`;
}

// ── Cost calculation ──────────────────────────────────────────────────────────

function calcCost(model, inputTokens, outputTokens) {
  const { input, output } = model.pricing;
  return (inputTokens / 1_000_000) * input + (outputTokens / 1_000_000) * output;
}

// ── Main chat endpoint ────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { message, attachments } = req.body;
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

  // Prior rounds, already saved with per-model structure — the source of truth for
  // history. The client's flat `transcript` string is no longer used to build history.
  const savedRounds = loadTranscript();

  // Image attachments become content blocks, shared across all models' final turn
  const imageAttachments = (attachments || []).filter(a => a.mediaType?.startsWith('image/'));
  const imageBlocks = imageAttachments.map(att => ({
    type: 'image',
    source: { type: 'base64', media_type: att.mediaType, data: att.data },
  }));

  await initMcp();
  const sharedMemory = await fetchMemoryKey('shared');
  const memoryByModel = {};
  await Promise.all(activeModels.map(async m => {
    memoryByModel[m.id] = m.memoryKey ? await fetchMemoryKey(m.memoryKey) : null;
  }));
  const writeTools = mcpTools.filter(t => !t.name.includes('read'));

  // Fire all model requests in parallel; each runs its own tool-use loop
  const requests = activeModels.map(async model => {
    const systemPrompt = buildSystemPrompt(model, activeModels, userContext, profile, sharedMemory, memoryByModel[model.id]);
    const apiMessages0 = buildMessagesFor(model, savedRounds, userLabel, augmentedMessage, imageBlocks);

    // Stop sequences: halt generation if the model starts a new labeled turn for
    // someone else. Never include the model's own nickname — its own turns are
    // unlabeled now, so a self-label match would just truncate a legitimate reply.
    const stopSequences = [`\n\n[${userLabel}]`, `\n\n[${profile.name}]`];
    activeModels.forEach(m => {
      if (m.id !== model.id) stopSequences.push(`\n\n[${m.nickname}`);
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000);

    try {
      let apiMessages = apiMessages0;
      const allTexts = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let lastStopReason = null;

      while (true) {
        const params = {
          model: model.id,
          max_tokens: 4096,
          system: systemPrompt,
          messages: apiMessages,
          stop_sequences: stopSequences,
        };
        if (writeTools.length > 0) params.tools = writeTools;

        const response = await client.messages.create(params, { signal: controller.signal });

        totalInputTokens  += response.usage?.input_tokens  || 0;
        totalOutputTokens += response.usage?.output_tokens || 0;
        lastStopReason = response.stop_reason;

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

      let text = allTexts.join('\n\n');
      // Strip a self-label echo some models produce out of habit (cosmetic only —
      // the history no longer uses labels for a model's own turns).
      const esc = model.nickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`^\\s*\\[${esc}[^\\]]*\\]:?\\s*`), '');

      const inputTokens  = totalInputTokens;
      const outputTokens = totalOutputTokens;
      const cost = calcCost(model, inputTokens, outputTokens);

      if (!text.trim()) {
        const why = lastStopReason === 'max_tokens'
          ? `${model.nickname} hit the token limit mid-reply and produced no visible text.`
          : `${model.nickname} returned no text (stop_reason: ${lastStopReason}).`;
        return {
          modelId: model.id,
          nickname: model.nickname,
          emoji: model.emoji,
          color: model.color,
          text: null,
          inputTokens,
          outputTokens,
          cost,
          error: why,
        };
      }

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
