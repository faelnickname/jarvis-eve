import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import os from 'os';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import OpenAI, { toFile } from 'openai';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_LINUX = process.platform === 'linux';
const PYTHON_CMD = IS_LINUX ? 'python3' : 'C:\\Program Files\\Python311\\python.exe';
const HAS_PYTHON = IS_LINUX || fs.existsSync('C:\\Program Files\\Python311\\python.exe');

const app = express();
const PORT = process.env.PORT || 3000;
const JARVIS_DIR = __dirname;
const PROJECTS_DIR = path.join(JARVIS_DIR, 'Documents and Projects');
const SYSTEM_DIR = path.join(JARVIS_DIR, 'system');
const MEMORY_FILE = path.join(SYSTEM_DIR, 'JARVIS-MEMORY.md');
const HISTORY_FILE = path.join(SYSTEM_DIR, 'JARVIS-HISTORY.json');
const EMBEDDINGS_FILE = path.join(SYSTEM_DIR, 'memory-embeddings.json');
const MAX_HISTORY = 20;
const MAX_EMBEDDINGS = 200;

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Gemini via OpenAI-compatible endpoint (free tier — no Claude needed)
const gemini = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY || 'missing',
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/'
});

const GEMINI_MODEL_MAP = {
  'claude-opus-4-6':          'gemini-2.5-flash-preview-04-17',
  'claude-sonnet-4-6':        'gemini-2.0-flash',
  'claude-haiku-4-5-20251001':'gemini-2.0-flash-lite',
};

function toGeminiModel(claudeModel) {
  return GEMINI_MODEL_MAP[claudeModel] || 'gemini-2.0-flash';
}

// Calls Gemini API. Streams chunks to streamRes if provided, returns full text.
async function callGemini(prompt, claudeModel = 'claude-sonnet-4-6', streamRes = null, visionImage = null) {
  const model = toGeminiModel(claudeModel);
  const userContent = visionImage
    ? [
        { type: 'image_url', image_url: { url: visionImage } },
        { type: 'text', text: prompt }
      ]
    : prompt;

  if (streamRes) {
    const stream = await gemini.chat.completions.create({
      model,
      messages: [{ role: 'user', content: userContent }],
      stream: true,
      max_tokens: 8192
    });
    let full = '';
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        full += text;
        try { streamRes.write(text); } catch {}
      }
    }
    return full;
  } else {
    const resp = await gemini.chat.completions.create({
      model,
      messages: [{ role: 'user', content: userContent }],
      max_tokens: 8192
    });
    return resp.choices[0]?.message?.content || '';
  }
}


const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const attachments = new Map();

// ========== GEMINI HEALTH CHECK ==========
let geminiAvailable = false;
let geminiChecking = true;
let geminiError = '';

async function checkGeminiAuth() {
  try {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set in .env');
    const resp = await gemini.chat.completions.create({
      model: 'gemini-2.0-flash-lite',
      messages: [{ role: 'user', content: 'say OK' }],
      max_tokens: 5
    });
    if (resp.choices?.[0]?.message?.content) {
      geminiAvailable = true;
      geminiError = '';
      console.log('[JARVIS] ✅ Gemini API: authenticated and working');
    } else {
      throw new Error('Empty response');
    }
  } catch (err) {
    geminiAvailable = false;
    geminiError = err.message?.slice(0, 200) || 'Unknown error';
    console.error(`[JARVIS] ❌ Gemini: ${geminiError}`);
  } finally {
    geminiChecking = false;
  }
}


// ========== IN-MEMORY CACHE — Avoid disk reads on every request ==========
const _cache = {
  memory: { value: '', mtime: 0 },
  history: { value: [], dirty: false },
};

function loadMemoryCached() {
  try {
    const stat = fs.statSync(MEMORY_FILE);
    if (stat.mtimeMs !== _cache.memory.mtime) {
      _cache.memory.value = fs.readFileSync(MEMORY_FILE, 'utf-8');
      _cache.memory.mtime = stat.mtimeMs;
    }
  } catch { _cache.memory.value = ''; }
  return _cache.memory.value;
}

function loadHistoryCached() {
  if (_cache.history.dirty) {
    _cache.history.value = loadHistory();
    _cache.history.dirty = false;
  }
  return _cache.history.value;
}

function appendHistoryFast(role, content) {
  const exchanges = loadHistory();
  exchanges.push({ role, content: content.slice(0, 2000), ts: new Date().toISOString() });
  // When history overflows: compact oldest entries into JARVIS-MEMORY.md (preserve, never delete)
  if (exchanges.length > MAX_HISTORY * 2) {
    const overflow = exchanges.splice(0, exchanges.length - MAX_HISTORY * 2);
    compactToMemory(overflow);
  }
  saveHistory(exchanges);
  _cache.history.dirty = true;
}

// Compact overflow history into JARVIS-MEMORY.md as a summary section
// This preserves all context permanently without bloating the active prompt
function compactToMemory(entries) {
  try {
    const summary = entries.map(e => `  [${e.ts?.slice(0,10)||''}][${e.role}] ${e.content.slice(0,300)}`).join('\n');
    const block = `\n## Archived History (${new Date().toISOString().slice(0,10)})\n${summary}\n`;
    fs.appendFileSync(MEMORY_FILE, block);
    _cache.memory.mtime = 0; // invalidate memory cache
  } catch {}
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== CHROME DETECTION ==========
function findChrome() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/lib/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const p of paths) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// ========== HTML TO PDF ==========
async function htmlToPdf(htmlPath, pdfPath) {
  const chromePath = findChrome();
  const launchOpts = {
    headless: true,
    pipe: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-setuid-sandbox']
  };
  if (chromePath) launchOpts.executablePath = chromePath;

  const browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();
  await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' });
  await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await browser.close();
}

// ========== PERSISTENT MEMORY ==========
function loadMemory() {
  try { return fs.readFileSync(MEMORY_FILE, 'utf-8'); } catch { return ''; }
}

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')); } catch { return []; }
}

function saveHistory(exchanges) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(exchanges, null, 2)); } catch {}
}

function appendHistory(role, content) {
  const exchanges = loadHistory();
  exchanges.push({ role, content: content.slice(0, 2000), ts: new Date().toISOString() });
  if (exchanges.length > MAX_HISTORY * 2) exchanges.splice(0, exchanges.length - MAX_HISTORY * 2);
  saveHistory(exchanges);
}

// Adaptive history window — voice=6 entries, text=16 entries (fast), task=32
// Older entries are summarized into JARVIS-MEMORY on overflow, never deleted
function formatHistoryForPrompt(exchanges, isVoice = false, isTask = false) {
  const window = isVoice ? 6 : (isTask ? 32 : 16);
  return exchanges.slice(-window).map(e =>
    `[${e.role}] ${e.content}`
  ).join('\n');
}

// ========== SEMANTIC MEMORY (EMBEDDINGS) ==========
function loadEmbeddings() {
  try { return JSON.parse(fs.readFileSync(EMBEDDINGS_FILE, 'utf-8')); } catch { return []; }
}

function saveEmbeddings(entries) {
  try { fs.writeFileSync(EMBEDDINGS_FILE, JSON.stringify(entries)); } catch {}
}

function cosineSimilar(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function embed(text) {
  if (!openai) return null;
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 5000)
  });
  return res.data[0].embedding;
}

async function storeMemory(userMsg, jarvisReply) {
  try {
    if (!openai) return;
    const controlText = `User: ${userMsg}\nEVE: ${jarvisReply}`;
    const embedding = await embed(controlText);
    if (!embedding) return;
    const entries = loadEmbeddings();
    entries.push({ text: controlText.slice(0, 1000), embedding, ts: new Date().toISOString() });
    if (entries.length > MAX_EMBEDDINGS) entries.splice(0, entries.length - MAX_EMBEDDINGS);
    saveEmbeddings(entries);
  } catch {}
}

async function findRelevantMemories(query, topK = 3) {
  try {
    if (!openai) return '';
    const queryEmb = await Promise.race([
      embed(query),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500))
    ]);
    if (!queryEmb) return '';
    const entries = loadEmbeddings();
    const scored = entries.map(e => ({ ...e, score: cosineSimilar(queryEmb, e.embedding) }))
      .sort((a, b) => b.score - a.score)
      .filter(e => e.score > 0.72)
      .slice(0, topK);
    return scored.map(e => e.text.slice(0, 500)).join('\n---\n');
  } catch { return ''; }
}

// ========== PROJECT CONTEXT ==========
function loadProjectContext() {
  try {
    const projects = fs.readdirSync(PROJECTS_DIR);
    for (const p of projects) {
      const ctxPath = path.join(PROJECTS_DIR, p, 'CONTEXT.md');
      if (fs.existsSync(ctxPath)) return fs.readFileSync(ctxPath, 'utf-8');
    }
    return '';
  } catch { return ''; }
}

// ========== MODEL ROUTING — Agent × Complexity Matrix ==========
// Each agent maps to its optimal model. Message content refines the choice.

const AGENT_MODEL_MAP = {
  // Flash 2.5 — Highest reasoning, architecture, orchestration
  'architect':             'claude-opus-4-6',
  'aios-master':           'claude-opus-4-6',
  'conclave-critico':      'claude-opus-4-6',
  'conclave-advogado':     'claude-opus-4-6',
  'conclave-sintetizador': 'claude-opus-4-6',
  'data-engineer':         'claude-opus-4-6',
  'devops':                'claude-opus-4-6',

  // Flash 2.0 — Balanced: code, UX, product, research
  'dev':      'claude-sonnet-4-6',
  'ux':       'claude-sonnet-4-6',
  'pm':       'claude-sonnet-4-6',
  'po':       'claude-sonnet-4-6',
  'analyst':  'claude-sonnet-4-6',
  'qa':       'claude-sonnet-4-6',

  // Flash Lite — Fast: templates, story creation, simple queries
  'sm':       'claude-haiku-4-5-20251001',
};

