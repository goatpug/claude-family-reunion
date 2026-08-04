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
const SESSIONS_FILE      = path.join(__dirname, 'sessions.json');
const UPLOADS_DIR        = path.join(__dirname, 'uploads');
// Dedicated, stable working directory for "sdk"-provider query() calls — kept
// separate from __dirname (this repo, where Sharon does actual coding work
// with Claude Code, which accumulates its own project-scoped auto-memory
// full of unrelated personal/dev context) so a CFR sibling's session can't
// inherit it. Must stay fixed: the SDK keys session storage off this path,
// so changing it would orphan every stored sessions.json entry.
const SDK_CWD = path.join(__dirname, '.agent-cwd');

// How many of the most recent rounds get their images re-sent (as real image
// content blocks) to models on every subsequent request. Older rounds fall
// back to a `[Image: name]` text placeholder to bound per-round input tokens.
const IMAGE_HISTORY_ROUNDS = 5;

if (!fs.existsSync(CONTEXTS_DIR)) fs.mkdirSync(CONTEXTS_DIR);
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(SDK_CWD)) fs.mkdirSync(SDK_CWD);

// Capture the API key for the metered fallback client, then strip it from
// process.env immediately. The Claude Agent SDK spawns its own Claude Code
// subprocess per query() call and defaults its child env to process.env — if
// ANTHROPIC_API_KEY were still set there, every "sdk"-provider model would
// silently bill against this console key instead of drawing on the Claude.ai
// subscription. Capturing it here and passing it explicitly to the Anthropic
// client below is what keeps the two paths isolated.
const apiKey = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const client = new Anthropic({ apiKey });

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

// ── Claude Agent SDK ("sdk"-provider models) ───────────────────────────────────
//
// Models with provider:"sdk" in models.json go through the Claude Agent SDK
// instead of the plain Messages API client above, which routes them through
// Sharon's Claude.ai subscription (via the locally logged-in `claude` CLI)
// instead of metered console billing. This only works because ANTHROPIC_API_KEY
// was already stripped from process.env at startup (see the `client`
// construction above) — the SDK spawns a Claude Code subprocess per query()
// call and defaults its env to process.env.
//
// Unlike the API-path loop above, history for an "sdk" model lives inside a
// real Claude Agent SDK session (see loadSessions/saveSessions) rather than a
// rebuilt messages array — query() takes a prompt (string or streamed user
// messages), not a prebuilt conversation, so there's nowhere to splice
// reconstructed history in without reintroducing the identity-bleed problem
// commit 760f308 fixed. Each round we send only the new turn and let `resume`
// pull in this model's own prior turns; the sibling replies from the round
// immediately before this one are prepended as text (see buildSiblingPrefix)
// since they never entered this model's own session on their own.

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let agentSdkQueryFn = null;
async function initAgentSdk() {
  if (!agentSdkQueryFn) {
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    agentSdkQueryFn = mod.query;
  }
  return agentSdkQueryFn;
}

// Sibling replies from the round immediately before this one, formatted the
// same way buildMessagesFor() labels them for the API path. Only the most
// recent round is included — see the file header comment above for why.
function buildSiblingPrefix(lastRound, model) {
  if (!lastRound) return '';
  const siblings = (lastRound.responses || [])
    .filter(r => r.modelId !== model.id && !r.error && r.text)
    .map(r => `[${r.nickname} ${r.emoji}] ${r.text}`);
  return siblings.length > 0 ? siblings.join('\n\n') + '\n\n' : '';
}

// query()'s streaming-input mode is what lets a user turn carry image content
// blocks — the plain-string prompt form can't. This yields exactly one turn;
// session_id is filled in by the SDK, uuid is left unset (optional in this
// SDK version).
async function* singleUserTurn(text, imageBlocks) {
  yield {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: imageBlocks.length > 0 ? [...imageBlocks, { type: 'text', text }] : text,
    },
  };
}

// There's no stop_sequences equivalent in the Agent SDK's Options, so the
// identity-bleed guard the API path gets from stop_sequences has to happen
// after the fact instead: truncate at the first line that looks like another
// participant starting a new labeled turn. Mirrors the stopSequences list
// built in the API path below — [userLabel]/[profileName] need the closing
// bracket (both are known exactly), sibling nicknames only match the open
// bracket + name (a sibling's turn may append its own emoji after the name).
function truncateAtForeignLabel(text, model, activeModels, userLabel, profileName) {
  const patterns = [
    new RegExp(`\\n\\n\\[${escapeRegExp(userLabel)}\\]`),
    new RegExp(`\\n\\n\\[${escapeRegExp(profileName)}\\]`),
    ...activeModels
      .filter(m => m.id !== model.id)
      .map(m => new RegExp(`\\n\\n\\[${escapeRegExp(m.nickname)}`)),
  ];
  let cut = text.length;
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).trimEnd();
}

