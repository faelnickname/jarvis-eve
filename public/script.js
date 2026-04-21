// ========== EVE COCKPIT - CLIENT LOGIC ==========

// DOM Elements
const terminal = document.getElementById('terminal-output');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const micBtn = document.getElementById('mic-btn');
const avatarContainer = document.querySelector('.avatar-container');
const avatarStatus = document.getElementById('avatar-status');
const fileAttach = document.getElementById('file-attach');

// State
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let currentAttachment = null;
let voiceEnabled = true;
let ttsVoice = localStorage.getItem('ttsVoice') || 'nova';

// Realtime API supports a different voice set than TTS.
// Map TTS/ElevenLabs voices to nearest valid Realtime voice.
const REALTIME_VOICES = new Set(['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar']);
const REALTIME_VOICE_MAP = {
  onyx: 'ash', nova: 'shimmer', fable: 'sage',
  'el-rachel': 'shimmer', 'el-bella': 'coral', 'el-elli': 'shimmer', 'el-charlotte': 'sage'
};
function getRealtimeVoice() {
  if (REALTIME_VOICES.has(ttsVoice)) return ttsVoice;
  return REALTIME_VOICE_MAP[ttsVoice] || 'shimmer';
}

let wakeWordEnabled = false;
let wakeWordRecognition = null;
let ttsQueue = [];
let ttsPlaying = false;
let userGestureReceived = false;
let webSpeechRec = null;
const canWebSpeech = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;

// ========== SCREEN CAPTURE (LIVE MODE) ==========
let capturedScreen = null;    // base64 PNG of last captured frame
let screenStream = null;       // persistent stream for live mode
let liveScreenMode = false;    // when true: stream stays alive, fresh frame per query
let hiddenVideo = null;        // off-screen video element bound to stream

const screenBtn = document.getElementById('screen-btn');

function stopScreenCapture() {
  capturedScreen = null;
  liveScreenMode = false;
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  if (hiddenVideo) { hiddenVideo.srcObject = null; hiddenVideo.remove(); hiddenVideo = null; }
  document.getElementById('screen-preview-box')?.remove();
  screenBtn.classList.remove('active');
}

// Legacy alias (existing X button callback expects this name)
const removeScreenPreview = stopScreenCapture;

// Grab latest frame from the live stream (returns base64 dataURL)
async function grabLatestFrame() {
  if (!hiddenVideo || hiddenVideo.readyState < 2) return capturedScreen;
  const canvas = document.createElement('canvas');
  canvas.width = hiddenVideo.videoWidth || 1920;
  canvas.height = hiddenVideo.videoHeight || 1080;
  canvas.getContext('2d').drawImage(hiddenVideo, 0, 0);
  capturedScreen = canvas.toDataURL('image/jpeg', 0.85); // jpeg for smaller payload
  return capturedScreen;
}

async function captureScreen() {
  // Toggle off if already active
  if (liveScreenMode || capturedScreen) {
    stopScreenCapture();
    addTerminalLine(
      currentLang === 'BR' ? '[system] Compartilhamento de tela desligado.' : '[system] Screen sharing stopped.',
      'system-line'
    );
    return;
  }

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { mediaSource: 'screen', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15 } },
      audio: false
    });

    // Bind stream to a hidden <video> so we can grab frames on demand
    hiddenVideo = document.createElement('video');
    hiddenVideo.autoplay = true;
    hiddenVideo.muted = true;
    hiddenVideo.playsInline = true;
    hiddenVideo.style.position = 'fixed';
    hiddenVideo.style.left = '-9999px';
    hiddenVideo.srcObject = screenStream;
    document.body.appendChild(hiddenVideo);
    await new Promise((resolve) => {
      hiddenVideo.onloadedmetadata = () => { hiddenVideo.play().then(resolve).catch(resolve); };
    });

    // User stops sharing via browser UI → clean up
    screenStream.getVideoTracks()[0].addEventListener('ended', () => {
      stopScreenCapture();
      addTerminalLine(
        currentLang === 'BR' ? '[system] Compartilhamento encerrado pelo navegador.' : '[system] Sharing ended by browser.',
        'system-line'
      );
    });

    liveScreenMode = true;
    await grabLatestFrame();
    showScreenPreview(capturedScreen);
    screenBtn.classList.add('active');

    addTerminalLine(
      currentLang === 'BR'
        ? '[system] 🔴 LIVE — tela compartilhada. EVE vê em tempo real. Fale ou digite suas perguntas.'
        : '[system] 🔴 LIVE — screen shared. EVE sees in real-time. Speak or type your questions.',
      'system-line'
    );
  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      addTerminalLine(`[error] Screen capture failed: ${err.message}`, 'error-line');
    }
    stopScreenCapture();
  }
}

function showScreenPreview(dataUrl) {
  document.getElementById('screen-preview-box')?.remove();

  const preview = document.createElement('div');
  preview.id = 'screen-preview-box';
  preview.className = 'screen-preview live';
  preview.innerHTML = `
    <img src="${dataUrl}" alt="Live screen">
    <span class="screen-label">LIVE</span>
    <button class="remove-screen" title="Stop sharing">✕</button>
  `;
  preview.querySelector('.remove-screen').onclick = stopScreenCapture;

  const inputBar = document.querySelector('.input-bar');
  inputBar.parentNode.insertBefore(preview, inputBar);
}

function updatePreviewImage(dataUrl) {
  const img = document.querySelector('#screen-preview-box img');
  if (img) img.src = dataUrl;
}

async function analyzeScreen(userMessage) {
  // In live mode, grab a FRESH frame for every question
  if (liveScreenMode) {
    await grabLatestFrame();
    updatePreviewImage(capturedScreen);
  }
  if (!capturedScreen) return null;

  const screen = capturedScreen;
  setAvatarState('thinking');

  try {
    // Fast path: GPT-4o-mini vision (~1s, real-time)
    const res = await fetch('/api/analyze-screen-fast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: screen, message: userMessage, language: currentLang, saveHistory: true })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.response) return data.response;
    }
    // Fallback: Claude vision (deeper analysis)
    const res2 = await fetch('/api/analyze-screen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: screen, message: userMessage, language: currentLang, saveHistory: true })
    });
    const data2 = await res2.json();
    return data2.response || null;
  } catch (err) {
    addTerminalLine(`[error] Screen analysis failed: ${err.message}`, 'error-line');
    return null;
  }
}

screenBtn?.addEventListener('click', captureScreen);

// ========== CONCLAVE TOGGLE ==========
let conclaveEnabled = localStorage.getItem('eve-conclave') !== 'false';

function initConclaveToggle() {
  const cb = document.getElementById('conclave-checkbox');
  const chip = cb?.closest('.mega-chip');
  if (!cb) return;

  cb.checked = conclaveEnabled;
  if (!conclaveEnabled) chip?.classList.add('conclave-off');

  cb.addEventListener('change', () => {
    conclaveEnabled = cb.checked;
    localStorage.setItem('eve-conclave', conclaveEnabled);
    if (conclaveEnabled) chip?.classList.remove('conclave-off');
    else chip?.classList.add('conclave-off');
  });
}

// ========== LANGUAGE STATE ==========
let currentLang = localStorage.getItem('eve-lang') || 'BR';