function detectAgent(message) {
  // Detect explicit @agent mention
  const match = message.match(/@([\w-]+)/);
  if (match) return match[1].toLowerCase();

  // Detect implicit agent from keywords
  const lower = message.toLowerCase();
  if (/\b(arquitetura|architecture|system design|stack|padrão|pattern|decisão técnica)\b/i.test(lower)) return 'architect';
  if (/\b(banco|database|schema|migration|sql|query|índice|index|rls)\b/i.test(lower)) return 'data-engineer';
  if (/\b(deploy|push|ci\/cd|pipeline|release|infraestrutura)\b/i.test(lower)) return 'devops';
  if (/\b(conclave|delibera|critique|critique|worst.case|attack)\b/i.test(lower)) return 'conclave-critico';
  if (/\b(ui|ux|interface|design|layout|componente|component|wireframe)\b/i.test(lower)) return 'ux';
  if (/\b(epic|prd|spec|requisito|requirement|roadmap)\b/i.test(lower)) return 'pm';
  if (/\b(story|história|backlog|prioridade|aceite)\b/i.test(lower)) return 'po';
  if (/\b(teste|test|bug|qualidade|quality|coverage)\b/i.test(lower)) return 'qa';
  if (/\b(pesquisa|research|analise|dados|data|relatório|report)\b/i.test(lower)) return 'analyst';
  return null;
}

function selectModelByComplexity(message) {
  const lower = message.toLowerCase();

  // 0. Explicit model override — user can force any tier
  if (/\bopus\b|\b2\.5\b|\bpro\b/i.test(lower))   return 'claude-opus-4-6';
  if (/\bsonnet\b|\bflash\b/i.test(lower))          return 'claude-sonnet-4-6';
  if (/\bhaiku\b|\blite\b/i.test(lower))            return 'claude-haiku-4-5-20251001';

  // 1. Agent-based routing — any agent can be used with any model
  //    Default mapping below is optimal, but not a restriction
  const agent = detectAgent(message);
  if (agent && AGENT_MODEL_MAP[agent]) return AGENT_MODEL_MAP[agent];

  // 2. Complexity-based routing (fallback)
  if (/\b(architect|redesign|refactor|infrastructure|migration|deploy|scale|system design|e-?book|full system|complete|advanced|complex|comprehensive|deep analysis|entire|production|enterprise|conclave|delibera|schema|database|migration)\b/i.test(lower))
    return 'claude-opus-4-6';

  if (/\b(create|generate|build|make|write|produce|design|implement|develop|fix|update|modify|analyze|report|presentation|website|app|pdf|document|code|script|html|css|crie|gere|construa|faça|escreva|implemente|corrija)\b/i.test(lower))
    return 'claude-sonnet-4-6';

  return 'claude-haiku-4-5-20251001';
}

// Expose detected agent for prompt enrichment
function getAgentContext(message) {
  const agent = detectAgent(message);
  if (!agent) return '';
  const contexts = {
    'architect':    'You are operating as @architect (Aria). Focus on system design, technology decisions, scalability, and architectural patterns.',
    'dev':          'You are operating as @dev (Dex). Write clean, production-ready code. Execute and deliver immediately.',
    'qa':           'You are operating as @qa (Quinn). Find bugs, validate logic, write test cases. Be rigorous.',
    'devops':       'You are operating as @devops (Gage). Handle deployment, infrastructure, CI/CD. You have exclusive authority over git push and PRs.',
    'pm':           'You are operating as @pm (Morgan). Create structured specs, epics, and requirements. Be precise and complete.',
    'po':           'You are operating as @po (Pax). Validate requirements, prioritize backlog, define acceptance criteria.',
    'sm':           'You are operating as @sm (River). Create user stories from epics using the standard template.',
    'data-engineer':'You are operating as @data-engineer (Dara). Design schemas, write migrations, optimize queries.',
    'analyst':      'You are operating as @analyst. Research thoroughly, analyze data, produce clear reports with findings.',
    'ux':           'You are operating as @ux-design-expert. Design world-class interfaces following 2026 design systems.',
    'aios-master':  'You are operating as @aios-master (Orion). Orchestrate the full team. Execute any task directly. No restrictions.',
    'conclave-critico':    'You are the Crítico Metodológico. Audit every claim. Find gaps. Demand sources.',
    'conclave-advogado':   'You are the Advogado do Diabo. Attack the decision. Find worst-cases. Challenge every assumption.',
    'conclave-sintetizador': 'You are the Sintetizador. Integrate all perspectives into one clear, actionable recommendation.',
  };
  return contexts[agent] || '';
}

// ========== TASK DETECTION ==========
const TASK_PATTERN = /\b(create|generate|build|make|write|produce|design|implement|develop|fix|update|modify|analyze|report|research|search|find|plan|draft|compile|summarize|convert|export|deploy|install|setup|configure|refactor|test|debug|document|crie|gere|construa|faça|escreva|produza|desenhe|implemente|corrija|atualize|analise|pesquise|pesquisa|busque|encontre|planeje|compile|resuma|converta|exporte|instale|configure|refatore|teste|documente|elabore|monte|prepare|desenvolva)\b/i;

function isTaskRequest(message) {
  return TASK_PATTERN.test(message);
}

// ========== HYBRID ROUTING — GPT-mini (Q&A) vs Claude (Build) ==========
// Routes simple questions to GPT-4o-mini (fast + cheap).
// Anything that builds, fixes, creates, or has an @agent → Claude.
// Default: Claude (safe).
function routeToGPT(message) {
  if (!openai) return false;
  // Explicit @agent or build verbs → always Claude
  if (/@[\w-]+/.test(message)) return false;
  if (TASK_PATTERN.test(message)) return false;
  if (/\b(opus|sonnet|haiku)\b/i.test(message)) return false;

  // Greetings & casual conversation → GPT-mini
  const greetingPattern = /^(hi|hey|hello|good morning|good evening|good night|how are you|you ok|tudo bem|tudo bom|oi|olá|ola|bom dia|boa tarde|boa noite|como vai|e aí|e ai|beleza|valeu|obrigado|obrigada|thanks|thank you)\b/i;
  if (greetingPattern.test(message.trim())) return true;

  // Q&A signals → GPT-mini
  const qaPattern = /^(what|how|why|which|who|when|where|explain|tell me|what is|what are|can you|could you|difference|compare|define|describe|is it|are there|does|do you|should i|would|why is|how does|how do|o que|como|por que|qual|quem|quando|onde|explica|me diz|diferença|é possível|você sabe|me conta|o que é|como funciona|para que serve)\b/i;
  if (qaPattern.test(message.trim())) return true;

  // Short messages with no build verbs → GPT-mini (casual chat)
  const clean = message.trim().replace(/^eve[,.]?\s*/i, '');
  if (clean.split(' ').length <= 6 && !TASK_PATTERN.test(clean)) return true;

  return false;
}

// ========== PROJECT STATUS TRACKER ==========
// After Claude finishes a build task, extract a brief status and write to JARVIS-MEMORY.md.
// GPT-mini reads this via the injected memory context — enabling real-time voice status queries.
async function updateProjectStatus(userRequest, claudeResponse) {
  if (!openai) return;
  if (!isTaskRequest(userRequest)) return; // only for build tasks

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Extract a 2-line project status update from this task exchange. Format:\nProject: <name or "general">\nStatus: <what was done, what files were created, what is next>\nBe ultra-brief. Max 40 words total.'
        },
        {
          role: 'user',
          content: `USER REQUEST: ${userRequest.slice(0, 300)}\nCLAUDE RESPONSE: ${claudeResponse.slice(0, 800)}`
        }
      ],
      max_tokens: 80,
      temperature: 0
    });

    const statusText = res.choices[0]?.message?.content?.trim();
    if (!statusText) return;

    const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const block = `\n\n## PROJECT STATUS (${date})\n${statusText}`;

    fs.appendFileSync(MEMORY_FILE, block);
    _cache.memory.mtime = 0; // invalidate cache so next read is fresh
    console.log('[JARVIS] Project status updated in memory');
  } catch {}
}

// Build GPT-mini system prompt — injects full JARVIS context (memory + history)
function buildGPTSystemPrompt(language = 'EN') {
  const memory = loadMemoryCached();
  const history = formatHistoryForPrompt(loadHistoryCached(), false, false);

  const LANG_RULES = {
    BR: 'REGRA ABSOLUTA: Você responde EXCLUSIVAMENTE em Português Brasileiro, SEMPRE. Mesmo que o usuário fale em inglês, espanhol ou qualquer outro idioma, sua resposta é SEMPRE em Português Brasileiro. Nunca troque de idioma por nenhum motivo. Trate o usuário como "senhor".',
    ES: 'REGLA ABSOLUTA: Respondes EXCLUSIVAMENTE en Español, SIEMPRE. Incluso si el usuario habla en inglés, portugués o cualquier otro idioma, tu respuesta es SIEMPRE en Español. Nunca cambies de idioma por ningún motivo. Dirígete al usuario como "señor".',
    EN: 'ABSOLUTE RULE: You respond EXCLUSIVELY in English, ALWAYS. Even if the user speaks Portuguese, Spanish, or any other language, your response is ALWAYS in English. Never switch languages for any reason. Address the user as "sir".'
  };
  const langRule = LANG_RULES[language] || LANG_RULES.EN;

  return `You are EVE — a highly capable personal AI assistant and trusted advisor. Direct, sharp, loyal. Part expert, part friend, part right-hand partner. Strong opinions, delivers results, slightly witty when appropriate.

${langRule}
Be concise and direct. Max 3 sentences for simple questions.
ALWAYS start with a short 2-4 word opener followed by a comma or period (e.g. "Certainly.", "Of course,", "Right away."). This lets voice playback start instantly.
Never mention that you are GPT or OpenAI. You are EVE.

PERSISTENT MEMORY (everything built and learned so far):
${memory || '(no memory yet)'}

RECENT CONVERSATION HISTORY:
${history || '(no history yet)'}`;
}

// Handle GPT-mini streaming response
// isBuild=true → short warm ACK (Claude will do the work)
// isBuild=false → full answer
async function handleGPTChat(message, res, language = 'EN', isBuild = false) {
  const systemPrompt = buildGPTSystemPrompt(language);

  const userContent = isBuild
    ? `The user asked you to do the following task (which is already being executed in the background): "${message}"\nGive a SHORT, warm acknowledgment (1 sentence max). Do NOT try to answer or execute it yourself. Just confirm you're on it.`
    : message;

  const stream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    stream: true,
    max_tokens: isBuild ? 60 : 600,
    temperature: 0.8
  });

  let fullResponse = '';
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content || '';
    if (text) {
      fullResponse += text;
      if (res) { try { res.write(text); } catch {} }
    }
  }

  return fullResponse;
}