// Run one round for one "sdk"-provider model: resumes (or starts) this
// model's persistent session, sends the new turn, and returns the same
// shape the API path returns so both paths are interchangeable to the caller.
async function sdkChat({ model, systemPrompt, text, imageBlocks, sessionId, abortController }) {
  const query = await initAgentSdk();
  const memoryServer = MCP_SERVERS.find(s => s.name === 'claude_memory');

  const options = {
    model: model.id,
    systemPrompt,
    // Isolation: a CFR sibling's persona must be built entirely from
    // buildSystemPrompt() above (shared context + this model's own
    // contexts/*.txt + its own memory-worker drawer) — nothing ad hoc from
    // Sharon's other Claude usage. Two things leak in by default if left
    // unset, both confirmed by testing before these were added:
    //   - settingSources defaults to loading ALL filesystem settings
    //     sources, which pulled in Sharon's global ~/.claude/CLAUDE.md
    //     (written for a completely different, much more personal context).
    //   - cwd defaults to process.cwd() (this repo), and Claude Code's
    //     "auto-memory" is scoped to that directory's own
    //     ~/.claude/projects/<cwd>/memory/ — since Sharon does actual coding
    //     work on this repo through Claude Code, that directory accumulates
    //     unrelated dev-session memory a chat persona shouldn't see.
    // cwd is pinned to a dedicated SDK_CWD (see its own comment above) rather
    // than disabled outright, because sessions are keyed by cwd — an unset
    // or wrong cwd would silently break `resume` across restarts.
    settingSources: [],
    cwd: SDK_CWD,
    settings: { autoMemoryEnabled: false },
    maxTurns: 5, // memory writes take a couple of tool round-trips
    tools: [], // no built-in Bash/Read/etc. — this runs unattended, nothing to approve them
    allowedTools: ['mcp__claude_memory__memory_append', 'mcp__claude_memory__memory_read'],
    permissionMode: 'dontAsk', // pre-approved tools only; no one is present to approve a prompt
    mcpServers: {
      claude_memory: {
        type: 'http',
        url: memoryServer.url,
        ...(memoryServer.apiKey ? { headers: { Authorization: `Bearer ${memoryServer.apiKey}` } } : {}),
      },
    },
    abortController,
  };
  if (sessionId) options.resume = sessionId;

  const q = query({ prompt: singleUserTurn(text, imageBlocks), options });

  let finalResult = null;
  for await (const msg of q) {
    if (msg.type === 'result') finalResult = msg;
  }

  if (!finalResult) throw new Error('Agent SDK session produced no result');
  if (finalResult.subtype !== 'success') {
    throw new Error(`Agent SDK session ended: ${finalResult.subtype}`);
  }

  return {
    text: finalResult.result || '',
    sessionId: finalResult.session_id,
    inputTokens: finalResult.usage?.input_tokens || 0,
    outputTokens: finalResult.usage?.output_tokens || 0,
    costUsd: finalResult.total_cost_usd || 0,
  };
}

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Upload storage ────────────────────────────────────────────────────────────

// Sanitize an attachment's client-supplied filename to a safe basename before
// it ever touches the filesystem. path.basename() strips any directory
// components (defeats '../'); the extra whitelist strips anything else that
// isn't a plain filename character.
function safeFilename(name) {
  const base = path.basename(name || 'file');
  const cleaned = base.replace(/[^\w.-]/g, '_');
  return cleaned || 'file';
}

// Extension is derived from mediaType, not the client-supplied filename — the
// frontend re-encodes every image to JPEG before upload (see the canvas
// downscale step), so trusting the original name's extension would write
// JPEG bytes under a stale extension and serve them with the wrong
// Content-Type via express.static's mime lookup.
const IMAGE_EXT_BY_MEDIA_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// Write a decoded image attachment to disk and return the stored basename.
function storeImageAttachment(att) {
  const ext = IMAGE_EXT_BY_MEDIA_TYPE[att.mediaType] || path.extname(safeFilename(att.name)) || '.bin';
  const stored = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const buf = Buffer.from(att.data, 'base64');
  fs.writeFileSync(path.join(UPLOADS_DIR, stored), buf);
  return stored;
}

// Read a stored image back as a base64 image content block for the API.
function loadImageBlock(att) {
  if (!att.file) return null;
  const filePath = path.join(UPLOADS_DIR, att.file);
  if (!fs.existsSync(filePath)) return null;
  const data = fs.readFileSync(filePath).toString('base64');
  return { type: 'image', source: { type: 'base64', media_type: att.mediaType, data } };
}

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