function initLangToggle() {
  const enBtn = document.getElementById('lang-en');
  const brBtn = document.getElementById('lang-br');
  const esBtn = document.getElementById('lang-es');
  if (!enBtn || !brBtn) return;

  function applyLang(lang) {
    currentLang = lang;
    localStorage.setItem('eve-lang', lang);
    enBtn.classList.toggle('active', lang === 'EN');
    brBtn.classList.toggle('active', lang === 'BR');
    if (esBtn) esBtn.classList.toggle('active', lang === 'ES');
    const placeholders = {
      BR: 'Fale com a EVE...',
      ES: 'Habla con EVE...',
      EN: 'Talk to EVE...'
    };
    document.getElementById('chat-input').placeholder = placeholders[lang] || placeholders.EN;
    const bootMsg = document.getElementById('boot-msg');
    if (bootMsg) {
      const boots = {
        BR: '[system] EVE COCKPIT INICIALIZADO. TODO SISTEMA DE INTELIGÊNCIA CARREGADO COM SUCESSO E PRONTO PARA USO.',
        ES: '[system] EVE COCKPIT INICIADO. TODO EL SISTEMA DE INTELIGENCIA CARGADO CON ÉXITO Y LISTO PARA USAR.',
        EN: '[system] EVE COCKPIT ONLINE. ALL SYSTEMS LOADED AND READY.'
      };
      bootMsg.textContent = boots[lang] || boots.EN;
    }
    // If Realtime is active, reconnect to pick up new language instructions
    if (realtimeActive) { stopRealtime(); setTimeout(() => startRealtime(), 300); }
  }

  applyLang(currentLang);

  enBtn.addEventListener('click', () => { if (currentLang !== 'EN') applyLang('EN'); });
  brBtn.addEventListener('click', () => { if (currentLang !== 'BR') applyLang('BR'); });
  if (esBtn) esBtn.addEventListener('click', () => { if (currentLang !== 'ES') applyLang('ES'); });
}

// ========== AUDIO CONTEXT (SOUND FEEDBACK) ==========
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playTone(freq, duration = 80, vol = 0.1) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = vol;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration / 1000);
    osc.stop(ctx.currentTime + duration / 1000);
  } catch {}
}

function playSendSound() { playTone(880, 60); setTimeout(() => playTone(1100, 60), 70); }
function playReceiveSound() { playTone(660, 80); }
function playErrorSound() { playTone(440, 100); setTimeout(() => playTone(330, 150), 120); }