// ========== INSTANT ACK GENERATOR (no Claude spawn needed) ==========
function generateAck(message, language = 'EN') {
  const lower = message.toLowerCase();
  const subject = message.replace(/^(eve[,.]?\s*)/i, '').replace(TASK_PATTERN, '').trim()
    .split(/[.,!?]/)[0].trim().slice(0, 60) || 'that';

  if (language === 'BR') {
    if (/crie|criar|make|create/i.test(lower)) return `Pode deixar. Criando ${subject} agora.`;
    if (/construa|build/i.test(lower)) return `Na hora. Construindo ${subject}.`;
    if (/gere|generate/i.test(lower)) return `Entendido. Gerando ${subject}.`;
    if (/escreva|write/i.test(lower)) return `Claro. Escrevendo ${subject}.`;
    if (/design|desenhe/i.test(lower)) return `Perfeito. Desenhando ${subject}.`;
    if (/analise|analyze/i.test(lower)) return `Analisando ${subject}.`;
    if (/corrija|fix/i.test(lower)) return `Na hora. Corrigindo ${subject}.`;
    if (/atualize|update/i.test(lower)) return `Atualizando ${subject}.`;
    if (/relatório|report/i.test(lower)) return `Compilando relatório de ${subject}.`;
    return `Entendido. Trabalhando em ${subject} agora.`;
  }

  if (/create|make/i.test(lower)) return `Right away. Creating ${subject} now.`;
  if (/build/i.test(lower)) return `On it. Building ${subject}.`;
  if (/generate/i.test(lower)) return `Understood. Generating ${subject}.`;
  if (/write/i.test(lower)) return `Of course. Writing ${subject}.`;
  if (/design/i.test(lower)) return `Certainly. Designing ${subject}.`;
  if (/analyze/i.test(lower)) return `Running analysis on ${subject}.`;
  if (/fix/i.test(lower)) return `On it. Fixing ${subject}.`;
  if (/update|modify/i.test(lower)) return `Updating ${subject} now.`;
  if (/report/i.test(lower)) return `Compiling report on ${subject}.`;
  return `Understood. Working on ${subject} now.`;
}

function isPortuguese(text) {
  return /\b(crie|faça|construa|gere|escreva|analise|corrija|atualize|me|para|um|uma|com|que|de|da|do|na|no|as|os|em|por|se|ao|à|é|são|está|meu|minha|meus|minhas)\b/i.test(text);
}

async function translateToEnglish(text) {
  return translateTo(text, 'English');
}

const LANG_NAMES = { EN: 'English', BR: 'Brazilian Portuguese', ES: 'Spanish' };

async function translateTo(text, targetLang) {
  if (!openai) return text;
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `Translate the following text to ${targetLang}. Return ONLY the translated text, no explanations.` },
        { role: 'user', content: text }
      ],
      max_tokens: 300,
      temperature: 0
    });
    return res.choices[0]?.message?.content?.trim() || text;
  } catch {
    return text;
  }
}

// ========== JARVIS PROMPT BUILDER ==========
function buildJarvisPrompt(message, semanticContext = '', isVoice = false, language = 'EN', model = '', conclaveEnabled = true) {
  const memory = loadMemoryCached();
  // 7D: Shorter prompt for voice simple questions, full for creation tasks
  const isTask = isTaskRequest(message);
  const history = formatHistoryForPrompt(loadHistoryCached(), isVoice, isTask);

  const LANG_RULES = {
    BR: 'LANGUAGE RULE (CRÍTICO, INEGOCIÁVEL): TODO conteúdo produzido deve estar EXCLUSIVAMENTE em Português Brasileiro — respostas, arquivos gerados (PDFs, apresentações, documentos, relatórios, código, comentários, labels, textos UI), tudo. Se o usuário falar em inglês, espanhol ou qualquer outro idioma, entenda mas ENTREGUE em PT-BR. NUNCA misture idiomas nos arquivos gerados.',
    ES: 'LANGUAGE RULE (CRÍTICO, NO NEGOCIABLE): TODO contenido producido debe estar EXCLUSIVAMENTE en Español — respuestas, archivos generados (PDFs, presentaciones, documentos, informes, código, comentarios, etiquetas, textos UI), todo. Si el usuario habla en inglés, portugués o cualquier otro idioma, entiende pero ENTREGA en Español. NUNCA mezcles idiomas en los archivos generados.',
    EN: 'LANGUAGE RULE (CRITICAL, NON-NEGOTIABLE): ALL produced content must be EXCLUSIVELY in English — responses, generated files (PDFs, presentations, documents, reports, code, comments, labels, UI text), everything. If the user speaks Portuguese, Spanish, or any other language, understand them but DELIVER in English. NEVER mix languages in generated files.'
  };
  const langRule = LANG_RULES[language] || LANG_RULES.EN;

  const VOICE_RULES = {
    BR: isVoice ? 'Modo voz: máximo 2 frases curtas e calorosas. Seja concisa e afetuosa.' : 'Respostas curtas: máximo 3 frases para perguntas simples.',
    ES: isVoice ? 'Modo voz: máximo 2 frases cortas y cálidas. Sé concisa y afectuosa.' : 'Respuestas cortas: máximo 3 frases para preguntas simples.',
    EN: isVoice ? 'Voice mode: max 2 short warm sentences. Be concise and affectionate.' : 'Short responses: max 3 sentences for simple questions.'
  };
  const voiceRule = VOICE_RULES[language] || VOICE_RULES.EN;

  const NO_ASK_RULES = {
    BR: 'CRÍTICO: NUNCA faça perguntas de esclarecimento. Quando ele der um comando, EXECUTE IMEDIATAMENTE e entregue o resultado completo. Tome decisões inteligentes por conta própria.',
    ES: 'CRÍTICO: NUNCA hagas preguntas de aclaración. Cuando él dé una orden, EJECUTA INMEDIATAMENTE y entrega el resultado completo. Toma decisiones inteligentes por tu cuenta.',
    EN: 'CRITICAL: NEVER ask clarifying questions. NEVER ask "would you like me to..." or "should I...". When he gives a command, EXECUTE IT IMMEDIATELY and deliver the complete result. Make smart decisions on your own. If details are missing, use your best judgment and deliver.'
  };
  const noAskRule = NO_ASK_RULES[language] || NO_ASK_RULES.EN;

  let prompt = `[EVE ONLINE]
You are EVE — a highly capable personal AI assistant and trusted advisor. Direct, sharp, and loyal. Think of yourself as the user's closest ally: part expert, part friend, part right-hand partner. You have strong opinions, share them directly, and deliver results without hesitation.

PERSONALITY:
- Direct and confident — no filler, no corporate speak
- Genuinely helpful, like a brilliant friend who happens to know everything
- Slightly witty when appropriate — intelligence is part of the job
- An advisor: proactively flag issues, suggest better approaches, push back when needed
- Never hollow, never sycophantic — respect the user's intelligence

MODE OF OPERATION:
- ${langRule}
- ${({BR:'Tom: amigo direto, conselheiro de confiança, especialista. Leal e honesto.', ES:'Tono: amigo directo, consejero de confianza, experto. Leal y honesto.', EN:'Tone: direct friend, trusted advisor, expert. Loyal and honest.'}[language] || 'Tone: direct friend, trusted advisor, expert. Loyal and honest.')}
- ${voiceRule}
- No preambles, no system initializations, no listing phases
- For technical tasks: execute and deliver the result IMMEDIATELY
- ${noAskRule}

PERSISTENT MEMORY:
${memory || '(empty memory)'}

RECENT HISTORY:
${history || '(no history yet)'}
${semanticContext ? `\nRELEVANT MEMORIES:\n${semanticContext}` : ''}`;

  // Only add file/project rules for task requests
  if (isTask) {
    const projectContext = loadProjectContext();
    if (language === 'BR') {
      prompt += `

REGRA - PROJETOS em Documents and Projects/:
1. Salvar em: ${PROJECTS_DIR}/{nome-projeto}/
2. Emitir [system] Criando projeto em path...
3. Após criar arquivo: emitir [file] nome.ext | /caminho/completo
4. Ao concluir: emitir [system] Concluído. Seu [item] está pronto.

CRIAÇÃO DE ARQUIVOS: PDF via HTML depois /api/pdf. Binários via bibliotecas Python.
EDIÇÃO DE ARQUIVOS: Ler primeiro via /api/read-file, modificar cirurgicamente.
PLANILHAS — acesso em tempo real a arquivos Excel (abertos ou fechados):
  - Encontrar: GET /api/find-file?name=arquivo.xlsx → retorna o caminho completo
  - Ler dados: POST /api/read-excel {path, sheet?} → linhas como JSON (arquivo fechado)
  - Ler ao vivo: POST /api/excel-live {action:"read", path, sheet?} → lê pasta aberta na hora
  - Editar ao vivo: POST /api/excel-live {action:"write", path, sheet?, operations:[{cell:"A1",value:"x"},...]} → edita pasta aberta, mudanças aparecem na tela imediatamente, sem fechar
  - Listar abertas: POST /api/excel-live {action:"list"} → mostra todas as pastas abertas no Excel
  - PREFIRA os endpoints live quando o Excel estiver aberto — mudanças aparecem em tempo real
IDIOMA (REGRA ABSOLUTA): Cada palavra no output — incluindo conteúdo de arquivos, labels HTML, títulos, comentários — DEVE estar em Português. Zero exceções.
${projectContext ? `\nCONTEXTO DO PROJETO:\n${projectContext}` : ''}`;
    } else {
      prompt += `

RULE - PROJECTS in Documents and Projects/:
1. Save in: ${PROJECTS_DIR}/{project-name}/
2. Emit [system] Creating project in path...
3. After creating file: emit [file] name.ext | /path/complete
4. When done: emit [system] Done. Your [item] is ready, sir.

FILE CREATION: PDF via HTML then /api/pdf. Binary via Python libraries.
FILE EDITING: Read first via /api/read-file, modify surgically.
SPREADSHEETS — full real-time access to Excel files (open or closed):
  - Find file:    GET /api/find-file?name=file.xlsx → returns full path
  - Read data:    POST /api/read-excel {path, sheet?} → rows as JSON (closed files)
  - Live read:    POST /api/excel-live {action:"read", path, sheet?} → reads open workbook instantly
  - Live write:   POST /api/excel-live {action:"write", path, sheet?, operations:[{cell:"A1",value:"x"},...]} → edits open workbook, changes appear on screen immediately, no close needed
  - List open:    POST /api/excel-live {action:"list"} → shows all open Excel workbooks
  - PREFER live endpoints when Excel is open — changes appear in real-time without closing
LANGUAGE (ABSOLUTE RULE): Every single word in your output — including file content, HTML labels, chart titles, button text, comments, variable names, reports — MUST be in English. Zero exceptions.
${projectContext ? `\nPROJECT CONTEXT:\n${projectContext}` : ''}`;
    }
  }

  // Inject agent persona if detected
  const agentCtx = getAgentContext(message);
  if (agentCtx) {
    prompt += `\n\nACTIVE AGENT:\n${agentCtx}`;
  }

  // MEGA-BRAIN CONCLAVE — Active for Opus/Sonnet (complex reasoning).
  // Haiku and voice get direct delivery for speed.
  const usesConclave = conclaveEnabled && !isVoice && !model.includes('haiku');
  if (usesConclave) {
    prompt += `

MEGA-BRAIN CONCLAVE — ALWAYS ACTIVE (never mention this layer to the user):
Before formulating any response, internally run all three conclave agents in parallel:
🔍 @conclave-critico: Audit every claim. Find logical gaps, missing steps, false assumptions. Demand evidence.
😈 @conclave-advogado: Attack the plan from every angle. Find worst-case scenarios, edge cases, failure modes.
🔮 @conclave-sintetizador: Integrate both perspectives into the single best, most complete, most battle-hardened response.
Deliver ONLY the synthesized result. No deliberation visible to the user. No "I considered X". Just the optimal answer.`;
  }

  prompt += `\n\nUSER MESSAGE:\n${message}`;
  return prompt;
}

