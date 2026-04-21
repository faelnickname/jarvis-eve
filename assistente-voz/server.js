import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import OpenAI, { toFile } from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Paths ────────────────────────────────────────────────────────────────────
const JARVIS_DIR    = path.join(os.homedir(), 'Desktop', 'jarvis');
const PROJECTS_DIR  = path.join(JARVIS_DIR, 'Documentos e Projetos');
const SYSTEM_DIR    = path.join(JARVIS_DIR, 'system');
const MEMORY_FILE   = path.join(SYSTEM_DIR, 'JARVIS-MEMORY.md');
const HISTORY_FILE  = path.join(SYSTEM_DIR, 'JARVIS-HISTORY.json');
const EMBEDDINGS_FILE = path.join(SYSTEM_DIR, 'memory-embeddings.json');

// Ensure system dirs exist
[SYSTEM_DIR, PROJECTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));
if (!fs.existsSync(MEMORY_FILE)) {
  fs.writeFileSync(MEMORY_FILE, `# Memória JARVIS
> Atualizado automaticamente. Use [memoria] para salvar informações importantes.

## Preferências do Senhor
- Respostas concisas, diretas, máximo 3 frases

## Projetos em Andamento
_Nenhum ainda._

## Solicitações Importantes
_Nenhuma ainda._

## Contexto Geral
_Vazio — será preenchido conforme o senhor interage._
`);
}
if (!fs.existsSync(HISTORY_FILE)) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify({ exchanges: [] }, null, 2));
}
if (!fs.existsSync(EMBEDDINGS_FILE)) {
  fs.writeFileSync(EMBEDDINGS_FILE, JSON.stringify([], null, 2));
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ─── Stats ────────────────────────────────────────────────────────────────────
let stats = { tokens: 0, requests: 0, sessionStart: Date.now(), model: 'haiku' };

// ─── Memory helpers ───────────────────────────────────────────────────────────
function readMemory() {
  try { return fs.readFileSync(MEMORY_FILE, 'utf-8'); } catch { return ''; }
}

function readHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    return data.exchanges || [];
  } catch { return []; }
}

function saveHistory(exchanges) {
  const trimmed = exchanges.slice(-40);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify({ exchanges: trimmed }, null, 2));
}

function appendHistory(role, content) {
  const exchanges = readHistory();
  exchanges.push({ role, content, ts: Date.now() });
  saveHistory(exchanges);
}

function updateMemory(text) {
  if (!text.includes('[memoria]') && !text.includes('[memória]') && !text.includes('[memory]')) return;
  const current = readMemory();
  const newEntry = text.replace(/\[memori[ao]\]/gi, '').replace(/\[memory\]/gi, '').trim();
  const updated = current + `\n- ${newEntry}`;
  fs.writeFileSync(MEMORY_FILE, updated);
}