// ========== TERMINAL RENDERING ==========
function getTimestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function addTerminalLine(text, type = '') {
  const line = document.createElement('div');
  line.className = `terminal-line ${type}`;
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = `[${getTimestamp()}]`;
  const msg = document.createElement('span');
  msg.className = 'msg';

  if (type === '' || type === 'jarvis-line') {
    msg.innerHTML = renderMarkdown(text);
    addCopyButtons(msg);
  } else {
    msg.textContent = text;
  }

  line.appendChild(ts);
  line.appendChild(document.createTextNode(' '));
  line.appendChild(msg);
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

let pendingAckTTS = null; // Track ACK that needs TTS

// ========== MODEL CARD HIGHLIGHTING ==========
function setActiveModel(model) {
  document.querySelectorAll('.model-card').forEach(c => c.classList.remove('active-model'));
  const id = model === 'opus' ? 'model-opus' : model === 'sonnet' ? 'model-sonnet' : 'model-haiku';
  document.getElementById(id)?.classList.add('active-model');
}

// ========== AGENT CHIP HIGHLIGHTING ==========
function highlightAgents(text) {
  document.querySelectorAll('.agent-chip').forEach(c => c.classList.remove('active-agent'));
  const agentMap = {
    'dev': 'dev', 'architect': 'architect', 'qa': 'qa', 'pm': 'pm',
    'po': 'po', 'devops': 'devops', 'analyst': 'analyst', 'ux': 'ux',
    'sm': 'sm', 'data-eng': 'data-eng', 'data-engineer': 'data-eng',
    'aios-master': 'aios-master', 'orion': 'aios-master',
    'conclave': 'conclave', 'crítico': 'conclave', 'advogado': 'conclave', 'sintetizador': 'conclave',
  };
  const lower = text.toLowerCase();
  for (const [keyword, dataAgent] of Object.entries(agentMap)) {
    if (lower.includes(`@${keyword}`) || lower.includes(keyword)) {
      document.querySelector(`.agent-chip[data-agent="${dataAgent}"]`)?.classList.add('active-agent');
    }
  }
}

// Show which model is active based on agent chip selection
function setModelFromAgent(agentEl) {
  if (!agentEl) return;
  document.querySelectorAll('.model-card').forEach(c => c.classList.remove('active-model'));
  if (agentEl.classList.contains('model-opus'))   document.getElementById('model-opus')?.classList.add('active-model');
  if (agentEl.classList.contains('model-sonnet')) document.getElementById('model-sonnet')?.classList.add('active-model');
  if (agentEl.classList.contains('model-haiku'))  document.getElementById('model-haiku')?.classList.add('active-model');
}

function processStreamLine(line) {
  if (!line.trim()) return;

  if (line.startsWith('[translated]')) {
    // Replace last user line in terminal with English translation
    const translated = line.slice(12).trim();
    const userLines = terminal.querySelectorAll('.user-line');
    if (userLines.length > 0) {
      const last = userLines[userLines.length - 1];
      last.querySelector('.msg').textContent = `> ${translated}`;
    }
    return true;
  } else if (line.startsWith('[ack]')) {
    // 7A: Instant acknowledgment — show + speak immediately
    const ackText = line.slice(5).trim();
    addTerminalLine(ackText, 'info-line');
    // Fire TTS for ACK immediately (non-blocking)
    if (voiceEnabled && userGestureReceived) {
      pendingAckTTS = speakResponse(ackText);
    }
    return true;
  } else if (line.startsWith('[system]')) {
    addTerminalLine(line, 'system-line');
    // Completion TTS is handled exclusively by GPT-mini push notifications (SSE)
  } else if (line.startsWith('[file]')) {
    addTerminalLine(line, 'file-line');
    const match = line.match(/\[file\]\s*(.+?)\s*\|\s*(.+)/);
    if (match) addDownloadCard(match[1].trim(), match[2].trim());
  } else if (line.startsWith('[error]')) {
    addTerminalLine(line, 'error-line');
  } else if (line.startsWith('[warn]')) {
    addTerminalLine(line, 'warn-line');
  } else if (line.startsWith('[info]')) {
    addTerminalLine(line, 'info-line');
  } else {
    return false;
  }
  return true;
}

function addDownloadCard(fileName, filePath) {
  const card = document.createElement('div');
  card.className = 'download-card';
  card.innerHTML = `
    <span class="file-icon">📄</span>
    <span class="file-name">${fileName}</span>
    <a class="dl-btn" href="/api/files/download?path=${encodeURIComponent(filePath)}" download>Download</a>
  `;
  terminal.appendChild(card);
  terminal.scrollTop = terminal.scrollHeight;
}

// ========== MARKDOWN RENDERING ==========
function renderMarkdown(text) {
  try {
    if (typeof marked !== 'undefined') {
      marked.setOptions({
        highlight: function(code, lang) {
          if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
          }
          return code;
        },
        breaks: true,
        gfm: true
      });
      return marked.parse(text);
    }
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  } catch {
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

function addCopyButtons(container) {
  container.querySelectorAll('pre').forEach(pre => {
    pre.style.position = 'relative';
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = 'Copy';
    btn.onclick = () => {
      const code = pre.querySelector('code')?.textContent || pre.textContent;
      navigator.clipboard.writeText(code);
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    };
    pre.appendChild(btn);
  });
}

// ========== CHAT - SEND MESSAGE ==========
async function sendMessage(text, fromVoice = false) {
  if (!text.trim() && !capturedScreen) return;

  userGestureReceived = true;
  pendingAckTTS = null;
  const displayText = text.trim() || (currentLang === 'BR' ? '[análise de tela]' : '[screen analysis]');
  addTerminalLine(`> ${displayText}`, 'user-line');
  chatInput.value = '';
  playSendSound();
  setAvatarState('thinking');

  // If screen is captured + Q&A → GPT-4o-mini vision (fast, real-time)
  // If screen is captured + build task → fall through to normal chat (Claude gets context via /api/chat)
  const isBuildTask = /\b(create|generate|build|make|write|produce|design|implement|develop|fix|update|report|crie|gere|construa|faça|escreva|implemente|corrija|analise|relatório)\b/i.test(text);
  if ((capturedScreen || liveScreenMode) && !isBuildTask) {
    const screenResponse = await analyzeScreen(text.trim());
    if (screenResponse) {
      addTerminalLine(screenResponse, 'jarvis-line');
      playReceiveSound();
      highlightAgents(screenResponse);
      if (voiceEnabled && userGestureReceived) {
        const brief = screenResponse.replace(/```[\s\S]*?```/g, '').replace(/[#*_`~>|]/g, '')
          .replace(/\n+/g, ' ').trim().split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').slice(0, 300);
        if (brief) await speakResponse(brief);
      }
      setAvatarState('idle');
      scheduleNextListen(1200); // continuous voice mode restart after vision
      return;
    }
    setAvatarState('idle');
    scheduleNextListen(1500);
    return;
  }

  if (!text.trim()) return;

  // Highlight active model based on complexity
  const opusMatch = /\b(architect|redesign|refactor|infrastructure|migration|deploy|scale|database|system design|e-?book|full|complete|advanced|complex|detailed|comprehensive|deep|entire|production|enterprise)\b/i.test(text);
  const sonnetMatch = /\b(create|generate|build|make|write|produce|design|implement|develop|fix|update|modify|analyze|report|presentation|website|app|pdf|document|code|script|html|css|crie|gere|construa|faça|escreva)\b/i.test(text);
  const isVoiceTask = fromVoice && (opusMatch || sonnetMatch);
  setActiveModel(opusMatch ? 'opus' : sonnetMatch ? 'sonnet' : 'haiku');

  // ACK is now handled by GPT-mini response (Phase 1 of /api/chat)
  let ackPromise = null;

  try {
    const body = { message: text, fromVoice, language: currentLang, conclaveEnabled };
    if (currentAttachment) {
      body.attachmentId = currentAttachment.id;
      currentAttachment = null;
      removeAttachmentPreview();
    }

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let buffer = '';
    let claudeSilent = false;   // true after [build-start] — Claude output is terminal-only
    let gptResponse = '';       // GPT-mini portion (before [build-start]) — this gets spoken
    let streamTtsBuffer = '';
    let streamTtsFired = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      fullResponse += chunk;

      // Extract GPT portion (before [build-start]) for TTS — before mutating claudeSilent
      const ackPortion = chunk.split('[build-start]')[0];
      const hadBuildStart = chunk.includes('[build-start]');

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('[build-start]')) { claudeSilent = true; continue; }
        processStreamLine(line);
        if (!claudeSilent) gptResponse += line + '\n';
      }

      // Streaming TTS: fire on ACK portion regardless of claudeSilent state
      if (!streamTtsFired && voiceEnabled && userGestureReceived && ackPortion.trim()) {
        const cleanAck = ackPortion.split('\n')
          .filter(l => !l.match(/^\[(system|file|error|warn|info|ack|build-start|translated)\]/))
          .join(' ').trim();
        if (cleanAck) {
          streamTtsBuffer += cleanAck + ' ';
          // Fire TTS as soon as possible: first clause ending with .!?,: OR 18+ chars accumulated
          const sentMatch = streamTtsBuffer.match(/^(.{6,}?[.!?,:])\s/);
          const bufTrim = streamTtsBuffer.trim();
          if (sentMatch || (hadBuildStart && bufTrim.length > 6) || bufTrim.length >= 18) {
            streamTtsFired = true;
            speakResponse((sentMatch ? sentMatch[1] : bufTrim).trim());
          }
        }
      }
    }

    if (buffer.trim() && !buffer.startsWith('[build-start]')) processStreamLine(buffer);

    // GPT-mini response → render + speak (if not already fired by streaming)
    const cleanGpt = gptResponse.split('\n')
      .filter(l => !l.startsWith('[system]') && !l.startsWith('[file]') && !l.startsWith('[error]') && !l.startsWith('[warn]') && !l.startsWith('[info]') && !l.startsWith('[ack]'))
      .join('\n').trim();

    // Claude output (after [build-start]) → render to terminal, NO TTS
    const claudeOutput = fullResponse.split('[build-start]')[1] || '';
    const cleanClaude = claudeOutput.split('\n')
      .filter(l => !l.startsWith('[system]') && !l.startsWith('[file]') && !l.startsWith('[error]') && !l.startsWith('[warn]') && !l.startsWith('[info]') && !l.startsWith('[ack]'))
      .join('\n').trim();

    if (cleanGpt) {
      addTerminalLine(cleanGpt, 'jarvis-line');
      playReceiveSound();
      highlightAgents(cleanGpt);
      // Speak GPT-mini response if streaming TTS didn't already fire
      if (voiceEnabled && userGestureReceived && !streamTtsFired) {
        const brief = cleanGpt.replace(/```[\s\S]*?```/g, '').replace(/[#*_`~>|]/g, '')
          .replace(/\n+/g, ' ').trim()
          .split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 5).slice(0, 2).join(' ').slice(0, 300);
        if (brief) await speakResponse(brief);
      }
    }

    if (cleanClaude) {
      addTerminalLine(cleanClaude, 'jarvis-line');
      if (!cleanGpt) { playReceiveSound(); highlightAgents(cleanClaude); }
      // NO TTS — completion will come via push notification (GPT-mini SSE)
    }

    if (true) { // keep block structure
    }

    setAvatarState('idle');
    scheduleNextListen(1500); // continuous mode restart
  } catch (err) {
    addTerminalLine(`[error] ${err.message}`, 'error-line');
    playErrorSound();
    setAvatarState('idle');
    scheduleNextListen(2000);
  }
}

// ========== AVATAR STATES ==========
function setAvatarState(state) {
  avatarContainer.classList.remove('listening', 'thinking', 'speaking');
  switch (state) {
    case 'listening':
      avatarContainer.classList.add('listening');
      avatarStatus.textContent = 'LISTENING';
      break;
    case 'thinking':
      avatarContainer.classList.add('thinking');
      avatarStatus.textContent = 'PROCESSING';
      break;
    case 'speaking':
      avatarContainer.classList.add('speaking');
      avatarStatus.textContent = 'SPEAKING';
      break;
    default:
      avatarStatus.textContent = 'AWAITING COMMAND';
  }
}

// ========== VOICE CAPTURE (MEDIARECORDER + WHISPER) ==========
let recordingStartTime = 0;
let audioAnalyser = null;
let peakVolume = 0;
let vadTimer = null;         // silence auto-stop timer
let continuousMode = false;  // hands-free loop
let continuousTimer = null;

const VAD_SILENCE_MS = 1100; // fastest: stop after 1.1s of silence

// Continuous mode toggle button (injected into input bar)
function initContinuousBtn() {
  const btn = document.createElement('button');
  btn.id = 'continuous-btn';
  btn.className = 'screen-btn';
  btn.title = 'Continuous voice mode';
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M12 1a4 4 0 0 0-4 4v7a4 4 0 0 0 8 0V5a4 4 0 0 0-4-4z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <circle cx="12" cy="22" r="1.5" fill="currentColor"/>
  </svg>`;
  btn.addEventListener('click', async () => {
    if (realtimeConnecting) {
      addTerminalLine(
        currentLang === 'BR' ? '[status] Conectando, aguarde...' : '[status] Connecting, please wait...',
        'info-line'
      );
      // Wait for current connection attempt to finish, then report final status
      while (realtimeConnecting) await new Promise(r => setTimeout(r, 200));
      btn.style.color = realtimeActive ? 'var(--cyan)' : '';
      btn.style.background = realtimeActive ? 'rgba(0,212,255,0.1)' : '';
      addTerminalLine(
        realtimeActive
          ? (currentLang === 'BR' ? '[status] Modo contínuo: ATIVADO' : '[status] Continuous mode: ON')
          : (currentLang === 'BR' ? '[status] Modo contínuo: DESATIVADO' : '[status] Continuous mode: OFF'),
        'info-line'
      );
      return;
    }
    await startRealtime();
    btn.style.color = realtimeActive ? 'var(--cyan)' : '';
    btn.style.background = realtimeActive ? 'rgba(0,212,255,0.1)' : '';
    addTerminalLine(
      realtimeActive
        ? (currentLang === 'BR' ? '[status] Modo contínuo: ATIVADO' : '[status] Continuous mode: ON')
        : (currentLang === 'BR' ? '[status] Modo contínuo: DESATIVADO' : '[status] Continuous mode: OFF'),
      'info-line'
    );
  });
  const sendBtn = document.getElementById('send-btn');
  sendBtn.parentNode.insertBefore(btn, sendBtn);
}

// ========== REALTIME VOICE MODE (OpenAI WebRTC — ~300ms latency) ==========
let realtimePC = null;
let realtimeStream = null;
let realtimeAudio = null;
let realtimeDC = null;
let realtimeActive = false;
let realtimeConnecting = false;
let realtimeUserDisabled = false;

async function startRealtime() {
  if (realtimeActive) { realtimeUserDisabled = true; return stopRealtime(); }
  if (realtimeConnecting) return; // guard against parallel connects
  realtimeConnecting = true;
  realtimeUserDisabled = false;
  try {
    userGestureReceived = true;
    const tokenRes = await fetch('/api/realtime/session', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      // Realtime API only supports: alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar
      // TTS voices like onyx, nova, fable are NOT supported — always map to a valid Realtime voice
      body: JSON.stringify({ language: currentLang, voice: getRealtimeVoice() })
    });
    const sess = await tokenRes.json();
    if (!sess.client_secret?.value) throw new Error(sess.error || 'No ephemeral token');

    const pc = new RTCPeerConnection();
    realtimePC = pc;

    // Remote audio sink — explicit play() required by browser autoplay policy
    realtimeAudio = new Audio();
    realtimeAudio.autoplay = true;
    pc.ontrack = (e) => {
      realtimeAudio.srcObject = e.streams[0];
      realtimeAudio.play().catch(() => {});
      setAvatarState('speaking');
    };

    // Mic input
    realtimeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    realtimeStream.getTracks().forEach(t => pc.addTrack(t, realtimeStream));

    // Data channel for events
    const dc = pc.createDataChannel('oai-events');
    realtimeDC = dc;
    dc.addEventListener('message', (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === 'input_audio_buffer.speech_started') setAvatarState('listening');
        if (ev.type === 'response.audio.done') setAvatarState('idle');
        if (ev.type === 'conversation.item.input_audio_transcription.completed' && ev.transcript) {
          // Translate user transcript to match the active language toggle
          (async () => {
            try {
              const r = await fetch('/api/translate', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ text: ev.transcript, targetLang: currentLang })
              });
              const d = await r.json();
              addTerminalLine('> ' + (d.translated || ev.transcript), 'user-line');
            } catch {
              addTerminalLine('> ' + ev.transcript, 'user-line');
            }
          })();
        }
        if (ev.type === 'response.audio_transcript.done' && ev.transcript) {
          addTerminalLine(ev.transcript, 'jarvis-line');
        }
        // Handle function call: GPT-realtime asks us to dispatch to Claude
        if (ev.type === 'response.function_call_arguments.done' && ev.name === 'execute_task') {
          handleRealtimeTask(ev.call_id, ev.arguments);
        }
      } catch {}
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpRes = await fetch('https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
      method: 'POST',
      body: offer.sdp,
      headers: { 'Authorization': `Bearer ${sess.client_secret.value}`, 'Content-Type': 'application/sdp' }
    });
    await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() });

    realtimeActive = true;
    realtimeConnecting = false;
    // Stop wake word listener (Realtime owns the mic now)
    try { if (wakeWordRecognition) { wakeWordRecognition.onend = null; wakeWordRecognition.stop(); } } catch {}
    const btn = document.getElementById('realtime-btn');
    if (btn) { btn.style.color = 'var(--cyan)'; btn.style.background = 'rgba(0,212,255,0.15)'; }
    const cbtn = document.getElementById('continuous-btn');
    if (cbtn) { cbtn.style.color = 'var(--cyan)'; cbtn.style.background = 'rgba(0,212,255,0.1)'; }
    micBtn.classList.add('recording');
  } catch (err) {
    realtimeConnecting = false;
    stopRealtime();
    addTerminalLine(`[warn] Realtime WebRTC falhou (${err.message}) — usando modo STT`, 'warn-line');
    // Auto-fallback: use push-to-talk STT instead
    startRecording();
  }
}

function stopRealtime() {
  realtimeActive = false;
  realtimeConnecting = false;
  try { realtimeDC?.close(); } catch {}
  try { realtimePC?.close(); } catch {}
  try { realtimeStream?.getTracks().forEach(t => t.stop()); } catch {}
  if (realtimeAudio) { realtimeAudio.srcObject = null; realtimeAudio = null; }
  realtimePC = null; realtimeStream = null; realtimeDC = null;
  const btn = document.getElementById('realtime-btn');
  if (btn) { btn.style.color = ''; btn.style.background = ''; }
  const cbtn = document.getElementById('continuous-btn');
  if (cbtn) { cbtn.style.color = ''; cbtn.style.background = ''; }
  micBtn.classList.remove('recording');
  setAvatarState('idle');
  // Resume wake word listening so "jarvis" can reactivate later
  if (wakeWordEnabled) { try { startWakeWord(); } catch {} }
}

// Dispatch Realtime function call to Claude via existing /api/chat, then feed result back
async function handleRealtimeTask(callId, argsJson) {
  let request = '';
  try { request = JSON.parse(argsJson).request || ''; } catch {}
  if (!request) return;

  // Send the function result back to Realtime immediately (keeps conversation flowing)
  if (realtimeDC?.readyState === 'open') {
    realtimeDC.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ status: 'dispatched', message: 'Claude is executing in background' })
      }
    }));
    realtimeDC.send(JSON.stringify({ type: 'response.create' }));
  }

  // Fire Claude in background via /api/chat (non-blocking)
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: request, fromVoice: true, language: currentLang, conclaveEnabled })
    });
    // Stream & render to terminal; completion announcement comes via SSE notification channel
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line && !line.startsWith('[build-start]')) processStreamLine(line);
      }
    }
  } catch (err) {
    addTerminalLine('[error] Claude dispatch: ' + err.message, 'error-line');
  }
}

// When Claude finishes (SSE push), inject completion announcement into Realtime session.
// The message is ALREADY the final sentence to speak — just tell the model to say it verbatim.
// Falls back to TTS if Realtime data channel is dead.
function announceToRealtime(message) {
  // If Realtime DC is alive, inject the message for GPT to speak
  if (realtimeActive && realtimeDC?.readyState === 'open') {
    try {
      const INSTR = {
        BR: `Fale exatamente esta frase ao senhor, sem traduzir nem adicionar nada: "${message}"`,
        ES: `Di exactamente esta frase al señor, sin traducir ni añadir nada: "${message}"`,
        EN: `Say exactly this sentence to the user, do not translate or add anything: "${message}"`
      };
      const instruction = INSTR[currentLang] || INSTR.EN;
      realtimeDC.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: instruction }] }
      }));
      realtimeDC.send(JSON.stringify({ type: 'response.create' }));
      return;
    } catch (e) {
      console.warn('[EVE] Realtime DC send failed, falling back to TTS:', e.message);
    }
  }
  // Fallback: Realtime is supposed to be active but DC is dead — use TTS directly
  if (userGestureReceived) {
    speakResponse(message);
  }
}

function initRealtimeBtn() {
  // Push-to-talk: Realtime only starts when user explicitly clicks mic button.
  // No auto-start, no auto-reconnect. User is in full control.
  // Wake word ("Jarvis") can also activate if enabled in settings.
}

async function startRecording() {
  try {
    userGestureReceived = true;

    // Fast path: Web Speech API — zero latency, no server round-trip
    if (canWebSpeech) {
      const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
      webSpeechRec = new SpeechRec();
      // Language follows the BR/EN toggle
      webSpeechRec.lang = ({ BR: 'pt-BR', ES: 'es-ES', EN: 'en-US' }[currentLang]) || 'en-US';
      webSpeechRec.interimResults = true;
      webSpeechRec.maxAlternatives = 1;
      webSpeechRec.continuous = false;

      let finalSent = false;
      webSpeechRec.onresult = (event) => {
        let interim = '', final = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) final += event.results[i][0].transcript;
          else interim += event.results[i][0].transcript;
        }
        if (interim) chatInput.value = interim;
        if (final && !finalSent) {
          finalSent = true;
          chatInput.value = final;
          stopRecording();
          sendMessage(final.trim(), true);
        }
      };

      webSpeechRec.onerror = (e) => {
        console.warn('[EVE] Web Speech error:', e.error, '— falling back to Whisper');
        isRecording = false;
        micBtn.classList.remove('recording');
        setAvatarState('idle');
        webSpeechRec = null;
      };

      webSpeechRec.onend = () => {
        if (!finalSent) {
          isRecording = false;
          micBtn.classList.remove('recording');
          setAvatarState('idle');
          webSpeechRec = null;
          // Continuous mode: restart after brief pause
          if (continuousMode) {
            continuousTimer = setTimeout(() => startRecording(), 800);
          }
        }
      };

      webSpeechRec.start();
      isRecording = true;
      micBtn.classList.add('recording');
      setAvatarState('listening');
      playTone(1200, 40);
      addTerminalLine('[system] Listening (real-time)...', 'system-line');
      return;
    }

    // Fallback: MediaRecorder + Whisper
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true
      }
    });

    // Set up audio level monitoring
    try {
      const actx = getAudioCtx();
      const source = actx.createMediaStreamSource(stream);
      audioAnalyser = actx.createAnalyser();
      audioAnalyser.fftSize = 512;
      source.connect(audioAnalyser);
      peakVolume = 0;

      const dataArray = new Uint8Array(audioAnalyser.frequencyBinCount);
      const monitorVolume = () => {
        if (!isRecording) return;
        audioAnalyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        if (avg > peakVolume) peakVolume = avg;

        // VAD: auto-stop on sustained silence (after user has spoken)
        const elapsed = Date.now() - recordingStartTime;
        if (elapsed > 1200 && peakVolume > 8) {
          // User spoke at least once — now detect silence
          if (avg < 3) {
            if (!vadTimer) {
              vadTimer = setTimeout(() => {
                if (isRecording) {
                  addTerminalLine('[system] Silence detected — processing...', 'system-line');
                  stopRecording();
                }
              }, VAD_SILENCE_MS);
            }
          } else {
            // Sound detected — reset silence timer
            clearTimeout(vadTimer);
            vadTimer = null;
          }
        }

        requestAnimationFrame(monitorVolume);
      };
      requestAnimationFrame(monitorVolume);
    } catch {}

    // 64kbps: half upload size = ~40% faster Whisper round-trip, quality still excellent for STT
    const recorderOpts = { audioBitsPerSecond: 64000 };
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      recorderOpts.mimeType = 'audio/webm;codecs=opus';
    }

    mediaRecorder = new MediaRecorder(stream, recorderOpts);
    console.log('MediaRecorder:', mediaRecorder.mimeType, recorderOpts.audioBitsPerSecond + 'bps');

    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());

      const duration = Date.now() - recordingStartTime;
      if (duration < 800) {
        addTerminalLine('[warn] Recording too short. Hold the mic button and speak, then click again to stop.', 'warn-line');
        setAvatarState('idle');
        return;
      }

      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      if (blob.size < 1000) {
        addTerminalLine('[warn] No audio captured. Check your microphone.', 'warn-line');
        setAvatarState('idle');
        return;
      }

      if (peakVolume < 5) {
        addTerminalLine('[warn] No voice detected — only silence captured. Speak louder or check mic.', 'warn-line');
        setAvatarState('idle');
        return;
      }

      addTerminalLine(`[system] Audio captured: ${(blob.size / 1024).toFixed(1)}KB, ${(duration / 1000).toFixed(1)}s, peak vol: ${peakVolume.toFixed(0)}`, 'system-line');
      await transcribeAndSend(blob);
    };

    // Single chunk — timeslice fragments corrupt WebM for Whisper
    mediaRecorder.start();
    recordingStartTime = Date.now();
    isRecording = true;
    micBtn.classList.add('recording');
    setAvatarState('listening');
    playTone(1200, 40);
    addTerminalLine('[system] Listening... Click mic again when done speaking.', 'system-line');
  } catch (err) {
    addTerminalLine(`[error] Microphone access denied: ${err.message}`, 'error-line');
    playErrorSound();
  }
}

function stopRecording() {
  clearTimeout(vadTimer); vadTimer = null;
  if (webSpeechRec && isRecording) {
    webSpeechRec.stop();
    isRecording = false;
    micBtn.classList.remove('recording');
    setAvatarState('thinking');
    playTone(800, 40);
    return;
  }
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    micBtn.classList.remove('recording');
    setAvatarState('thinking');
    playTone(800, 40);
  }
}

// After JARVIS finishes responding in continuous mode — restart listening
function scheduleNextListen(delayMs = 1200) {
  if (!continuousMode) return;
  clearTimeout(continuousTimer);
  continuousTimer = setTimeout(() => {
    if (!isRecording && continuousMode) startRecording();
  }, delayMs);
}

async function transcribeAndSend(audioBlob) {
  try {
    setAvatarState('thinking');
    addTerminalLine('[system] Transcribing voice...', 'system-line');

    const formData = new FormData();
    formData.append('audio', audioBlob, 'audio.webm');

    const sttRes = await fetch('/api/stt', { method: 'POST', body: formData });
    if (!sttRes.ok) {
      const err = await sttRes.json().catch(() => ({ error: 'STT failed' }));
      throw new Error(err.error || 'Transcription failed');
    }
    const sttData = await sttRes.json();

    // Handle filtered hallucinations
    if (sttData.filtered) {
      addTerminalLine(`[warn] ${sttData.reason || 'No clear speech detected.'}  Speak clearly and try again.`, 'warn-line');
      setAvatarState('idle');
      return;
    }

    if (!sttData.text || !sttData.text.trim()) {
      addTerminalLine('[warn] No speech detected. Try again.', 'warn-line');
      setAvatarState('idle');
      return;
    }

    // Use sendMessage with fromVoice=true for the optimized pipeline
    await sendMessage(sttData.text, true);
  } catch (err) {
    addTerminalLine(`[error] Voice processing failed: ${err.message}`, 'error-line');
    playErrorSound();
    setAvatarState('idle');
  }
}

// ========== TTS PIPELINE (SERIAL QUEUE — prevents double-voice overlap) ==========
let _ttsQueue = Promise.resolve();
let _currentAudio = null;

function speakResponse(text) {
  // Enqueue — each call waits for the previous to finish before starting
  _ttsQueue = _ttsQueue.then(() => _ttsPlay(text)).catch(() => _ttsPlay(text));
  return _ttsQueue;
}

async function _ttsPlay(text) {
  // Clean text for TTS — remove code blocks, markdown, bracket prefixes
  const cleanText = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/[#*_`~>|]/g, '')
    .replace(/\n+/g, ' ')
    .trim();

  // Split into sentences, max 3 for voice brevity
  const sentences = cleanText
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.trim().length > 5)
    .slice(0, 3);

  if (sentences.length === 0) return;

  // Combine into one TTS call for speed (avoid multiple round-trips)
  const ttsText = sentences.join(' ').slice(0, 500);

  setAvatarState('speaking');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ttsText, language: currentLang, voice: ttsVoice }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.error('TTS failed:', res.status);
      setAvatarState('idle');
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);

    await new Promise((resolve) => {
      const audio = new Audio(url);
      _currentAudio = audio;
      audio.onended = () => { _currentAudio = null; URL.revokeObjectURL(url); resolve(); };
      audio.onerror = () => { _currentAudio = null; URL.revokeObjectURL(url); resolve(); };
      audio.play().catch((e) => {
        console.warn('Audio autoplay blocked:', e.message);
        _currentAudio = null;
        URL.revokeObjectURL(url);
        resolve();
      });
    });
  } catch (err) {
    console.error('TTS error:', err.message);
  }

  setAvatarState('idle');
}