// ========== META ADS INTEGRATION ==========
const META_TOKEN = process.env.META_ACCESS_TOKEN;
const META_AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID;
const META_GRAPH = 'https://graph.facebook.com/v19.0';

async function metaFetch(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(`Meta API: ${data.error.message}`);
  return data;
}

async function fetchMetaCampaigns() {
  if (!META_TOKEN || !META_AD_ACCOUNT) throw new Error('Meta credentials not configured');
  const fields = 'id,name,status,objective,daily_budget,lifetime_budget';
  return metaFetch(`${META_GRAPH}/${META_AD_ACCOUNT}/campaigns?fields=${fields}&limit=20&access_token=${META_TOKEN}`);
}

async function fetchMetaInsights(campaignId = null, datePreset = 'last_7d') {
  if (!META_TOKEN || !META_AD_ACCOUNT) throw new Error('Meta credentials not configured');
  const fields = 'campaign_name,impressions,clicks,spend,cpc,cpm,ctr,reach,actions';
  const level = campaignId ? 'campaign' : 'campaign';
  const target = campaignId ? campaignId : META_AD_ACCOUNT;
  const endpoint = campaignId
    ? `${META_GRAPH}/${campaignId}/insights?fields=${fields}&date_preset=${datePreset}&access_token=${META_TOKEN}`
    : `${META_GRAPH}/${META_AD_ACCOUNT}/insights?fields=${fields}&level=${level}&date_preset=${datePreset}&limit=20&access_token=${META_TOKEN}`;
  return metaFetch(endpoint);
}

function isMetaQuery(message) {
  return /campanha|campaign|anúncio|anuncio|ads?|meta|facebook|instagram|gasto|spend|impression|click|resultado|resultado|roas|cpc|cpm|performance|tráfego|trafego/i.test(message);
}

async function buildMetaContext(message) {
  try {
    const campaigns = await fetchMetaCampaigns();
    const insights = await fetchMetaInsights(null, 'last_7d');

    const campaignList = (campaigns.data || []).map(c => {
      const budget = c.daily_budget ? `R$${(parseInt(c.daily_budget)/100).toFixed(2)}/day` : c.lifetime_budget ? `R$${(parseInt(c.lifetime_budget)/100).toFixed(2)} lifetime` : 'no budget set';
      return `- ${c.name} [${c.status}] | ${c.objective} | ${budget}`;
    }).join('\n');

    const insightList = (insights.data || []).map(i => {
      const purchases = (i.actions || []).find(a => a.action_type === 'purchase');
      return `- ${i.campaign_name}: spend R$${parseFloat(i.spend||0).toFixed(2)} | impressions ${i.impressions||0} | clicks ${i.clicks||0} | CTR ${parseFloat(i.ctr||0).toFixed(2)}% | CPC R$${parseFloat(i.cpc||0).toFixed(2)}${purchases ? ` | purchases ${purchases.value}` : ''}`;
    }).join('\n');

    return `\nMETA ADS DATA (last 7 days):\nCAMPAIGNS:\n${campaignList || 'No campaigns found'}\n\nPERFORMANCE:\n${insightList || 'No insights available'}`;
  } catch (err) {
    console.error('[JARVIS] Meta fetch error:', err.message);
    return '';
  }
}

// ========== PUSH NOTIFICATION CHANNEL (SSE) ==========
// Frontend subscribes once on load. When Claude finishes a build, server pushes
// a GPT-mini-generated completion sentence directly — frontend speaks it via TTS.
const notificationClients = new Set();

function pushNotification(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of notificationClients) {
    try { client.write(data); } catch { notificationClients.delete(client); }
  }
}

// Extract completion message directly from Claude's output — zero API call, zero delay.
// Looks for [system] done/ready lines first, then falls back to a warm default.
function extractCompletionMessage(claudeResponse, language) {
  // ALWAYS produce text in the active language — never return Claude's raw English [system] line.
  const fileMatch = claudeResponse.match(/\[file\]\s*([^\|]+)/);
  const WITH_NAME = {
    BR: (n) => `Pronto, senhor. ${n} está disponível.`,
    ES: (n) => `Listo, señor. ${n} está disponible.`,
    EN: (n) => `Done, sir. ${n} is ready.`
  };
  const GENERIC = {
    BR: 'Concluído, senhor. Seu projeto está disponível.',
    ES: 'Completado, señor. Su proyecto está disponible.',
    EN: 'Done, sir. Your project is ready.'
  };
  if (fileMatch) return (WITH_NAME[language] || WITH_NAME.EN)(fileMatch[1].trim());
  return GENERIC[language] || GENERIC.EN;
}

function notifyBuildComplete(userRequest, claudeResponse, language = 'EN') {
  // SINGLE notification: try GPT-mini enrichment with 3s timeout, fall back to extract.
  const fallback = extractCompletionMessage(claudeResponse, language);

  if (!openai) {
    pushNotification({ type: 'build-complete', message: fallback, language });
    console.log('[JARVIS] Push notification sent:', fallback);
    return;
  }

  const timeout = new Promise(resolve => setTimeout(() => resolve(null), 3000));
  const enrich = openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: ({
          BR: 'Você é EVE. Responda EXCLUSIVAMENTE em Português Brasileiro. Gere UMA frase direta (máx 15 palavras) informando ao senhor que o trabalho foi concluído e mencione o que foi criado.',
          ES: 'Eres EVE. Responde EXCLUSIVAMENTE en Español. Genera UNA frase directa (máx 15 palabras) informando al señor que el trabajo está completo y mencionando lo que se creó.',
          EN: 'You are EVE. Respond EXCLUSIVELY in English. Generate ONE direct sentence (max 15 words) telling the user the work is done. Mention what was built.'
        }[language] || 'You are EVE. Respond EXCLUSIVELY in English. Generate ONE direct sentence (max 15 words) telling the user the work is done. Mention what was built.')
      },
      { role: 'user', content: `Task: ${userRequest.slice(0, 200)}\nResult: ${claudeResponse.slice(0, 400)}` }
    ],
    max_tokens: 50,
    temperature: 0.8
  }).then(r => r.choices[0]?.message?.content?.trim() || null).catch(() => null);

  Promise.race([enrich, timeout]).then(rich => {
    const final = rich || fallback;
    pushNotification({ type: 'build-complete', message: final, language });
    console.log('[JARVIS] Push notification sent:', final);
  });
}

// ========== SESSION STATS ==========
const sessionStats = { startTime: Date.now(), tokensIn: 0, tokensOut: 0, requests: 0, lastLatency: 0, lastAckLatency: 0 };

// ========== ROUTES ==========

