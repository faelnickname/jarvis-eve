/* ─── JARVIS Cockpit Script ──────────────────────────────────────────────────── */

// Config
let CFG = {
  voice: 'onyx',
  ttsEnabled: true,
  wakeEnabled: true,
};

// State
let isProcessing = false;
let attachedFileContent = null;
let attachedFileName = null;
let activeSpawnId = null;
let ttsQueue = [];
let ttsPlaying = false;

// ─── Avatar State ──────────────────────────────────────────────────────────────
const avatarWrap   = document.getElementById('avatar-wrap');
const avatarStatus = document.getElementById('avatar-status');

const stateLabels = {
  idle: 'AGUARDANDO COMANDO',
  listening: 'OUVINDO...',
  thinking: 'PROCESSANDO...',
  speaking: 'RESPONDENDO...',
};

function setAvatarState(state) {
  avatarWrap.className = 'avatar-wrap ' + (state !== 'idle' ? state : '');
  avatarStatus.textContent = stateLabels[state] || 'AGUARDANDO COMANDO';
}

// ─── Terminal ──────────────────────────────────────────────────────────────────
const terminal = document.getElementById('terminal');

function ts() {
  const now = new Date();
  const h = now.getHours().toString().padStart(2,'0');
  const m = now.getMinutes().toString().padStart(2,'0');
  const s = now.getSeconds().toString().padStart(2,'0');
  return `[${h}:${m}:${s}]`;
}

function appendMsg(cssClass, html) {
  const div = document.createElement('div');
  div.className = cssClass;
  div.innerHTML = html;
  terminal.appendChild(div);
  terminal.scrollTop = terminal.scrollHeight;
  return div;
}

function renderMarkdown(el, text) {
  try {
    el.innerHTML = marked.parse(text);
    el.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
  } catch {
    el.textContent = text;
  }
}

// ─── Web Audio Sounds ──────────────────────────────────────────────────────────
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioCtx();
  return audioCtx;
}

function playTone(freq, duration, type = 'sine', gain = 0.2) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gn  = ctx.createGain();
    osc.connect(gn); gn.connect(ctx.destination);
    osc.type = type; osc.frequency.value = freq;
    gn.gain.setValueAtTime(gain, ctx.currentTime);
    gn.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(); osc.stop(ctx.currentTime + duration);
  } catch {}
}

function soundRecStart()  { playTone(880, 0.1, 'sine', 0.3); }
function soundThinking()  { playTone(440, 0.06, 'square', 0.1); }
function soundDone()      { playTone(660, 0.15, 'sine', 0.25); setTimeout(() => playTone(880, 0.15, 'sine', 0.25), 120); }
function soundWake()      { playTone(528, 0.1, 'sine', 0.3); setTimeout(() => playTone(660, 0.15, 'sine', 0.3), 100); }

// ─── TTS Queue ─────────────────────────────────────────────────────────────────
function enqueueTTS(text) {
  if (!CFG.ttsEnabled || !text.trim()) return;
  ttsQueue.push(text);
  if (!ttsPlaying) drainTTSQueue();
}

async function drainTTSQueue() {
  if (ttsQueue.length === 0) { ttsPlaying = false; return; }
  ttsPlaying = true;
  const text = ttsQueue.shift();
  await speak(text);
  drainTTSQueue();
}

async function speak(text) {
  return new Promise(async (resolve) => {
    try {
      setAvatarState('speaking');
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: CFG.voice }),
      });
      if (!res.ok) { resolve(); setAvatarState('idle'); return; }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setAvatarState('idle');
        resolve();
      };
      audio.onerror = () => { setAvatarState('idle'); resolve(); };
      audio.play();
    } catch {
      setAvatarState('idle');
      resolve();
    }
  });
}

// ─── Pre-spawn Claude ──────────────────────────────────────────────────────────
async function preSpawnClaude() {
  try {
    const res = await fetch('/api/voice-spawn', { method: 'POST' });
    const data = await res.json();
    activeSpawnId = data.spawnId;
  } catch {}
}