// "sdk"-provider models keep history inside a real Claude Agent SDK session
// (resumed by session_id) instead of a rebuilt messages array — see
// sdkChat(). This file maps modelId -> that model's current sdkSessionId.
function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
}

app.get('/api/transcript', (req, res) => {
  res.json(loadTranscript());
});

app.delete('/api/transcript', (req, res) => {
  saveTranscript([]);
  // Drop every model's SDK session along with the transcript — otherwise a
  // "New" click would clear the visible history but sdk-provider models
  // would keep answering from their still-resumed session.
  saveSessions({});
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
//
// Images from the most recent IMAGE_HISTORY_ROUNDS rounds are re-read from
// disk and attached as real image blocks (so a follow-up question about an
// older photo still works); images older than that fall back to the
// `[Image: name]` text placeholder from attachmentRefs() to bound input
// tokens on long-running conversations.
function buildMessagesFor(model, rounds, userLabel, currentUserText, imageBlocks) {
  const messages = [];
  let pendingUser = [];
  let pendingImages = [];
  const imageWindowStart = rounds.length - IMAGE_HISTORY_ROUNDS;

  rounds.forEach((round, idx) => {
    if (idx >= imageWindowStart) {
      const roundImages = (round.attachments || [])
        .filter(a => a.mediaType?.startsWith('image/') && a.file)
        .map(loadImageBlock)
        .filter(Boolean);
      pendingImages.push(...roundImages);
    }

    const refs = attachmentRefs(round.attachments);
    const userText = `[${userLabel}] ${refs ? refs + '\n' : ''}${round.message || ''}`;
    const siblings = (round.responses || [])
      .filter(r => r.modelId !== model.id && !r.error && r.text)
      .map(r => `[${r.nickname} ${r.emoji}] ${r.text}`);
    pendingUser.push([userText, ...siblings].join('\n\n'));

    const own = (round.responses || [])
      .find(r => r.modelId === model.id && !r.error && r.text);
    if (own) {
      const text = pendingUser.join('\n\n');
      messages.push({
        role: 'user',
        content: pendingImages.length > 0 ? [...pendingImages, { type: 'text', text }] : text,
      });
      messages.push({ role: 'assistant', content: own.text });
      pendingUser = [];
      pendingImages = [];
    }
    // if this model had no text that round, its absence just merges into the next user turn
  });

  pendingUser.push(`[${userLabel}] ${currentUserText}`);
  const finalText = pendingUser.join('\n\n');
  const finalImages = [...pendingImages, ...imageBlocks];
  messages.push({
    role: 'user',
    content: finalImages.length > 0
      ? [...finalImages, { type: 'text', text: finalText }]
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
  const lastRound = savedRounds[savedRounds.length - 1] || null;

  // "sdk"-provider models keep their own history in a real Agent SDK session
  // instead of savedRounds — see sdkChat(). This is that model -> session_id map.
  const sdkSessions = loadSessions();

  // Image attachments become content blocks, shared across all models' final turn
  const imageAttachments = (attachments || []).filter(a => a.mediaType?.startsWith('image/'));
  const imageBlocks = imageAttachments.map(att => ({
    type: 'image',
    source: { type: 'base64', media_type: att.mediaType, data: att.data },
  }));

  // Persist images to disk so they survive a page reload and can be re-sent
  // to models on later rounds (see buildMessagesFor). Stored under a
  // randomized basename — safeFilename() sanitizes the extension only, the
  // stored name itself is never derived from client input.
  const storedImageAttachments = imageAttachments.map(att => ({
    name: att.name,
    mediaType: att.mediaType,
    file: storeImageAttachment(att),
  }));

  await initMcp();
  const sharedMemory = await fetchMemoryKey('shared');
  const memoryByModel = {};
  await Promise.all(activeModels.map(async m => {
    memoryByModel[m.id] = m.memoryKey ? await fetchMemoryKey(m.memoryKey) : null;
  }));
  const writeTools = mcpTools.filter(t => !t.name.includes('read'));

  // Fire all model requests in parallel; each runs its own tool-use loop.
  // Every branch below resolves to { response, sdkSessionId } — sdkSessionId
  // is only set for "sdk"-provider models, and is what lets the post-processing
  // step persist each model's session id for the next round's `resume`.
  const requests = activeModels.map(async model => {
    const systemPrompt = buildSystemPrompt(model, activeModels, userContext, profile, sharedMemory, memoryByModel[model.id]);

    if (model.provider === 'sdk') {
      const siblingPrefix = buildSiblingPrefix(lastRound, model);
      const text = `${siblingPrefix}[${userLabel}] ${augmentedMessage}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300_000);

      try {
        const result = await sdkChat({
          model,
          systemPrompt,
          text,
          imageBlocks,
          sessionId: sdkSessions[model.id],
          abortController: controller,
        });
        clearTimeout(timeout);

        const cleanText = truncateAtForeignLabel(result.text, model, activeModels, userLabel, profile.name);
        const response = cleanText.trim()
          ? {
              modelId: model.id, nickname: model.nickname, emoji: model.emoji, color: model.color,
              provider: 'sdk', text: cleanText,
              inputTokens: result.inputTokens, outputTokens: result.outputTokens, cost: result.costUsd,
              error: null,
            }
          : {
              modelId: model.id, nickname: model.nickname, emoji: model.emoji, color: model.color,
              provider: 'sdk', text: null,
              inputTokens: result.inputTokens, outputTokens: result.outputTokens, cost: result.costUsd,
              error: `${model.nickname} returned no text.`,
            };
        return { response, sdkSessionId: result.sessionId };
      } catch (err) {
        clearTimeout(timeout);
        let errorMsg = err.message || 'Unknown error';
        if (err.name === 'AbortError' || errorMsg.includes('abort')) {
          errorMsg = `${model.nickname} timed out after 300 seconds.`;
        }
        return {
          response: {
            modelId: model.id, nickname: model.nickname, emoji: model.emoji, color: model.color,
            provider: 'sdk', text: null, inputTokens: 0, outputTokens: 0, cost: 0,
            error: errorMsg,
          },
        };
      }
    }

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
      const esc = escapeRegExp(model.nickname);
      text = text.replace(new RegExp(`^\\s*\\[${esc}[^\\]]*\\]:?\\s*`), '');

      const inputTokens  = totalInputTokens;
      const outputTokens = totalOutputTokens;
      const cost = calcCost(model, inputTokens, outputTokens);

      if (!text.trim()) {
        const why = lastStopReason === 'max_tokens'
          ? `${model.nickname} hit the token limit mid-reply and produced no visible text.`
          : `${model.nickname} returned no text (stop_reason: ${lastStopReason}).`;
        return { response: {
          modelId: model.id,
          nickname: model.nickname,
          emoji: model.emoji,
          color: model.color,
          provider: 'api',
          text: null,
          inputTokens,
          outputTokens,
          cost,
          error: why,
        } };
      }

      return { response: {
        modelId: model.id,
        nickname: model.nickname,
        emoji: model.emoji,
        color: model.color,
        provider: 'api',
        text,
        inputTokens,
        outputTokens,
        cost,
        error: null,
      } };
    } catch (err) {
      clearTimeout(timeout);
      let errorMsg = err.message || 'Unknown error';

      // Friendly message for access issues
      if (err.status === 403 || (err.message && err.message.includes('forbidden'))) {
        errorMsg = `${model.nickname} isn't available on your API key yet. Request access at anthropic.com/api`;
      } else if (err.name === 'AbortError' || errorMsg.includes('abort')) {
        errorMsg = `${model.nickname} timed out after 300 seconds.`;
      }

      return { response: {
        modelId: model.id,
        nickname: model.nickname,
        emoji: model.emoji,
        color: model.color,
        provider: 'api',
        text: null,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        error: errorMsg,
      } };
    }
  });

  const results = await Promise.allSettled(requests);
  const responses = [];
  const sessionUpdates = {};
  for (const r of results) {
    if (r.status === 'fulfilled') {
      responses.push(r.value.response);
      if (r.value.sdkSessionId) sessionUpdates[r.value.response.modelId] = r.value.sdkSessionId;
    } else {
      responses.push({
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
    }
  }
  if (Object.keys(sessionUpdates).length > 0) {
    saveSessions({ ...sdkSessions, ...sessionUpdates });
  }

  const totalCost = responses.reduce((sum, r) => sum + (r.cost || 0), 0);
  // Images are saved with their on-disk `file` basename (see storedImageAttachments
  // above) so they render after a reload; other attachments keep the old
  // name/mediaType-only shape — their content was already folded into the
  // message text and doesn't need to persist separately.
  let storedImageIdx = 0;
  const savedAttachments = (attachments || []).map(a =>
    a.mediaType?.startsWith('image/')
      ? storedImageAttachments[storedImageIdx++]
      : { name: a.name, mediaType: a.mediaType }
  );
  const round = {
    message: message || '',
    attachments: savedAttachments,
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