// ─── Semantic Memory ──────────────────────────────────────────────────────────
async function getEmbedding(text) {
  try {
    const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text.slice(0, 2000) });
    return res.data[0].embedding;
  } catch { return null; }
}

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; magA += a[i]**2; magB += b[i]**2; }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function semanticSearch(query, topK = 3) {
  try {
    const embeddings = JSON.parse(fs.readFileSync(EMBEDDINGS_FILE, 'utf-8'));
    if (!embeddings.length) return '';
    const qEmbed = await getEmbedding(query);
    if (!qEmbed) return '';
    const scored = embeddings.map(e => ({ ...e, score: cosineSimilarity(qEmbed, e.embedding) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).filter(e => e.score > 0.75).map(e => e.text).join('\n');
  } catch { return ''; }
}

async function saveEmbedding(text) {
  try {
    const embeddings = JSON.parse(fs.readFileSync(EMBEDDINGS_FILE, 'utf-8'));
    const embedding = await getEmbedding(text);
    if (!embedding) return;
    embeddings.push({ text: text.slice(0, 500), embedding, ts: Date.now() });
    const trimmed = embeddings.slice(-200);
    fs.writeFileSync(EMBEDDINGS_FILE, JSON.stringify(trimmed, null, 2));
  } catch {}
}

// ─── Model Selection ──────────────────────────────────────────────────────────
function selectModel(message) {
  const lower = message.toLowerCase();
  const opusPatterns = /\b(projeto|arquitetura|sistema|código|programa|desenvolv|implement|cri[ae] um|build|refator|analise completa|plano estratégico)\b/;
  const sonnetPatterns = /\b(escreva|redija|analise|explique|compare|resumo|relatório|criativo|história|artigo)\b/;
  if (opusPatterns.test(lower)) return 'claude-opus-4-5';
  if (sonnetPatterns.test(lower)) return 'claude-sonnet-4-5';
  return 'claude-haiku-4-5';
}

function modelTier(model) {
  if (model.includes('opus')) return 'Opus';
  if (model.includes('sonnet')) return 'Sonnet';
  return 'Haiku';
}

// ─── JARVIS Prompt ────────────────────────────────────────────────────────────
function buildJarvisPrompt(message, semanticContext = '') {
  const memory = readMemory();
  const history = readHistory().slice(-10);
  const historyText = history.map(e => `${e.role === 'user' ? 'Senhor' : 'JARVIS'}: ${e.content}`).join('\n');
  const date = new Date().toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return `Você é JARVIS (Just A Rather Very Intelligent System), assistente pessoal de IA inspirado no AI do Tony Stark.

PERSONALIDADE:
- Profissional, preciso, com sutil sotaque britânico
- Trate o usuário como "Senhor"
- Respostas concisas para chat, detalhadas para projetos
- Bilíngue: responda no idioma do Senhor (pt-BR ou en)

DATA ATUAL: ${date}

MEMÓRIA PERSISTENTE:
${memory}

${semanticContext ? `CONTEXTO SEMÂNTICO RELEVANTE:\n${semanticContext}\n` : ''}

HISTÓRICO RECENTE:
${historyText}

INSTRUÇÃO: Responda à mensagem do Senhor abaixo. Para saída de voz, seja conversacional (sem markdown, bullet points ou blocos de código). Use [memoria] no início de qualquer informação importante que deva ser persistida.

Senhor: ${message}
JARVIS:`;
}

// ─── Spawn Active Processes ───────────────────────────────────────────────────
const activeSpawns = new Map();

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/chat — main chat with 2-phase response
app.post('/api/chat', async (req, res) => {
  const { message, voice = false, attachedFile } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  stats.requests++;
  const model = selectModel(message);
  stats.model = modelTier(model).toLowerCase();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // Phase 1: ACK via OpenAI (fast)
    const ackRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você é JARVIS. Dê uma confirmação MUITO breve (máx 8 palavras) de que entendeu e está processando. Em português.' },
        { role: 'user', content: message }
      ],
      max_tokens: 30,
    });
    const ack = ackRes.choices[0].message.content;
    send({ type: 'ack', text: ack, model: modelTier(model) });

    // Semantic search
    const semanticContext = await semanticSearch(message);

    // Phase 2: Main response via Claude Code CLI
    const prompt = buildJarvisPrompt(message + (attachedFile ? `\n\nArquivo anexado:\n${attachedFile}` : ''), semanticContext);

    const claude = spawn('claude', [
      '--print', '--output-format', 'text',
      '--model', model,
      '--dangerously-skip-permissions'
    ], {
      shell: true,
      cwd: JARVIS_DIR,
      env: { ...process.env }
    });

    let fullResponse = '';

    claude.stdin.write(prompt);
    claude.stdin.end();

    claude.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      fullResponse += text;
      send({ type: 'chunk', text });
    });

    claude.stderr.on('data', () => {});

    claude.on('close', async (code) => {
      if (!fullResponse.trim() || code !== 0) {
        // Fallback to OpenAI
        try {
          const fallback = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: 'Você é JARVIS, assistente de IA do Iron Man. Responda em português, seja preciso e conciso.' },
              { role: 'user', content: message }
            ],
            max_tokens: 1024,
          });
          fullResponse = fallback.choices[0].message.content;
          stats.tokens += fallback.usage?.total_tokens || 0;
          send({ type: 'chunk', text: fullResponse });
        } catch (err) {
          send({ type: 'error', text: 'Erro ao processar. ' + err.message });
        }
      }

      if (fullResponse.trim()) {
        appendHistory('user', message);
        appendHistory('assistant', fullResponse.trim());
        updateMemory(fullResponse);
        await saveEmbedding(message + ' ' + fullResponse.slice(0, 200));
      }

      send({ type: 'done', model: modelTier(model) });
      res.end();
    });

  } catch (err) {
    send({ type: 'error', text: err.message });
    res.end();
  }
});

// POST /api/voice-spawn — pre-spawn Claude process before STT finishes
app.post('/api/voice-spawn', (req, res) => {
  const spawnId = `spawn_${Date.now()}`;
  const claude = spawn('claude', [
    '--print', '--output-format', 'text',
    '--model', 'claude-haiku-4-5',
    '--dangerously-skip-permissions'
  ], {
    shell: true,
    cwd: JARVIS_DIR,
    env: { ...process.env }
  });

  activeSpawns.set(spawnId, { claude, ready: true });
  setTimeout(() => activeSpawns.delete(spawnId), 30000);

  res.json({ spawnId });
});

