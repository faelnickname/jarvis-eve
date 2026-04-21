/**
 * J.A.R.V.I.S — Just A Rather Very Intelligent System
 * Powered by OpenAI (GPT-4 + Whisper + TTS)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync, exec } = require('child_process');
const OpenAI = require('openai');

// ─── Configuration ────────────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('\x1b[31m[EVE] ERROR: OPENAI_API_KEY not set. Please check your .env file.\x1b[0m');
  process.exit(1);
}

const VOICE        = 'nova';       // alloy | echo | fable | onyx | nova | shimmer
const TTS_MODEL    = 'tts-1';
const AI_MODEL     = 'gpt-4o-mini';
const AUDIO_DIR    = path.join(__dirname, 'audio');
const HISTORY_FILE = path.join(__dirname, 'conversation_history.json');

if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);

// ─── Client ───────────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─── Conversation History ─────────────────────────────────────────────────────
let conversationHistory = [];

function loadHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      conversationHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      console.log(`\x1b[90m[EVE] ${conversationHistory.length} messages restored from memory.\x1b[0m`);
    } catch { conversationHistory = []; }
  }
}

function saveHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(conversationHistory.slice(-100), null, 2));
}

// ─── System Prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are EVE (Evolved Virtual Entity), a sophisticated AI personal assistant. You are:

- Highly intelligent, efficient, and precise
- Professional yet personable, with sharp wit and warmth
- Proactive in offering relevant information and suggestions
- Concise but thorough — you never waste words
- Capable of helping with: research, coding, writing, analysis, scheduling, planning, and general knowledge
- Fluent in both English and Portuguese (respond in the same language the user uses)

When responding for voice output, keep answers conversational — avoid markdown, bullet points, or code blocks unless specifically requested. Speak naturally.

Current date: ${new Date().toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;

// ─── GPT-4 Chat ───────────────────────────────────────────────────────────────
async function askAI(userMessage) {
  conversationHistory.push({ role: 'user', content: userMessage });

  const response = await openai.chat.completions.create({
    model: AI_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...conversationHistory,
    ],
    max_tokens: 1024,
    temperature: 0.7,
  });

  const reply = response.choices[0].message.content;
  conversationHistory.push({ role: 'assistant', content: reply });
  saveHistory();
  return reply;
}

// ─── Text-to-Speech ───────────────────────────────────────────────────────────
let voiceEnabled = true;

async function speak(text) {
  if (!voiceEnabled) return;

  try {
    const audioFile = path.join(AUDIO_DIR, `response_${Date.now()}.mp3`);

    const mp3 = await openai.audio.speech.create({
      model: TTS_MODEL,
      voice: VOICE,
      input: text.substring(0, 4096),
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    fs.writeFileSync(audioFile, buffer);

    await playAudio(audioFile);

    setTimeout(() => { try { fs.unlinkSync(audioFile); } catch {} }, 8000);
  } catch (err) {
    if (err.status === 429) {
      voiceEnabled = false;
      console.log('\x1b[33m[EVE] Voice disabled — OpenAI quota reached. Add credits at platform.openai.com/settings/billing\x1b[0m');
    } else {
      console.log(`\x1b[33m[EVE] Voice unavailable: ${err.message}\x1b[0m`);
    }
  }
}

function playAudio(filePath) {
  return new Promise((resolve) => {
    const absPath = path.resolve(filePath).replace(/\\/g, '/');
    // Use Windows PowerShell WMP COM object for reliable playback
    const psCmd = [
      'powershell -NoProfile -NonInteractive -Command',
      `"$wmp = New-Object -ComObject WMPlayer.OCX; $wmp.URL = '${absPath}'; $wmp.controls.play(); $end = (Get-Date).AddSeconds(15); while($wmp.playState -ne 1 -and (Get-Date) -lt $end){ Start-Sleep -Milliseconds 200 }; $wmp.close()"`,
    ].join(' ');

    exec(psCmd, (err) => {
      if (err) {
        // Fallback: PowerShell MediaPlayer
        const fallback = `powershell -NoProfile -NonInteractive -Command "Add-Type -AssemblyName PresentationCore; $m=New-Object System.Windows.Media.MediaPlayer; $m.Open([Uri]'${absPath}'); $m.Play(); Start-Sleep 8; $m.Stop()"`;
        exec(fallback, () => resolve());
      } else {
        resolve();
      }
    });
  });
}

// ─── Speech-to-Text (Whisper) ─────────────────────────────────────────────────
async function transcribeAudio(audioFilePath) {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioFilePath),
    model: 'whisper-1',
    language: 'pt',
  });
  return transcription.text;
}

// ─── Record Audio via Windows PowerShell ─────────────────────────────────────
function recordAudio(durationSecs = 5) {
  const outFile = path.join(AUDIO_DIR, `input_${Date.now()}.wav`).replace(/\\/g, '\\\\');
  console.log(`\x1b[36m[JARVIS] Recording for ${durationSecs}s... Speak now!\x1b[0m`);

  const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class MCI {
    [DllImport("winmm.dll")]
    public static extern int mciSendString(string cmd, System.Text.StringBuilder ret, int size, IntPtr hwnd);
}
"@
[MCI]::mciSendString('open new Type waveaudio Alias rec', $null, 0, [IntPtr]::Zero) | Out-Null
[MCI]::mciSendString('set rec channels 1 bitspersample 16 samplespersec 16000', $null, 0, [IntPtr]::Zero) | Out-Null
[MCI]::mciSendString('record rec', $null, 0, [IntPtr]::Zero) | Out-Null
Start-Sleep -Seconds ${durationSecs}
[MCI]::mciSendString('stop rec', $null, 0, [IntPtr]::Zero) | Out-Null
[MCI]::mciSendString('save rec ${outFile}', $null, 0, [IntPtr]::Zero) | Out-Null
[MCI]::mciSendString('close rec', $null, 0, [IntPtr]::Zero) | Out-Null
`.trim();

  execSync(`powershell -NoProfile -Command "${psScript.replace(/\n/g, '; ').replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
  return outFile.replace(/\\\\/g, '\\');
}

// ─── Banner ───────────────────────────────────────────────────────────────────
function printBanner() {
  console.log('\x1b[34m');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║              E . V . E                               ║');
  console.log('║         Evolved Virtual Entity                       ║');
  console.log('║       Powered by OpenAI GPT-4 + Whisper + TTS       ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('\x1b[0m');
  console.log('\x1b[90mComandos:\x1b[0m');
  console.log('\x1b[90m  voice [segundos] — Modo voz (ex: voice 5)\x1b[0m');
  console.log('\x1b[90m  mute / unmute    — Ativar/desativar voz\x1b[0m');
  console.log('\x1b[90m  clear            — Limpar histórico\x1b[0m');
  console.log('\x1b[90m  exit             — Sair\x1b[0m\n');
}

function printUser(text) {
  console.log(`\n\x1b[32m[Você]\x1b[0m ${text}`);
}

function printJarvis(text) {
  console.log(`\n\x1b[35m[EVE]\x1b[0m ${text}\n`);
}

// ─── Voice Mode ───────────────────────────────────────────────────────────────
async function handleVoice(secs) {
  try {
    const audioFile = recordAudio(secs);

    if (!fs.existsSync(audioFile) || fs.statSync(audioFile).size < 1000) {
      printJarvis('Não consegui capturar áudio. Certifique-se de que o microfone está conectado.');
      return;
    }

    console.log('\x1b[90m[EVE] Transcrevendo...\x1b[0m');
    const transcript = await transcribeAudio(audioFile);
    try { fs.unlinkSync(audioFile); } catch {}

    if (!transcript.trim()) {
      printJarvis('Não consegui entender. Tente novamente.');
      return;
    }

    printUser(`(voz) ${transcript}`);
    console.log('\x1b[90m[EVE] Pensando...\x1b[0m');
    const reply = await askAI(transcript);
    printJarvis(reply);

    if (voiceEnabled) {
      console.log('\x1b[90m[EVE] Falando...\x1b[0m');
      await speak(reply);
    }
  } catch (err) {
    if (err.status === 429) {
      console.log('\x1b[33m[EVE] Cota OpenAI atingida. Adicione créditos em: platform.openai.com/settings/billing\x1b[0m');
    } else {
      console.log(`\x1b[31m[EVE] Erro no modo voz: ${err.message}\x1b[0m`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  printBanner();
  loadHistory();

  console.log('\x1b[90m[EVE] Conectando à OpenAI...\x1b[0m');

  try {
    const greeting = await askAI('Cumprimente o usuário brevemente como EVE, diga que está online e pronta para ajudar. Máximo 2 frases. Fale em português.');
    printJarvis(greeting);
    await speak(greeting);
  } catch (err) {
    if (err.status === 429) {
      printJarvis('Bom dia. EVE online. Cota de voz atingida — adicione créditos na OpenAI para ativar o chat por voz. Modo texto ativo.');
      voiceEnabled = false;
    } else if (err.status === 401) {
      console.error('\x1b[31m[EVE] Chave API OpenAI inválida. Verifique o arquivo .env\x1b[0m');
      process.exit(1);
    } else {
      printJarvis('EVE online. Pronta para ajudar.');
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const prompt = () => process.stdout.write('\x1b[32mVocê:\x1b[0m ');

  prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { prompt(); return; }

    const lower = input.toLowerCase();

    if (lower === 'exit' || lower === 'quit' || lower === 'sair') {
      printJarvis('Até logo. JARVIS encerrando sessão.');
      rl.close();
      process.exit(0);
    }

    if (lower === 'clear' || lower === 'limpar') {
      conversationHistory = [];
      saveHistory();
      printJarvis('Histórico de conversa apagado.');
      prompt();
      return;
    }

    if (lower === 'mute' || lower === 'silenciar') {
      voiceEnabled = false;
      printJarvis('Voz desativada. Digite "unmute" para reativar.');
      prompt();
      return;
    }

    if (lower === 'unmute' || lower === 'ativar voz') {
      voiceEnabled = true;
      printJarvis('Voz reativada.');
      prompt();
      return;
    }

    if (lower.startsWith('voice') || lower.startsWith('voz')) {
      const parts = input.split(' ');
      const secs = parseInt(parts[1]) || 5;
      await handleVoice(secs);
      prompt();
      return;
    }

    printUser(input);
    console.log('\x1b[90m[EVE] Pensando...\x1b[0m');

    try {
      const reply = await askAI(input);
      printJarvis(reply);

      if (voiceEnabled) {
        console.log('\x1b[90m[EVE] Falando...\x1b[0m');
        await speak(reply);
      }
    } catch (err) {
      if (err.status === 429) {
        console.log('\x1b[33m[EVE] Cota OpenAI atingida. Adicione créditos em: platform.openai.com/settings/billing\x1b[0m');
        voiceEnabled = false;
      } else {
        console.log(`\x1b[31m[EVE] Erro: ${err.message}\x1b[0m`);
      }
    }

    prompt();
  });
}

main().catch(console.error);