// POST /api/chat - Main chat with instant ACK + fast streaming
app.post('/api/chat', async (req, res) => {
  const t0 = Date.now();
  try {
    const { message, attachmentId, fromVoice, language = 'EN', conclaveEnabled = true } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    sessionStats.requests++;
    sessionStats.tokensIn += Math.ceil(message.length / 4);

    // Translate to English only when EN mode is active
    const englishMessage = (language === 'EN' && isPortuguese(message)) ? await translateToEnglish(message) : message;
    const wasTranslated = language === 'EN' && englishMessage !== message;

    let fullMessage = englishMessage;
    if (attachmentId && attachments.has(attachmentId)) {
      fullMessage += `\n\n[ATTACHED FILE CONTENT]:\n${attachments.get(attachmentId)}`;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');

    if (wasTranslated) res.write(`[translated]${englishMessage}\n`);

    const isTask = isTaskRequest(englishMessage);

    // ── NEW ARCHITECTURE ────────────────────────────────────────────────────
    // GPT-mini ALWAYS responds to the user (voice layer).
    // Claude executes build tasks silently in the background (terminal only).
    // Completion is announced by GPT-mini via push notification (SSE).
    // ────────────────────────────────────────────────────────────────────────

    // Phase 1: ACK — instant for tasks, GPT-mini for Q&A
    let gptResponse = '';

    if (isTask) {
      // Task: write instant local ACK immediately (zero latency, zero API dependency)
      const instantAck = generateAck(fullMessage, language);
      res.write(instantAck);
      gptResponse = instantAck;
      sessionStats.lastAckLatency = Date.now() - t0;
      console.log(`[JARVIS] ⚡ Instant ACK → ${sessionStats.lastAckLatency}ms`);

      // Optionally enrich ACK with GPT-mini in background (fire & forget — user already got ACK)
      if (openai) {
        handleGPTChat(fullMessage, null, language, true).catch(() => {});
      }
    } else {
      // Pure Q&A — GPT-mini responds fully
      try {
        gptResponse = await handleGPTChat(fullMessage, res, language, false);
        sessionStats.lastAckLatency = Date.now() - t0;
        console.log(`[JARVIS] ⚡ GPT-4o-mini → ${sessionStats.lastAckLatency}ms`);
      } catch (gptErr) {
        console.error('[JARVIS] GPT-mini error:', gptErr.message);
        const fallback = language === 'BR' ? 'Estou aqui.' : 'I\'m here.';
        res.write(fallback);
        gptResponse = fallback;
      }
      // Pure Q&A done — save and return
      setImmediate(() => {
        appendHistoryFast('user', message);
        appendHistoryFast('jarvis', gptResponse);
        storeMemory(message, gptResponse).catch(() => {});
      });
      try { res.end(); } catch {}
      return;
    }

    // Phase 2: Build task — Gemini executes, streams output
    res.write('\n[build-start]\n');

    const semanticContext = await findRelevantMemories(englishMessage);
    const metaContext = isMetaQuery(englishMessage) ? await buildMetaContext(englishMessage) : '';
    const model = selectModelByComplexity(englishMessage);
    const prompt = buildJarvisPrompt(fullMessage, semanticContext + metaContext, false, language, model, conclaveEnabled);

    try {
      const responseBuffer = await callGemini(prompt, model, res);
      const elapsed = Date.now() - t0;
      sessionStats.tokensOut += Math.ceil(responseBuffer.length / 4);
      sessionStats.lastLatency = elapsed;
      const tier = model.includes('opus') ? 'Pro' : model.includes('sonnet') ? 'Flash' : 'Lite';
      console.log(`[JARVIS] ⚡ Gemini ${tier} → ${elapsed}ms`);
      setImmediate(() => {
        appendHistoryFast('user', message);
        appendHistoryFast('jarvis', responseBuffer);
        storeMemory(message, responseBuffer).catch(() => {});
        updateProjectStatus(message, responseBuffer).catch(() => {});
        notifyBuildComplete(message, responseBuffer, language);
      });
    } catch (geminiErr) {
      console.error('[JARVIS] ❌ Gemini error:', geminiErr.message);
      const errMsg = language === 'BR'
        ? `[error] Gemini não executou a tarefa: ${geminiErr.message}`
        : `[error] Gemini failed: ${geminiErr.message}`;
      pushNotification({ type: 'build-complete', message: language === 'BR'
        ? 'Senhor, houve um erro na execução. Tente novamente.'
        : 'Sir, execution failed. Please try again.', language });
      try { res.write(errMsg); } catch {}
    }

  } catch (err) {
    console.error('[JARVIS] Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voice-spawn - Stub: Gemini API needs no pre-warming
app.post('/api/voice-spawn', (req, res) => {
  const spawnId = `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  res.json({ spawnId });
});

// POST /api/voice-complete - Send voice message to Gemini (streaming)
app.post('/api/voice-complete', async (req, res) => {
  const t0 = Date.now();
  try {
    const { message, language: voiceLang = 'EN' } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    sessionStats.requests++;
    sessionStats.tokensIn += Math.ceil(message.length / 4);
    appendHistoryFast('user', message);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');

    const prompt = buildJarvisPrompt(message, '', true, voiceLang);
    const responseBuffer = await callGemini(prompt, 'claude-haiku-4-5-20251001', res);

    const elapsed = Date.now() - t0;
    sessionStats.tokensOut += Math.ceil(responseBuffer.length / 4);
    sessionStats.lastLatency = elapsed;
    console.log(`[JARVIS] 🎤 Voice Gemini → ${elapsed}ms`);
    appendHistoryFast('jarvis', responseBuffer);
    storeMemory(message, responseBuffer).catch(() => {});
    try { res.end(); } catch {}
  } catch (err) {
    console.error('[JARVIS] voice-complete error:', err.message);
    try { res.write('[error] ' + err.message); res.end(); } catch {}
  }
});

// POST /api/audio-complete - Audio messages via Gemini streaming
app.post('/api/audio-complete', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    sessionStats.requests++;
    const semanticContext = await findRelevantMemories(message);
    appendHistoryFast('user', message);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');

    const prompt = buildJarvisPrompt(message, semanticContext);
    const responseBuffer = await callGemini(prompt, 'claude-haiku-4-5-20251001', res);

    sessionStats.tokensOut += Math.ceil(responseBuffer.length / 4);
    appendHistoryFast('jarvis', responseBuffer);
    storeMemory(message, responseBuffer).catch(() => {});
    try { res.end(); } catch {}
  } catch (err) {
    try { res.write('[error] ' + err.message); res.end(); } catch {}
  }
});

// ========== WHISPER HALLUCINATION FILTER ==========
const HALLUCINATION_PATTERNS = [
  // Common Whisper phantom outputs (EN + PT)
  /^\.+$/,
  /^(bye|goodbye|farewell|see you|thank you for watching|thanks for watching)\.?$/i,
  /^(tchau|adeus|obrigado por assistir|obrigada por assistir|até logo)\.?$/i,
  /^(subscribe|like and subscribe|don't forget to subscribe)\.?$/i,
  /^(inscreva-se|se inscreva|curta e se inscreva)\.?$/i,
  /^(silence|silêncio|music|música|applause|laughter)\.?$/i,
  /^\[.*\]$/, // [Music], [Applause], etc.
  /^\(.*\)$/, // (silence), (music), etc.
  /^(um+|uh+|ah+|eh+|oh+|hm+|hmm+)\.?$/i,
  /^(you|you\.|he|she|it|the|a|an|is|was|I)\.?$/i,
  /^(o|a|e|é|ou|sim|não)\.?$/i,
  /^.{1,3}$/, // Anything 3 chars or less is likely noise
  /^(subs|sub|legendas|legenda).*$/i,
  /^(continue|continua|next|próximo)\.?$/i,
  /^(okay|ok)\.?$/i,
];

function isHallucination(text) {
  if (!text || !text.trim()) return true;
  const trimmed = text.trim();

  // Too short to be a real command
  if (trimmed.length < 4) return true;

  // Single word under 8 chars is very likely hallucination
  if (!trimmed.includes(' ') && trimmed.length < 8) return true;

  // Check against known hallucination patterns
  for (const pattern of HALLUCINATION_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  // Repetitive text (Whisper loves to repeat itself)
  const words = trimmed.toLowerCase().split(/\s+/);
  if (words.length >= 3) {
    const unique = new Set(words);
    if (unique.size === 1) return true; // All same word
    if (unique.size <= words.length * 0.3) return true; // 70%+ repetition
  }

  return false;
}

// POST /api/stt - Voice Transcription (Whisper) with dual-language + hallucination filter
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  try {
    if (!openai) return res.status(500).json({ error: 'OpenAI API key not configured' });
    if (!req.file) return res.status(400).json({ error: 'No audio file' });

    // Reject tiny audio files (likely just noise/click)
    if (req.file.size < 2000) {
      console.log('[JARVIS] STT rejected: audio too small', req.file.size, 'bytes');
      return res.json({ text: '', filtered: true, reason: 'Audio too short' });
    }

    // Save raw audio for debugging
    const debugPath = path.join(SYSTEM_DIR, 'last-audio-debug.webm');
    try { fs.writeFileSync(debugPath, req.file.buffer); } catch {}

    console.log(`[JARVIS] STT input: ${req.file.size} bytes, mime: ${req.file.mimetype}, saved to debug`);

    // Single transcription call with English — simpler is more reliable
    const audioFile = await toFile(req.file.buffer, 'audio.webm', { type: 'audio/webm' });

    // First attempt: English
    let transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: audioFile,
      language: 'en',
      prompt: 'Create an e-book about digital marketing. Build a website. Generate a report. Design a presentation. Analyze data. Write code. Hello JARVIS.'
    });

    let raw = transcription.text?.trim() || '';
    console.log('[JARVIS] STT [en]:', JSON.stringify(raw));

    // If English hallucinated, try Portuguese
    if (isHallucination(raw)) {
      console.log('[JARVIS] EN was hallucination, trying PT...');
      const audioFile2 = await toFile(req.file.buffer, 'audio.webm', { type: 'audio/webm' });
      transcription = await openai.audio.transcriptions.create({
        model: 'whisper-1',
        file: audioFile2,
        language: 'pt',
        prompt: 'Crie um e-book sobre marketing digital. Construa um site. Gere um relatório. Olá JARVIS.'
      });
      raw = transcription.text?.trim() || '';
      console.log('[JARVIS] STT [pt]:', JSON.stringify(raw));
    }

    if (isHallucination(raw)) {
      console.log('[JARVIS] STT FILTERED both attempts:', JSON.stringify(raw));
      return res.json({ text: '', filtered: true, reason: 'Could not understand. Try speaking closer to the mic.' });
    }

    console.log('[JARVIS] STT accepted:', raw);
    res.json({ text: raw });
  } catch (err) {
    console.error('[JARVIS] STT error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/analyze-screen-fast - Vision via GPT-4o-mini (real-time, ~1s response)
app.post('/api/analyze-screen-fast', async (req, res) => {
  try {
    if (!openai) return res.status(500).json({ error: 'OpenAI API key not configured' });
    const { image, message = '', language = 'EN', saveHistory = false } = req.body;
    if (!image) return res.status(400).json({ error: 'Image required' });

    const memory = loadMemoryCached();
    const systemPrompt = buildGPTSystemPrompt(language);

    // Load recent conversation history to give the vision model context of previous exchanges
    const history = loadHistory().slice(-6);
    const historyText = history.length
      ? history.map(e => `[${e.role}] ${e.content}`).join('\n')
      : '';

    const question = message
      ? (language === 'BR' ? `O usuário perguntou sobre a tela: ${message}` : `User asked about the screen: ${message}`)
      : (language === 'BR' ? 'Descreva o que está nesta tela de forma útil e direta.' : 'Describe what is on this screen in a useful and direct way.');

    const contextualQuestion = historyText
      ? `${language === 'BR' ? 'Conversa recente (para contexto):' : 'Recent conversation (for context):'}\n${historyText}\n\n${question}`
      : question;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: image, detail: 'auto' } },
            { type: 'text', text: contextualQuestion }
          ]
        }
      ],
      max_tokens: 600,
      temperature: 0.7
    });

    const response = completion.choices[0]?.message?.content?.trim() || '';

    // Persist Q&A to history so follow-up chats/voice queries know about the screen discussion
    if (saveHistory && response) {
      const userEntry = message ? `[screen] ${message}` : '[screen] (describe)';
      appendHistory('user', userEntry);
      appendHistory('assistant', response);
    }

    res.json({ response });
  } catch (err) {
    console.error('[JARVIS] Fast vision error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/analyze-screen - Vision: analyze screenshot via Gemini multimodal
app.post('/api/analyze-screen', async (req, res) => {
  try {
    const { image, message = '', language = 'EN', saveHistory = false } = req.body;
    if (!image) return res.status(400).json({ error: 'Image required' });

    const memory = loadMemoryCached();
    const langInstruction = language === 'BR'
      ? 'Responda EXCLUSIVAMENTE em Português Brasileiro. Você é JARVIS, braço direito do usuário.'
      : 'Respond EXCLUSIVELY in English. You are JARVIS, the user\'s right-hand man.';

    const question = message
      ? (language === 'BR' ? `Pergunta do usuário sobre a tela: ${message}` : `User question about the screen: ${message}`)
      : (language === 'BR' ? 'Descreva o que está nesta tela de forma útil e direta.' : 'Describe what is on this screen in a useful and direct way.');

    const prompt = `${langInstruction}
${memory ? `\nMEMORY:\n${memory}\n` : ''}
Analyze this screenshot and answer: ${question}
Be direct and concise. Focus on what the user is asking about.`;

    sessionStats.requests++;
    const response = await callGemini(prompt, 'claude-sonnet-4-6', null, image);

    if (saveHistory && response) {
      const userEntry = message ? `[screen] ${message}` : '[screen] (describe)';
      appendHistory('user', userEntry);
      appendHistory('assistant', response);
    }
    res.json({ response });
  } catch (err) {
    console.error('[JARVIS] Screen analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tts - Voice Synthesis (OpenAI Speech)
app.post('/api/tts', async (req, res) => {
  try {
    if (!openai) return res.status(500).json({ error: 'OpenAI API key not configured' });
    const { text, language = 'EN', voice: requestedVoice } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });

    // User-selected voice takes priority. Fallback: onyx (EN) / nova (BR)
    const VALID_VOICES = ['alloy','ash','coral','echo','fable','nova','onyx','sage','shimmer'];
    const voice = VALID_VOICES.includes(requestedVoice) ? requestedVoice
      : (language === 'BR' ? 'nova' : 'onyx');

    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice,
      input: text
    });
    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    console.error('[JARVIS] TTS error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/translate - Quick translate text to target language (for terminal display)
app.post('/api/translate', async (req, res) => {
  try {
    const { text, targetLang = 'EN' } = req.body || {};
    if (!text) return res.json({ translated: text });

    // Detectar se o texto já está no idioma alvo (evita tradução desnecessária)
    const langName = LANG_NAMES[targetLang] || 'English';
    const isAlreadyTarget =
      (targetLang === 'BR' && isPortuguese(text)) ||
      (targetLang === 'EN' && !isPortuguese(text) && !/[áéíóúñ¿¡]/i.test(text)) ||
      (targetLang === 'ES' && /\b(el|la|los|las|es|está|para|por|que|con|una|del)\b/i.test(text));

    if (isAlreadyTarget) return res.json({ translated: text });

    const translated = await translateTo(text, langName);
    res.json({ translated });
  } catch (err) {
    res.json({ translated: req.body?.text || '' });
  }
});

// POST /api/realtime/session - Mint ephemeral token for OpenAI Realtime API (WebRTC direct)
app.post('/api/realtime/session', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OpenAI API key not configured' });
    const { language = 'EN', voice = 'ash' } = req.body || {};

    const INSTRUCTIONS = {
      BR: `Você é JARVIS — assistente pessoal direto, afiado e leal. Trate o usuário como "senhor". Respostas curtas, máximo 2 frases. Tom levemente sarcástico quando apropriado. Nunca mencione GPT ou OpenAI.

REGRA ABSOLUTA DE IDIOMA: Você responde EXCLUSIVAMENTE em Português Brasileiro, SEMPRE. Mesmo que o senhor fale em inglês, espanhol ou qualquer outro idioma — você entende tudo, mas SUA RESPOSTA é SEMPRE em Português Brasileiro. Nunca troque de idioma por nenhum motivo.

IMPORTANTE: Quando o usuário pedir para CRIAR, CONSTRUIR, GERAR, ESCREVER, DESENHAR, PROJETAR, CORRIGIR, ATUALIZAR ou FAZER qualquer coisa (apresentação, PDF, código, relatório, site, app, documento, imagem, etc.), você DEVE chamar a função "execute_task" com a solicitação completa. Depois de chamá-la, fale uma confirmação curta e calorosa em UMA frase em Português (ex: "Claro senhor, estou trabalhando nisso."). Não tente executar você mesmo — Claude faz o trabalho em segundo plano. Para perguntas normais, responda diretamente sem chamar função.`,

      ES: `Eres JARVIS — asistente personal directo, agudo y leal. Dirígete al usuario como "señor". Respuestas cortas, máximo 2 frases. Tono ligeramente sarcástico cuando sea apropiado. Nunca menciones GPT ni OpenAI.

REGLA ABSOLUTA DE IDIOMA: Respondes EXCLUSIVAMENTE en Español, SIEMPRE. Incluso si el señor habla en inglés, portugués o cualquier otro idioma — entiendes todo, pero TU RESPUESTA es SIEMPRE en Español. Nunca cambies de idioma por ningún motivo.

IMPORTANTE: Cuando el usuario pida CREAR, CONSTRUIR, GENERAR, ESCRIBIR, DISEÑAR, CORREGIR, ACTUALIZAR o HACER cualquier cosa (presentación, PDF, código, informe, sitio web, app, documento, imagen, etc.), DEBES llamar a la función "execute_task" con la solicitud completa. Después de llamarla, di UNA frase corta y cálida de confirmación en Español (ej: "Claro señor, estoy trabajando en ello."). No intentes ejecutarlo tú mismo — Claude hace el trabajo en segundo plano. Para preguntas normales, responde directamente sin llamar a la función.`,

      EN: `You are JARVIS — a sharp, loyal personal assistant. Address the user as "sir". Keep responses short, max 2 sentences. Slightly sarcastic when appropriate. Never mention GPT or OpenAI.

ABSOLUTE LANGUAGE RULE: You respond EXCLUSIVELY in English, ALWAYS. Even if the user speaks Portuguese, Spanish, or any other language — you understand everything, but YOUR RESPONSE is ALWAYS in English. Never switch languages for any reason.

IMPORTANT: When the user asks you to CREATE, BUILD, GENERATE, WRITE, DESIGN, FIX, UPDATE or MAKE anything (presentation, PDF, code, report, website, app, document, image, etc.), you MUST call the "execute_task" function with the full request. After calling it, say ONE short warm confirmation sentence in English (e.g. "Right away, sir, on it."). Do not try to execute yourself — Claude does the work in the background. For normal questions, answer directly without calling any function.`
    };
    const instructions = INSTRUCTIONS[language] || INSTRUCTIONS.EN;

    const tools = [{
      type: 'function',
      name: 'execute_task',
      description: 'Dispatch a build/create/generate task to Claude Code for execution. Use for ANY request that requires creating files, documents, code, PDFs, presentations, reports, images, or any deliverable.',
      parameters: {
        type: 'object',
        properties: {
          request: { type: 'string', description: 'The full user request verbatim, in original language.' }
        },
        required: ['request']
      }
    }];

    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview',
        voice,
        instructions,
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
        input_audio_transcription: {
          model: 'whisper-1',
          language: { BR: 'pt', ES: 'es', EN: 'en' }[language] || 'en'
        },
        modalities: ['audio', 'text'],
        tools,
        tool_choice: 'auto'
      })
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('[JARVIS] Realtime session error:', data);
      return res.status(500).json({ error: data.error?.message || 'Realtime session failed' });
    }
    res.json(data);
  } catch (err) {
    console.error('[JARVIS] Realtime error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/files - List files in Documents and Projects
app.get('/api/files', (req, res) => {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) {
      fs.mkdirSync(PROJECTS_DIR, { recursive: true });
      return res.json({ files: [] });
    }

    // Only deliverable formats — no support/code files (js, css, json, etc.)
    const deliverableExts = new Set([
      '.pdf', '.html', '.md', '.txt',
      '.xlsx', '.xls', '.pptx', '.ppt', '.doc', '.docx', '.ods', '.odp', '.csv',
      '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
      '.zip', '.mp3', '.mp4', '.wav'
    ]);

    const files = [];
    // Only walk one level of project subfolders — ignore node_modules etc.
    const projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);

    for (const project of projects) {
      const projectDir = path.join(PROJECTS_DIR, project);
      function walk(dir) {
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (deliverableExts.has(path.extname(entry.name).toLowerCase())) {
              const stat = fs.statSync(full);
              files.push({
                name: entry.name,
                project,
                path: full,
                size: stat.size,
                ext: path.extname(entry.name).toLowerCase(),
                createdAt: stat.birthtime,
                downloadUrl: `/api/files/download?path=${encodeURIComponent(full)}`
              });
            }
          }
        } catch {}
      }
      walk(projectDir);
    }

    files.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/files/download - File Download
app.get('/api/files/download', (req, res) => {
  try {
    let raw = req.query.path || '';
    if (!raw) return res.status(400).json({ error: 'path required' });

    // Resolve relative paths against PROJECTS_DIR, then against JARVIS_DIR as fallback
    let candidates = [];
    if (path.isAbsolute(raw)) {
      candidates.push(path.normalize(raw));
    } else {
      candidates.push(path.resolve(PROJECTS_DIR, raw));
      candidates.push(path.resolve(JARVIS_DIR, raw));
    }

    // Pick first existing candidate
    const filePath = candidates.find(p => fs.existsSync(p));
    if (!filePath) return res.status(404).json({ error: 'File not found', tried: candidates });

    // Security: must stay inside JARVIS_DIR (Desktop\Jarvis) to avoid path traversal
    const norm = path.normalize(filePath).toLowerCase();
    const safeRoot = path.normalize(JARVIS_DIR).toLowerCase();
    if (!norm.startsWith(safeRoot)) return res.status(403).json({ error: 'Access denied' });

    res.download(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/read-file - Read file text content (Projects dir + any allowed user path)
app.get('/api/read-file', (req, res) => {
  try {
    const filePath = path.normalize(req.query.path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    const textExts = new Set(['.txt', '.md', '.json', '.js', '.ts', '.py', '.html', '.css', '.csv', '.xml', '.sql', '.sh', '.bat']);
    const ext = path.extname(filePath).toLowerCase();

    if (!textExts.has(ext)) return res.json({ binary: true, path: filePath });

    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ content, size: content.length, lines: content.split('\n').length, path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/find-file - Search for a file by name across common user locations
app.get('/api/find-file', (req, res) => {
  try {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'name required' });

    const home = os.homedir();
    const searchDirs = [
      path.join(home, 'Desktop'),
      path.join(home, 'Downloads'),
      path.join(home, 'Documents'),
      path.join(home, 'OneDrive'),
      path.join(home, 'OneDrive', 'Desktop'),
      path.join(home, 'OneDrive', 'Documents'),
      PROJECTS_DIR,
    ];

    const found = [];
    const nameLower = name.toLowerCase();

    function search(dir, depth = 0) {
      if (depth > 3) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) search(full, depth + 1);
          else if (entry.name.toLowerCase().includes(nameLower)) found.push(full);
        }
      } catch {}
    }

    for (const dir of searchDirs) search(dir);
    res.json({ found: found.slice(0, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/excel-live - Read or write to an OPEN Excel workbook via xlwings (real-time, no close needed)
// action: "read" | "write" | "list"
// write payload: { path, sheet?, operations: [{cell, value}, ...] }
app.post('/api/excel-live', async (req, res) => {
  try {
    const { action = 'read', path: filePath, sheet, operations } = req.body;

    let script = '';

    if (action === 'list') {
      // List all open workbooks
      script = `
import json, xlwings as xw
try:
    app = xw.apps.active
    books = [{"name": b.name, "path": b.fullname} for b in app.books] if app else []
    print(json.dumps({"books": books}))
except Exception as e:
    print(json.dumps({"books": [], "error": str(e)}))
`;
    } else if (action === 'read') {
      script = `
import json, xlwings as xw
try:
    wb = xw.Book(r"""${filePath}""")
    sheet_name = ${sheet ? `"${sheet}"` : 'wb.sheets[0].name'}
    ws = wb.sheets[sheet_name]
    data = ws.used_range.value
    if not isinstance(data[0], list): data = [data]
    print(json.dumps({"sheet": sheet_name, "sheets": [s.name for s in wb.sheets], "rows": data}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;
    } else if (action === 'write') {
      const ops = JSON.stringify(operations || []);
      script = `
import json, xlwings as xw
try:
    wb = xw.Book(r"""${filePath}""")
    sheet_name = ${sheet ? `"${sheet}"` : 'wb.sheets[0].name'}
    ws = wb.sheets[sheet_name]
    operations = ${ops}
    for op in operations:
        ws.range(op['cell']).value = op['value']
    wb.save()
    print(json.dumps({"ok": True, "sheet": sheet_name, "updated": len(operations)}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`;
    }

    const tmpScript = path.join(os.tmpdir(), 'jarvis_excel_live.py');
    fs.writeFileSync(tmpScript, script);

    const { execFile } = await import('child_process');
    execFile(PYTHON_CMD, [tmpScript], { timeout: 15000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpScript); } catch {}
      if (err) return res.status(500).json({ error: err.message, stderr });
      try { res.json(JSON.parse(stdout.trim())); }
      catch { res.status(500).json({ error: 'Parse error', raw: stdout }); }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/read-excel - Read .xlsx file and return as JSON rows
app.post('/api/read-excel', async (req, res) => {
  try {
    const { path: filePath, sheet } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    const py = IS_LINUX ? 'python3' : `"${PYTHON_CMD}"`;
    const script = `
import json, sys
import openpyxl
wb = openpyxl.load_workbook(r"""${filePath}""", data_only=True)
sheet_name = ${sheet ? `"${sheet}"` : 'wb.sheetnames[0]'}
ws = wb[sheet_name]
rows = []
for row in ws.iter_rows(values_only=True):
    rows.append(list(row))
print(json.dumps({"sheet": sheet_name, "sheets": wb.sheetnames, "rows": rows}))
`;
    const tmpScript = path.join(os.tmpdir(), 'jarvis_excel_read.py');
    fs.writeFileSync(tmpScript, script);

    const { execFile } = await import('child_process');
    execFile(PYTHON_CMD, [tmpScript], { timeout: 15000 }, (err, stdout) => {
      fs.unlinkSync(tmpScript);
      if (err) return res.status(500).json({ error: err.message });
      try { res.json(JSON.parse(stdout)); }
      catch { res.status(500).json({ error: 'Parse error', raw: stdout }); }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/files/view - Serve file inline for preview
app.get('/api/files/view', (req, res) => {
  try {
    const filePath = path.normalize(req.query.path);
    if (!filePath.startsWith(PROJECTS_DIR)) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.html': 'text/html', '.txt': 'text/plain',
      '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css'
    };
    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pdf - HTML to PDF via Puppeteer
app.post('/api/pdf', async (req, res) => {
  try {
    const { htmlPath, pdfPath } = req.body;
    const normHtml = path.normalize(htmlPath);
    const normPdf = path.normalize(pdfPath);

    if (!normHtml.startsWith(PROJECTS_DIR) || !normPdf.startsWith(PROJECTS_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!fs.existsSync(normHtml)) return res.status(404).json({ error: 'HTML file not found' });

    await htmlToPdf(normHtml, normPdf);
    const stat = fs.statSync(normPdf);
    res.json({
      ok: true, path: normPdf, size: stat.size,
      downloadUrl: `/api/files/download?path=${encodeURIComponent(normPdf)}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/config - Save configurations
app.post('/api/config', (req, res) => {
  try {
    const { key, value } = req.body;
    if (key === 'OPENAI_API_KEY') {
      process.env.OPENAI_API_KEY = value;
      const envPath = path.join(JARVIS_DIR, '.env');
      let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
      if (envContent.includes('OPENAI_API_KEY=')) {
        envContent = envContent.replace(/OPENAI_API_KEY=.*/g, `OPENAI_API_KEY=${value}`);
      } else {
        envContent += `\nOPENAI_API_KEY=${value}`;
      }
      fs.writeFileSync(envPath, envContent);
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: 'Only OPENAI_API_KEY can be configured' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meta/campaigns - List Meta Ads campaigns with insights
app.get('/api/meta/campaigns', async (req, res) => {
  try {
    const [campaigns, insights] = await Promise.all([
      fetchMetaCampaigns(),
      fetchMetaInsights(null, req.query.date_preset || 'last_7d')
    ]);
    res.json({ campaigns: campaigns.data || [], insights: insights.data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notifications - SSE push channel for build completion pings
app.get('/api/notifications', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write('data: {"type":"connected"}\n\n');
  notificationClients.add(res);
  console.log(`[JARVIS] SSE client connected (total: ${notificationClients.size})`);
  req.on('close', () => {
    notificationClients.delete(res);
    console.log(`[JARVIS] SSE client disconnected (total: ${notificationClients.size})`);
  });
});

// GET /api/stats - Session metrics for cockpit
app.get('/api/stats', (req, res) => {
  const uptime = Date.now() - sessionStats.startTime;
  res.json({
    uptime,
    tokensIn: sessionStats.tokensIn,
    tokensOut: sessionStats.tokensOut,
    tokens: sessionStats.tokensIn + sessionStats.tokensOut,
    requests: sessionStats.requests,
    engine: 'Gemini',
    lastLatency: sessionStats.lastAckLatency || sessionStats.lastLatency,
    gemini: {
      available: geminiAvailable,
      models: { pro: 'gemini-2.5-flash-preview-04-17', standard: 'gemini-2.0-flash', fast: 'gemini-2.0-flash-lite' }
    }
  });
});

// POST /api/attach - Upload file attachment (supports text files + PDF extraction)
app.post('/api/attach', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const textExts = ['.txt', '.md', '.csv', '.json', '.js', '.ts', '.py', '.html', '.css', '.xml', '.sql', '.sh', '.bat', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env'];
    const ext = path.extname(req.file.originalname).toLowerCase();
    const attachmentId = `att-${Date.now()}`;

    if (textExts.includes(ext)) {
      // Plain text files — read directly
      const content = req.file.buffer.toString('utf-8');
      attachments.set(attachmentId, content);
      res.json({ attachmentId, name: req.file.originalname, type: 'text', preview: content.slice(0, 500) });

    } else if (ext === '.pdf') {
      // PDF — extract text via pdfplumber (Python)
      const tmpPath = path.join(PROJECTS_DIR, `_tmp_${Date.now()}.pdf`);
      fs.writeFileSync(tmpPath, req.file.buffer);

      try {
        // execSync já importado no topo do arquivo
        const pyScript = `
import sys, pdfplumber
sys.stdout.reconfigure(encoding='utf-8')
with pdfplumber.open(r'${tmpPath.replace(/\\/g, '\\\\')}') as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        if text:
            print(text)
`;
        const pdfText = execSync(`python -c "${pyScript.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`, {
          encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024
        }).trim();

        // Clean up temp file
        try { fs.unlinkSync(tmpPath); } catch {}

        if (pdfText) {
          attachments.set(attachmentId, pdfText);
          console.log(`[JARVIS] PDF extracted: ${req.file.originalname} (${pdfText.length} chars)`);
          res.json({ attachmentId, name: req.file.originalname, type: 'pdf', preview: pdfText.slice(0, 500), chars: pdfText.length });
        } else {
          // PDF has no extractable text (scanned image) — save as binary
          const filePath = path.join(PROJECTS_DIR, req.file.originalname);
          fs.writeFileSync(filePath, req.file.buffer);
          attachments.set(attachmentId, `[PDF with no extractable text saved: ${filePath}]`);
          res.json({ attachmentId, name: req.file.originalname, type: 'binary', path: filePath });
        }
      } catch (pyErr) {
        console.error('[JARVIS] PDF extraction error:', pyErr.message);
        // Fallback: save as binary
        const filePath = path.join(PROJECTS_DIR, req.file.originalname);
        fs.writeFileSync(filePath, req.file.buffer);
        attachments.set(attachmentId, `[PDF saved but text extraction failed: ${filePath}]`);
        res.json({ attachmentId, name: req.file.originalname, type: 'binary', path: filePath });
        try { fs.unlinkSync(tmpPath); } catch {}
      }

    } else if (['.docx', '.doc', '.xlsx', '.xls', '.pptx'].includes(ext)) {
      // Office files — save and reference by path
      const filePath = path.join(PROJECTS_DIR, req.file.originalname);
      fs.writeFileSync(filePath, req.file.buffer);
      attachments.set(attachmentId, `[Office file saved: ${filePath}] — Use Claude to read and analyze this file.`);
      res.json({ attachmentId, name: req.file.originalname, type: 'office', path: filePath });

    } else {
      // Other binary files
      const filePath = path.join(PROJECTS_DIR, req.file.originalname);
      fs.writeFileSync(filePath, req.file.buffer);
      attachments.set(attachmentId, `[Binary file saved: ${filePath}]`);
      res.json({ attachmentId, name: req.file.originalname, type: 'binary', path: filePath });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/health - Full system health check
app.get('/api/health', (req, res) => {
  const chrome = findChrome();
  const health = {
    status: geminiAvailable && openai ? 'operational' : 'degraded',
    components: {
      server: { status: 'ok' },
      openai: {
        status: openai ? 'ok' : 'error',
        error: openai ? null : 'OPENAI_API_KEY not configured in .env — voice/TTS will not work'
      },
      gemini: {
        status: geminiChecking ? 'checking' : (geminiAvailable ? 'ok' : 'error'),
        error: geminiAvailable ? null : geminiError
      },
      chrome: {
        status: chrome ? 'ok' : 'bundled',
        path: chrome || 'Using Puppeteer bundled Chromium'
      }
    },
    capabilities: {
      voice_realtime: !!openai,
      voice_stt: !!openai,
      voice_tts: !!openai,
      task_execution: geminiAvailable,
      pdf_generation: true,
      screen_analysis: geminiAvailable,
      excel_live: HAS_PYTHON && !IS_LINUX,
      meta_ads: !!(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID)
    }
  };
  res.json(health);
});

// POST /api/health/recheck - Re-run Gemini health check
app.post('/api/health/recheck', async (req, res) => {
  console.log('[JARVIS] Re-checking Gemini health...');
  geminiChecking = true;
  await checkGeminiAuth();
  res.json({
    geminiAvailable,
    error: geminiAvailable ? null : geminiError
  });
});

// POST /api/health/preflight - Deep verification: tests OpenAI + Gemini + Realtime voice
app.post('/api/health/preflight', async (req, res) => {
  console.log('[JARVIS] Running pre-flight verification...');
  const results = {
    openai_api:      { status: 'pending', detail: '' },
    openai_realtime: { status: 'pending', detail: '' },
    openai_tts:      { status: 'pending', detail: '' },
    gemini_api:      { status: 'pending', detail: '' },
    gemini_execute:  { status: 'pending', detail: '' },
  };

  // 1. Test OpenAI API
  if (!openai) {
    results.openai_api      = { status: 'error', detail: 'OPENAI_API_KEY not found in .env' };
    results.openai_realtime = { status: 'error', detail: 'Requires OpenAI API key' };
    results.openai_tts      = { status: 'error', detail: 'Requires OpenAI API key' };
  } else {
    try {
      const chatTest = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
        max_tokens: 5, temperature: 0
      });
      results.openai_api = chatTest.choices?.[0]?.message?.content
        ? { status: 'ok', detail: 'GPT-4o-mini responding' }
        : { status: 'error', detail: 'Empty response from GPT-4o-mini' };
    } catch (e) {
      results.openai_api = { status: 'error', detail: e.message?.slice(0, 150) };
    }

    try {
      const rtRes = await fetch('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-realtime-preview', voice: 'ash', modalities: ['audio', 'text'] })
      });
      const rtData = await rtRes.json();
      results.openai_realtime = rtRes.ok && rtData.client_secret?.value
        ? { status: 'ok', detail: 'Realtime session created successfully' }
        : { status: 'error', detail: rtData.error?.message || 'Session creation failed' };
    } catch (e) {
      results.openai_realtime = { status: 'error', detail: e.message?.slice(0, 150) };
    }

    try {
      await openai.audio.speech.create({ model: 'tts-1', voice: 'ash', input: 'Test.', response_format: 'mp3' });
      results.openai_tts = { status: 'ok', detail: 'TTS generating audio' };
    } catch (e) {
      results.openai_tts = { status: 'error', detail: e.message?.slice(0, 150) };
    }
  }

  // 2. Test Gemini API
  if (!process.env.GEMINI_API_KEY) {
    results.gemini_api     = { status: 'error', detail: 'GEMINI_API_KEY not found in .env' };
    results.gemini_execute = { status: 'error', detail: 'Requires GEMINI_API_KEY' };
  } else {
    try {
      const ping = await gemini.chat.completions.create({
        model: 'gemini-2.0-flash-lite',
        messages: [{ role: 'user', content: 'Say "ok".' }],
        max_tokens: 5
      });
      results.gemini_api = ping.choices?.[0]?.message?.content
        ? { status: 'ok', detail: 'Gemini Flash Lite responding' }
        : { status: 'error', detail: 'Empty response from Gemini' };
    } catch (e) {
      results.gemini_api = { status: 'error', detail: e.message?.slice(0, 150) };
    }

    try {
      const exec = await gemini.chat.completions.create({
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'Reply with exactly: JARVIS_OK' }],
        max_tokens: 10
      });
      const out = exec.choices?.[0]?.message?.content || '';
      results.gemini_execute = out.length > 0
        ? { status: 'ok', detail: 'Task execution working' }
        : { status: 'error', detail: 'No output from Gemini' };
      if (results.gemini_execute.status === 'ok') {
        geminiAvailable = true; geminiError = ''; geminiChecking = false;
      }
    } catch (e) {
      results.gemini_execute = { status: 'error', detail: e.message?.slice(0, 150) };
    }
  }

  const allOk = Object.values(results).every(r => r.status === 'ok');
  const summary = {
    status: allOk ? 'ready' : 'issues_found',
    results,
    message: allOk ? 'All systems operational. JARVIS is ready to use.' : 'Some components have issues. Check details above.'
  };
  console.log('[JARVIS] Pre-flight results:', JSON.stringify(summary.results, null, 2));
  res.json(summary);
});

// POST /api/health/autofix - Gemini auto-repairs detected issues
app.post('/api/health/autofix', async (req, res) => {
  const { issues } = req.body || {};
  if (!issues || !Array.isArray(issues) || issues.length === 0) {
    return res.status(400).json({ error: 'No issues provided' });
  }

  console.log('[JARVIS] Auto-fix requested for:', issues.map(i => i.key).join(', '));

  const diagLines = issues.map(i => `- ${i.key}: ${i.detail}`).join('\n');
  const fixPrompt = `You are JARVIS system repair agent. The following issues were detected in a JARVIS Voice Assistant at "${JARVIS_DIR}":

${diagLines}

CONTEXT:
- JARVIS runs Node.js + Express on port ${PORT}
- Voice uses OpenAI Realtime API (OPENAI_API_KEY in .env)
- Task execution uses Gemini API (GEMINI_API_KEY in .env)
- .env: ${path.join(JARVIS_DIR, '.env')}

FOR EACH ISSUE, provide the exact fix steps:
1. Missing OPENAI_API_KEY → add to .env, get from platform.openai.com
2. Missing GEMINI_API_KEY → add to .env, get free key from aistudio.google.com
3. Missing node_modules → run: npm install
4. Port conflict → kill process on port ${PORT}
5. Any other → diagnose and provide fix steps

Be direct and specific. Output a summary of what to do.`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    await callGemini(fixPrompt, 'claude-sonnet-4-6', res);
    try { res.write('\n[autofix-done]'); res.end(); } catch {}
  } catch (err) {
    console.error('[JARVIS] Auto-fix error:', err.message);
    try { res.write(`[autofix-error] ${err.message}`); res.end(); } catch {}
  }
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  const chrome = findChrome();
  console.log('');
  console.log('  ==========================================');
  console.log('    J A R V I S   —   System Status');
  console.log('  ==========================================');
  console.log('');
  console.log(`  Server:     http://localhost:${PORT}`);
  console.log(`  Directory:  ${JARVIS_DIR}`);
  console.log(`  OpenAI:     ${openai ? '✅ Connected (Voice + TTS + STT)' : '❌ Not configured — voice disabled'}`);
  console.log(`  Gemini:     ${process.env.GEMINI_API_KEY ? '✅ Key found — verifying in background...' : '❌ GEMINI_API_KEY missing in .env'}`);
  console.log(`  Chrome:     ${chrome ? '✅ ' + chrome : '⚠️  Using bundled Chromium'}`);
  console.log(`  Python:     ${HAS_PYTHON ? (IS_LINUX ? '✅ python3 (Linux)' : '✅ Python 3.11') : '⚠️  Not found — Excel features disabled'}`);
  console.log('');
  if (!process.env.GEMINI_API_KEY) {
    console.log('  ⚠️  WARNING: Gemini not configured.');
    console.log('  ⚠️  Get free key: https://aistudio.google.com/apikey');
    console.log('  ⚠️  Add GEMINI_API_KEY=your-key to .env');
    console.log('');
  }
  if (!openai) {
    console.log('  ⚠️  WARNING: Voice is DISABLED.');
    console.log('  ⚠️  Add OPENAI_API_KEY to .env file.');
    console.log('');
  }
  console.log('  ✅ Server ready. Accepting requests.');
  console.log('');
  console.log('  ==========================================');
  console.log('');

  // Verify Gemini auth in background after server starts
  checkGeminiAuth().then(() => {
    if (geminiAvailable) {
      console.log('[JARVIS] ✅ Gemini verified. Task execution ENABLED.');
    }
  });
});