// ========== WAKE WORD DETECTION ==========
let wakeCommandTimer = null;
let wakeListeningForCommand = false;
let wakeAccumulated = '';

function startWakeWord() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) return;
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  wakeWordRecognition = new SpeechRec();
  wakeWordRecognition.continuous = true;
  wakeWordRecognition.interimResults = true;
  wakeWordRecognition.lang = { BR: 'pt-BR', ES: 'es-ES', EN: 'en-US' }[currentLang] || 'pt-BR';

  wakeWordRecognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const isFinal = event.results[i].isFinal;
      const text = event.results[i][0].transcript.toLowerCase().trim();
      const hasWake = /\b(eve|e\.v\.e|evy|ivy|evi|jarvis)\b/.test(text);

      if (hasWake && !isRecording) {
        // Extract command that came AFTER the wake word
        const afterWake = text.replace(/.*?\b(eve|e\.v\.e|evy|ivy|evi|jarvis)\b[,.]?\s*/i, '').trim();

        if (afterWake.length > 3) {
          // Command is in the same phrase — send directly
          playTone(880, 60);
          addTerminalLine(`[wake] ${text}`, 'info-line');
          sendMessage(afterWake, true);
          wakeListeningForCommand = false;
          clearTimeout(wakeCommandTimer);
        } else if (!wakeListeningForCommand) {
          // Just "EVE" alone — open mic for next phrase
          wakeListeningForCommand = true;
          wakeAccumulated = '';
          playTone(880, 60);
          addTerminalLine(
            currentLang === 'BR' ? '[EVE] Ouvindo...' : '[EVE] Listening...',
            'info-line'
          );
          micBtn.classList.add('recording');
          // 6-second window to capture command
          wakeCommandTimer = setTimeout(() => {
            wakeListeningForCommand = false;
            micBtn.classList.remove('recording');
            if (wakeAccumulated.trim().length > 2) {
              sendMessage(wakeAccumulated.trim(), true);
              wakeAccumulated = '';
            }
          }, 6000);
        }
      } else if (wakeListeningForCommand && !hasWake) {
        // Accumulate command after wake word
        if (isFinal) {
          wakeAccumulated += ' ' + text;
          clearTimeout(wakeCommandTimer);
          if (wakeAccumulated.trim().length > 2) {
            wakeListeningForCommand = false;
            micBtn.classList.remove('recording');
            sendMessage(wakeAccumulated.trim(), true);
            wakeAccumulated = '';
          }
        }
      }
    }
  };

  wakeWordRecognition.onerror = (e) => {
    if (e.error !== 'no-speech') console.warn('[EVE] Wake word error:', e.error);
  };
  wakeWordRecognition.onend = () => {
    if (wakeWordEnabled) { try { wakeWordRecognition.start(); } catch {} }
  };
  wakeWordRecognition.start();
}