// ─── Send Message ──────────────────────────────────────────────────────────────
async function sendMessage(text) {
  if (!text.trim() || isProcessing) return;
  isProcessing = true;
  setProcessing(true);

  appendMsg('msg-user', `<span class="ts">${ts()}</span><strong>[Senhor]</strong> ${escHtml(text)}`);
  setAvatarState('thinking');
  soundThinking();

  const jarvisDiv = appendMsg('msg-jarvis', `<span class="ts">${ts()}</span><strong>[JARVIS]</strong> `);
  const contentSpan = document.createElement('span');
  jarvisDiv.appendChild(contentSpan);

  let fullText = '';
  let ackReceived = false;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        voice: CFG.ttsEnabled,
        attachedFile: attachedFileContent,
      }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'ack') {
            if (!ackReceived) {
              ackReceived = true;
              appendMsg('msg-ack', `<span class="ts">${ts()}</span>↳ ${escHtml(evt.text)}`);
              if (evt.model) updateModelIndicator(evt.model);
            }
          } else if (evt.type === 'chunk') {
            fullText += evt.text;
            renderMarkdown(contentSpan, fullText);
            terminal.scrollTop = terminal.scrollHeight;
          } else if (evt.type === 'done') {
            soundDone();
            if (evt.model) updateModelIndicator(evt.model);
          } else if (evt.type === 'error') {
            appendMsg('msg-error', `<span class="ts">${ts()}</span>[ERRO] ${escHtml(evt.text)}`);
          }
        } catch {}
      }
    }

    if (fullText.trim() && CFG.ttsEnabled) {
      const plain = fullText.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '').replace(/[#*_\[\]()]/g, '').trim();
      enqueueTTS(plain.slice(0, 800));
    }

  } catch (err) {
    appendMsg('msg-error', `<span class="ts">${ts()}</span>[ERRO] ${escHtml(err.message)}`);
    setAvatarState('idle');
  }

  // Clear attached file
  attachedFileContent = null;
  attachedFileName = null;
  document.getElementById('attach-name').textContent = '';

  isProcessing = false;
  setProcessing(false);
  if (!ttsPlaying) setAvatarState('idle');
}

function setProcessing(on) {
  document.getElementById('btn-send').disabled = on;
  document.getElementById('msg-input').disabled = on;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Model Indicator ───────────────────────────────────────────────────────────
function updateModelIndicator(model) {
  const lower = model.toLowerCase();
  document.getElementById('nav-model').textContent = model.toUpperCase();
  ['haiku','sonnet','opus'].forEach(t => {
    const dot = document.querySelector(`#tier-${t} .tier-dot`);
    const tier = document.getElementById(`tier-${t}`);
    const active = lower.includes(t);
    dot.classList.toggle('active', active);
    tier.classList.toggle('active-tier', active);
  });
}

// ─── Voice Recording ───────────────────────────────────────────────────────────
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

const btnMic = document.getElementById('btn-mic');

btnMic.addEventListener('click', toggleRecording);

async function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      stream.getTracks().forEach(t => t.stop());
      await transcribeAndSend(blob);
    };
    mediaRecorder.start();
    isRecording = true;
    btnMic.classList.add('recording');
    setAvatarState('listening');
    soundRecStart();
    preSpawnClaude();
  } catch (err) {
    appendMsg('msg-error', `<span class="ts">${ts()}</span>[MIC] ${escHtml(err.message)}`);
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    btnMic.classList.remove('recording');
    setAvatarState('thinking');
  }
}

async function transcribeAndSend(blob) {
  try {
    const formData = new FormData();
    formData.append('audio', blob, 'audio.webm');
    const res  = await fetch('/api/stt', { method: 'POST', body: formData });
    const data = await res.json();
    if (!data.text?.trim()) {
      appendMsg('msg-error', `<span class="ts">${ts()}</span>[STT] Não foi possível transcrever.`);
      setAvatarState('idle');
      return;
    }
    document.getElementById('msg-input').value = data.text;
    await sendVoiceStream(data.text);
  } catch (err) {
    appendMsg('msg-error', `<span class="ts">${ts()}</span>[STT] ${escHtml(err.message)}`);
    setAvatarState('idle');
  }
}