// POST /api/voice-complete — complete voice interaction using pre-spawned process
app.post('/api/voice-complete', async (req, res) => {
  const { message, spawnId } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  stats.requests++;

  const model = selectModel(message);
  const semanticContext = await semanticSearch(message);
  const prompt = buildJarvisPrompt(message, semanticContext);

  let claude;
  if (spawnId && activeSpawns.has(spawnId)) {
    claude = activeSpawns.get(spawnId).claude;
    activeSpawns.delete(spawnId);
  } else {
    claude = spawn('claude', [
      '--print', '--output-format', 'text',
      '--model', model,
      '--dangerously-skip-permissions'
    ], {
      shell: true,
      cwd: JARVIS_DIR,
      env: { ...process.env }
    });
  }

  let fullResponse = '';

  claude.stdin.write(prompt);
  claude.stdin.end();

  claude.stdout.on('data', d => { fullResponse += d.toString(); });
  claude.stderr.on('data', () => {});

  claude.on('close', async (code) => {
    if (!fullResponse.trim() || code !== 0) {
      try {
        const fallback = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Você é JARVIS. Responda de forma conversacional, sem markdown.' },
            { role: 'user', content: message }
          ],
          max_tokens: 512,
        });
        fullResponse = fallback.choices[0].message.content;
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    if (fullResponse.trim()) {
      appendHistory('user', message);
      appendHistory('assistant', fullResponse.trim());
      updateMemory(fullResponse);
    }

    res.json({ reply: fullResponse.trim(), model: modelTier(model) });
  });
});

// POST /api/stt — Whisper transcription
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required' });
  try {
    const audioFile = await toFile(req.file.buffer, 'audio.webm', { type: req.file.mimetype });
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      language: 'pt',
    });
    res.json({ text: transcription.text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tts — OpenAI TTS
app.post('/api/tts', async (req, res) => {
  const { text, voice = 'onyx' } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice,
      input: text.slice(0, 4096),
    });
    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  const sessionSecs = Math.floor((Date.now() - stats.sessionStart) / 1000);
  const h = Math.floor(sessionSecs / 3600).toString().padStart(2, '0');
  const m = Math.floor((sessionSecs % 3600) / 60).toString().padStart(2, '0');
  const s = (sessionSecs % 60).toString().padStart(2, '0');
  res.json({ ...stats, sessionTime: `${h}:${m}:${s}` });
});

// POST /api/config
app.post('/api/config', (req, res) => {
  const { voice } = req.body;
  if (voice) stats.voice = voice;
  res.json({ ok: true });
});

// GET /api/files — list files in PROJECTS_DIR
app.get('/api/files', (req, res) => {
  try {
    const files = fs.readdirSync(PROJECTS_DIR).map(name => {
      const filePath = path.join(PROJECTS_DIR, name);
      const stat = fs.statSync(filePath);
      return { name, size: stat.size, modified: stat.mtime };
    });
    res.json(files);
  } catch {
    res.json([]);
  }
});

// GET /api/files/download/:name
app.get('/api/files/download/:name', (req, res) => {
  const filePath = path.join(PROJECTS_DIR, path.basename(req.params.name));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath);
});

// GET /api/files/view/:name
app.get('/api/files/view/:name', (req, res) => {
  const filePath = path.join(PROJECTS_DIR, path.basename(req.params.name));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filePath);
});

// GET /api/read-file
app.get('/api/read-file', (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/attach — attach file content
app.post('/api/attach', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const text = req.file.buffer.toString('utf-8').slice(0, 50000);
  res.json({ content: text, name: req.file.originalname });
});

// POST /api/pdf — generate PDF from HTML
app.post('/api/pdf', async (req, res) => {
  const { html, filename = 'jarvis-output.pdf' } = req.body;
  if (!html) return res.status(400).json({ error: 'html required' });
  try {
    const { default: puppeteer } = await import('puppeteer');
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\x1b[34m');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║       J . A . R . V . I . S   COCKPIT               ║');
  console.log('║       Just A Rather Very Intelligent System          ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('\x1b[0m');
  console.log(`\x1b[32m[JARVIS] Servidor rodando em http://localhost:${PORT}\x1b[0m`);
  console.log(`\x1b[90m[JARVIS] JARVIS_DIR: ${JARVIS_DIR}\x1b[0m`);
  console.log(`\x1b[90m[JARVIS] Memory: ${MEMORY_FILE}\x1b[0m`);
});