function stopWakeWord() {
  if (wakeWordRecognition) {
    wakeWordEnabled = false;
    try { wakeWordRecognition.stop(); } catch {}
    wakeWordRecognition = null;
  }
  wakeListeningForCommand = false;
  clearTimeout(wakeCommandTimer);
}

// ========== TAB NAVIGATION ==========
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');

    if (btn.dataset.tab === 'file') loadFiles();
  });
});

// ========== FILE BROWSER ==========
async function loadFiles() {
  try {
    const res = await fetch('/api/files');
    const data = await res.json();
    const fileList = document.getElementById('file-list');

    if (!data.files || data.files.length === 0) {
      fileList.innerHTML = '<div class="file-empty">No files yet. Ask JARVIS to create something.</div>';
      return;
    }

    const icons = {
      '.pdf': '📕', '.md': '📝', '.txt': '📄', '.html': '🌐', '.css': '🎨',
      '.js': '⚡', '.ts': '💠', '.py': '🐍', '.json': '📋', '.png': '🖼️',
      '.jpg': '🖼️', '.jpeg': '🖼️', '.gif': '🖼️', '.svg': '🖼️',
      '.xlsx': '📊', '.pptx': '📽️', '.docx': '📃', '.zip': '📦',
      '.mp3': '🎵', '.mp4': '🎬', '.wav': '🎵'
    };

    // Group by project
    const byProject = {};
    for (const f of data.files) {
      const proj = f.project || 'General';
      if (!byProject[proj]) byProject[proj] = [];
      byProject[proj].push(f);
    }

    fileList.innerHTML = Object.entries(byProject).map(([project, files]) => {
      const items = files.map(f => {
        const icon = icons[f.ext] || '📄';
        const size = f.size > 1024 * 1024
          ? `${(f.size / 1024 / 1024).toFixed(1)} MB`
          : `${(f.size / 1024).toFixed(1)} KB`;
        const date = new Date(f.createdAt).toLocaleDateString();
        return `<div class="file-item">
          <span class="file-item-icon">${icon}</span>
          <div class="file-item-info">
            <div class="file-item-name">${f.name}</div>
            <div class="file-item-meta">${size} · ${date}</div>
          </div>
          <div class="file-item-actions">
            <a href="/api/files/view?path=${encodeURIComponent(f.path)}" target="_blank">Preview</a>
            <a href="${f.downloadUrl}" download>Download</a>
          </div>
        </div>`;
      }).join('');
      return `<div class="file-project-group">
        <div class="file-project-header">${project}</div>
        ${items}
      </div>`;
    }).join('');
  } catch (err) {
    document.getElementById('file-list').innerHTML = '<div class="file-empty">Error loading files.</div>';
  }
}