async function sendVoiceStream(text) {
  if (!text.trim() || isProcessing) return;
  isProcessing = true;
  setProcessing(true);

  appendMsg('msg-user', `<span class="ts">${ts()}</span><strong>[Senhor 🎙️]</strong> ${escHtml(text)}`);
  setAvatarState('thinking');
  soundThinking();

  const jarvisDiv = appendMsg('msg-jarvis', `<span class="ts">${ts()}</span><strong>[JARVIS]</strong> `);
  const contentSpan = document.createElement('span');
  jarvisDiv.appendChild(contentSpan);

  try {
    const res = await fetch('/api/voice-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, spawnId: activeSpawnId }),
    });
    activeSpawnId = null;
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    renderMarkdown(contentSpan, data.reply);
    terminal.scrollTop = terminal.scrollHeight;
    if (data.model) updateModelIndicator(data.model);
    soundDone();

    const plain = data.reply.replace(/```[\s\S]*?```/g,'').replace(/`[^`]+`/g,'').replace(/[#*_\[\]()]/g,'').trim();
    enqueueTTS(plain.slice(0, 800));
  } catch (err) {
    appendMsg('msg-error', `<span class="ts">${ts()}</span>[VOZ] ${escHtml(err.message)}`);
  }

  document.getElementById('msg-input').value = '';
  isProcessing = false;
  setProcessing(false);
  if (!ttsPlaying) setAvatarState('idle');
}

// ─── Wake Word ─────────────────────────────────────────────────────────────────
const btnWake = document.getElementById('btn-wake');
let wakeRecognition = null;
let wakeActive = false;

btnWake.addEventListener('click', toggleWake);

function toggleWake() {
  if (wakeActive) {
    stopWake();
  } else {
    startWake();
  }
}

function startWake() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    appendMsg('msg-error', `<span class="ts">${ts()}</span>[WAKE] Wake word não suportado neste navegador.`);
    return;
  }
  wakeRecognition = new SpeechRecognition();
  wakeRecognition.continuous = true;
  wakeRecognition.lang = 'pt-BR';
  wakeRecognition.onresult = (e) => {
    const transcript = Array.from(e.results).map(r => r[0].transcript).join(' ').toLowerCase();
    if (transcript.includes('jarvis') && !isRecording && !isProcessing) {
      soundWake();
      appendMsg('msg-ack', `<span class="ts">${ts()}</span>↳ Wake word detectada. Ouvindo...`);
      startRecording();
    }
  };
  wakeRecognition.onerror = () => {};
  wakeRecognition.start();
  wakeActive = true;
  btnWake.classList.add('active');
  appendMsg('msg-ack', `<span class="ts">${ts()}</span>↳ Wake word ativa. Diga "Jarvis" para ativar.`);
}

function stopWake() {
  if (wakeRecognition) { wakeRecognition.stop(); wakeRecognition = null; }
  wakeActive = false;
  btnWake.classList.remove('active');
}

// ─── File Attach ───────────────────────────────────────────────────────────────
const btnAttach  = document.getElementById('btn-attach');
const fileInput  = document.getElementById('file-input');
const attachName = document.getElementById('attach-name');

btnAttach.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res  = await fetch('/api/attach', { method: 'POST', body: formData });
    const data = await res.json();
    attachedFileContent = data.content;
    attachedFileName    = data.name;
    attachName.textContent = `📎 ${data.name}`;
  } catch (err) {
    appendMsg('msg-error', `<span class="ts">${ts()}</span>[ATTACH] ${escHtml(err.message)}`);
  }
  fileInput.value = '';
});

// ─── Send Button & Enter ───────────────────────────────────────────────────────
document.getElementById('btn-send').addEventListener('click', () => {
  const val = document.getElementById('msg-input').value.trim();
  if (val) { document.getElementById('msg-input').value = ''; sendMessage(val); }
});

document.getElementById('msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const val = document.getElementById('msg-input').value.trim();
    if (val) { document.getElementById('msg-input').value = ''; sendMessage(val); }
  }
});

// ─── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
    const el = document.getElementById(`tab-${target}`);
    if (el) el.style.display = 'block';
    if (target === 'arquivo') loadFiles();
  });
});

// ─── Files ─────────────────────────────────────────────────────────────────────
async function loadFiles() {
  const list = document.getElementById('file-list');
  if (!list) return;
  list.innerHTML = 'Carregando...';
  try {
    const res   = await fetch('/api/files');
    const files = await res.json();
    if (!files.length) { list.innerHTML = '<span style="color:var(--text-dim)">Nenhum arquivo.</span>'; return; }
    list.innerHTML = '';
    files.forEach(f => {
      const div = document.createElement('div');
      div.className = 'file-item';
      div.innerHTML = `<div class="file-name">${escHtml(f.name)}</div><div class="file-meta">${formatBytes(f.size)}</div>`;
      div.onclick = () => window.open(`/api/files/view/${encodeURIComponent(f.name)}`, '_blank');
      list.appendChild(div);
    });
  } catch {
    list.innerHTML = '<span style="color:var(--red)">Erro ao carregar.</span>';
  }
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/(1024*1024)).toFixed(1) + ' MB';
}

// ─── Config Save ───────────────────────────────────────────────────────────────
function saveConfig() {
  CFG.voice      = document.getElementById('cfg-voice').value;
  CFG.ttsEnabled = document.getElementById('cfg-tts').checked;
  CFG.wakeEnabled = document.getElementById('cfg-wake').checked;
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice: CFG.voice }),
  });
  appendMsg('msg-ack', `<span class="ts">${ts()}</span>↳ Configurações salvas.`);
}

// ─── Stats Polling ─────────────────────────────────────────────────────────────
async function pollStats() {
  try {
    const res  = await fetch('/api/stats');
    const data = await res.json();
    document.getElementById('stat-session').textContent  = data.sessionTime || '00:00:00';
    document.getElementById('stat-tokens').textContent   = data.tokens || 0;
    document.getElementById('stat-requests').textContent = data.requests || 0;
  } catch {}
}

setInterval(pollStats, 4000);
pollStats();

// ─── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  // Show default tab
  document.getElementById('tab-principal').style.display = 'block';

  // Greeting
  setTimeout(() => {
    appendMsg('msg-ack', `<span class="ts">${ts()}</span>↳ Sistema iniciado. Todos os subsistemas operacionais.`);
  }, 500);
})();