// ========== ATTACHMENT ==========
fileAttach.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/attach', { method: 'POST', body: formData });
    const data = await res.json();

    currentAttachment = { id: data.attachmentId, name: data.name };
    showAttachmentPreview(data.name);
  } catch (err) {
    addTerminalLine(`[error] Upload failed: ${err.message}`, 'error-line');
  }
  fileAttach.value = '';
});

function showAttachmentPreview(name) {
  removeAttachmentPreview();
  const preview = document.createElement('div');
  preview.className = 'attachment-preview';
  preview.id = 'att-preview';
  preview.innerHTML = `📎 ${name} <button class="remove-att" onclick="removeAttachment()">✕</button>`;
  document.querySelector('.input-bar').insertAdjacentElement('beforebegin', preview);
}

function removeAttachmentPreview() {
  document.getElementById('att-preview')?.remove();
}

function removeAttachment() {
  currentAttachment = null;
  removeAttachmentPreview();
}

// ========== STAT CARD POLLING ==========
async function updateStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();

    const h = Math.floor(data.uptime / 3600000);
    const m = Math.floor((data.uptime % 3600000) / 60000);
    const s = Math.floor((data.uptime % 60000) / 1000);
    document.getElementById('stat-session').textContent =
      `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    document.getElementById('stat-tokens').textContent = data.tokens.toLocaleString();
    document.getElementById('stat-plan').textContent = data.plan;
    document.getElementById('stat-requests').textContent = data.requests;

    // Latency
    const latEl = document.getElementById('stat-latency');
    if (latEl && data.lastLatency) {
      const ms = data.lastLatency;
      latEl.textContent = ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
      latEl.style.color = ms < 800 ? '#00ff88' : ms < 2000 ? '#ffd700' : '#ff4444';
    }

    // Pool health HUD — O=Opus S=Sonnet H=Haiku, number = warm processes ready
    const poolEl = document.getElementById('stat-pool');
    if (poolEl && data.pool) {
      const { opus = 0, sonnet = 0, haiku = 0 } = data.pool;
      poolEl.textContent = `O${opus} S${sonnet} H${haiku}`;
      poolEl.style.color = (opus + sonnet + haiku) > 4 ? '#00ff88' : '#ffd700';
    }
  } catch {}
}

// ========== CLOCK ==========
function updateClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
}

// ========== CONFIG ==========
document.getElementById('save-api-key')?.addEventListener('click', async () => {
  const key = document.getElementById('config-api-key').value;
  if (!key) return;
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'OPENAI_API_KEY', value: key })
    });
    addTerminalLine('[system] API key updated. Restart server for changes to take effect.', 'system-line');
  } catch (err) {
    addTerminalLine(`[error] Failed to save config: ${err.message}`, 'error-line');
  }
});

document.getElementById('config-voice')?.addEventListener('change', (e) => {
  voiceEnabled = e.target.checked;
  addTerminalLine(`[system] Voice ${voiceEnabled ? 'enabled' : 'disabled'}`, 'system-line');
});

document.getElementById('config-wakeword')?.addEventListener('change', (e) => {
  wakeWordEnabled = e.target.checked;
  if (wakeWordEnabled) {
    startWakeWord();
    addTerminalLine('[system] Wake word "EVE" activated', 'system-line');
  } else {
    stopWakeWord();
    addTerminalLine('[system] Wake word deactivated', 'system-line');
  }
});

// TTS Voice selector — persists to localStorage
const ttsVoiceSelect = document.getElementById('config-tts-voice');
if (ttsVoiceSelect) {
  ttsVoiceSelect.value = ttsVoice;
  ttsVoiceSelect.addEventListener('change', (e) => {
    ttsVoice = e.target.value;
    localStorage.setItem('ttsVoice', ttsVoice);
    addTerminalLine(`[info] TTS voice set to: ${ttsVoice}`, 'info-line');
  });
}

// ========== EVENT LISTENERS ==========
sendBtn.addEventListener('click', () => sendMessage(chatInput.value));

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(chatInput.value);
  }
});

micBtn.addEventListener('click', () => {
  userGestureReceived = true;
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

// Terminal direct input
terminal.addEventListener('click', () => chatInput.focus());

// Agent chip click → insert @mention + highlight model
document.querySelectorAll('.agent-chip[data-agent]').forEach(chip => {
  chip.style.cursor = 'pointer';
  chip.addEventListener('click', () => {
    const agent = chip.dataset.agent;
    const mention = `@${agent} `;
    const input = document.getElementById('chat-input');
    if (!input.value.startsWith('@')) {
      input.value = mention + input.value;
    } else {
      input.value = mention;
    }
    input.focus();
    setModelFromAgent(chip);
    // Visual feedback
    document.querySelectorAll('.agent-chip').forEach(c => c.classList.remove('active-agent'));
    chip.classList.add('active-agent');
  });
});

// ========== INIT ==========
updateClock();
setInterval(updateClock, 1000);
setInterval(updateStats, 4000);
updateStats();
initLangToggle();
initConclaveToggle();
initContinuousBtn();
initRealtimeBtn();

// Wake word ON by default — user just says "EVE" to activate
wakeWordEnabled = true;
setTimeout(() => {
  try { startWakeWord(); } catch {}
}, 1500);


// ── PUSH NOTIFICATION CHANNEL ──────────────────────────────────────────────
// Listens for Claude build completions. GPT-mini generates the message server-side
// and pushes it here — frontend speaks it automatically via TTS.
(function initNotifications() {
  const es = new EventSource('/api/notifications');
  es.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      if (payload.type === 'build-complete' && payload.message) {
        addTerminalLine(`[info] ✓ ${payload.message}`, 'info-line');
        console.log('[EVE] Build complete notification received:', payload.message);
        // Route to Realtime when active (GPT-realtime speaks the completion); otherwise use TTS
        // announceToRealtime has its own fallback to TTS if DC is dead
        if (realtimeActive) {
          announceToRealtime(payload.message);
        } else if (userGestureReceived) {
          speakResponse(payload.message);
        }
      }
    } catch {}
  };
  es.onerror = () => { /* silent reconnect handled by browser */ };
})();

// ── PRE-FLIGHT VERIFICATION ──────────────────────────────────────────────
// Runs on first visit (or if user cleared localStorage). Tests all systems.
(async function runPreflight() {
  const PREFLIGHT_KEY = 'eve_preflight_passed';
  const overlay = document.getElementById('preflight-overlay');
  if (!overlay) return;

  // Skip if already passed (unless Shift held during load for re-check)
  if (localStorage.getItem(PREFLIGHT_KEY) && !window._forcePreflightRecheck) {
    overlay.style.display = 'none';
    return;
  }

  overlay.style.display = 'flex';

  try {
    const res = await fetch('/api/health/preflight', { method: 'POST' });
    const data = await res.json();

    // Update each check item
    for (const [key, result] of Object.entries(data.results)) {
      const el = document.querySelector(`.pf-item[data-key="${key}"]`);
      if (!el) continue;
      const icon = el.querySelector('.pf-icon');
      if (result.status === 'ok') {
        icon.textContent = '✅';
        el.classList.add('pf-ok');
      } else {
        icon.textContent = '❌';
        el.classList.add('pf-err');
        el.setAttribute('data-detail', result.detail || 'Unknown error');
      }
    }

    // Collect failed issues for auto-fix
    const failedIssues = [];
    for (const [key, result] of Object.entries(data.results)) {
      if (result.status !== 'ok') {
        failedIssues.push({ key, detail: result.detail || 'Unknown error' });
      }
    }

    // Show result
    const resultDiv = document.getElementById('preflight-result');
    const msgEl = document.getElementById('preflight-msg');
    const okBtn = document.getElementById('preflight-ok');
    const retryBtn = document.getElementById('preflight-retry');
    resultDiv.style.display = 'block';

    // Ensure autofix button exists
    let fixBtn = document.getElementById('preflight-autofix');
    if (!fixBtn) {
      fixBtn = document.createElement('button');
      fixBtn.id = 'preflight-autofix';
      fixBtn.style.cssText = 'background:linear-gradient(135deg,#00d4ff,#00ff88);color:#000;border:none;padding:10px 28px;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;margin-left:8px;';
      fixBtn.textContent = 'Corrigir Automaticamente';
      retryBtn.parentElement.appendChild(fixBtn);
    }

    // Ensure autofix log area exists
    let fixLog = document.getElementById('preflight-fixlog');
    if (!fixLog) {
      fixLog = document.createElement('div');
      fixLog.id = 'preflight-fixlog';
      fixLog.style.cssText = 'display:none;margin-top:14px;background:#060a1a;border:1px solid #1a3a5c;border-radius:8px;padding:12px;max-height:180px;overflow-y:auto;font-family:"JetBrains Mono",monospace;font-size:10px;color:#c9d1d9;white-space:pre-wrap;word-break:break-all;';
      resultDiv.appendChild(fixLog);
    }

    if (data.status === 'ready') {
      msgEl.textContent = 'Todos os sistemas operacionais. EVE esta pronta.';
      msgEl.style.color = '#00ff88';
      okBtn.textContent = 'Iniciar EVE';
      okBtn.style.background = '#00d4ff';
      okBtn.style.display = 'inline-block';
      retryBtn.style.display = 'none';
      fixBtn.style.display = 'none';
    } else {
      msgEl.textContent = 'Problemas detectados. EVE pode funcionar com recursos limitados.';
      msgEl.style.color = '#ffaa00';
      okBtn.textContent = 'Continuar Assim';
      okBtn.style.background = '#555';
      okBtn.style.display = 'inline-block';
      retryBtn.style.display = 'inline-block';
      // Show auto-fix only if Claude CLI is available
      const claudeOk = data.results.claude_cli?.status === 'ok';
      fixBtn.style.display = claudeOk ? 'inline-block' : 'none';
    }

    okBtn.onclick = () => {
      localStorage.setItem(PREFLIGHT_KEY, Date.now().toString());
      overlay.style.display = 'none';
    };

    retryBtn.onclick = () => {
      document.querySelectorAll('.pf-item').forEach(el => {
        el.classList.remove('pf-ok', 'pf-err');
        el.removeAttribute('data-detail');
        el.querySelector('.pf-icon').textContent = '⏳';
      });
      resultDiv.style.display = 'none';
      fixLog.style.display = 'none';
      fixLog.textContent = '';
      window._forcePreflightRecheck = true;
      runPreflight();
    };

    fixBtn.onclick = async () => {
      // Disable buttons during fix
      fixBtn.disabled = true;
      fixBtn.textContent = 'Corrigindo...';
      fixBtn.style.opacity = '0.6';
      retryBtn.disabled = true;
      okBtn.disabled = true;
      fixLog.style.display = 'block';
      fixLog.textContent = '[EVE] Acionando Claude para corrigir problemas...\n\n';

      try {
        const fixRes = await fetch('/api/health/autofix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ issues: failedIssues })
        });

        const reader = fixRes.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          fixLog.textContent += chunk;
          fixLog.scrollTop = fixLog.scrollHeight;
        }

        fixLog.textContent += '\n\n[EVE] Correcao concluida. Executando verificacao novamente...\n';

        // Wait 2s then re-run preflight
        await new Promise(r => setTimeout(r, 2000));
        document.querySelectorAll('.pf-item').forEach(el => {
          el.classList.remove('pf-ok', 'pf-err');
          el.removeAttribute('data-detail');
          el.querySelector('.pf-icon').textContent = '⏳';
        });
        resultDiv.style.display = 'none';
        fixLog.style.display = 'none';
        fixLog.textContent = '';
        window._forcePreflightRecheck = true;
        runPreflight();

      } catch (err) {
        fixLog.textContent += `\n[ERRO] ${err.message}\n`;
        fixBtn.disabled = false;
        fixBtn.textContent = 'Corrigir Automaticamente';
        fixBtn.style.opacity = '1';
        retryBtn.disabled = false;
        okBtn.disabled = false;
      }
    };
  } catch (e) {
    // Server not reachable
    const resultDiv = document.getElementById('preflight-result');
    const msgEl = document.getElementById('preflight-msg');
    resultDiv.style.display = 'block';
    msgEl.textContent = '❌ Cannot reach EVE server. Is it running?';
    msgEl.style.color = '#ff4444';
  }
})();
