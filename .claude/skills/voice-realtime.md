# VOICE REAL-TIME SKILL — World-Class Voice AI (2026)

> Activate when building, optimizing, or debugging voice features.

---

## ARCHITECTURE — Cascading vs Real-Time

| Mode | Pipeline | Latency | When |
|------|----------|---------|------|
| **Cascading** (current) | STT → LLM → TTS | 1–3s | Claude CLI with subscription |
| **Real-Time S2S** | WebRTC → GPT-4o Realtime | 300–800ms | OpenAI key available |
| **Hybrid** | Web Speech + streaming TTS | 200–600ms | Best of both worlds |

**JARVIS uses Hybrid** — Web Speech API (zero latency STT) + streaming Claude + sentence TTS.

---

## LATENCY BUDGET — Target < 800ms voice-to-voice

```
User stops speaking
→ VAD detects silence:     0ms   (instant, local)
→ Web Speech final:       50ms   (Chrome native)
→ ACK sent to user:       ~0ms  (instant string)
→ Claude first token:    300ms   (streaming)
→ First sentence TTS:    150ms   (OpenAI onyx/nova)
→ Audio playback starts: 100ms   (browser decode)
────────────────────────────────
Total first audio:        ~600ms ✅
```

---

## VAD — Voice Activity Detection

### Current implementation (Web Audio API)
```javascript
// Silence detection: stop after VAD_SILENCE_MS of silence post-speech
const VAD_SILENCE_MS = 1800; // 1.8s — natural pause threshold
const SPEECH_THRESHOLD = 8;  // volume unit — above = speech
const MIN_RECORD_MS = 1200;  // don't trigger VAD before 1.2s
```

### Tuning guide
| Scenario | VAD_SILENCE_MS | SPEECH_THRESHOLD |
|----------|---------------|-----------------|
| Noisy environment | 2500ms | 15 |
| Quiet room | 1500ms | 5 |
| Phone call | 2000ms | 12 |
| Fast speaker | 1200ms | 8 |

---

## STREAMING TTS — Sentence Chunking

Fire TTS on the **first complete sentence** from Claude's stream — don't wait for full response:

```javascript
// Target: fire TTS within 150ms of first sentence boundary
const sentMatch = streamTtsBuffer.match(/^(.{15,}?[.!?])[\s\n]/);
//                                        ^^^^ min 15 chars to avoid "OK." false fires
if (sentMatch) {
  streamTtsFired = true;
  speakResponse(sentMatch[1].trim()); // non-blocking, fires immediately
}
```

---

## CONTINUOUS MODE — Hands-Free Loop

Flow:
```
User speaks → VAD stops → STT → LLM → TTS → [1.5s pause] → Listen again
```

Implementation:
- `continuousMode` flag gates the loop
- `scheduleNextListen(1500)` called after every response
- Button in UI to toggle (⊕ mic icon)
- Auto-cancelled when user types

---

## VOICE QUALITY — Audio Engineering

### STT optimization
```javascript
// Whisper optimal settings
audioBitsPerSecond: 64000  // 64kbps — 50% smaller, same STT accuracy
mimeType: 'audio/webm;codecs=opus'  // Opus: best quality/size ratio
echoCancellation: false  // Whisper handles noise better without browser processing
noiseSuppression: false  // same reason
autoGainControl: true    // keep — normalizes volume
```

### TTS voice selection
| Language | Voice | Character |
|----------|-------|-----------|
| EN | `onyx` | Deep, authoritative — perfect for JARVIS |
| BR | `nova` | Natural, warm Portuguese |
| EN alt | `echo` | Younger, tech feel |
| EN alt | `fable` | Storytelling, dramatic |

---

## UPGRADE PATH — OpenAI Realtime API (future)

When OpenAI key budget allows, upgrade to native S2S:

```javascript
// Single WebSocket — no STT/TTS round trips
const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
  headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'OpenAI-Beta': 'realtime=v1' }
});

// Send audio chunks as they arrive (no wait for silence)
ws.send(JSON.stringify({
  type: 'input_audio_buffer.append',
  audio: base64AudioChunk
}));

// Receive audio response chunks immediately
ws.on('message', ({ type, delta }) => {
  if (type === 'response.audio.delta') playAudioChunk(delta);
});
```

Target latency: **300–500ms** voice-to-voice (vs current ~800ms).

---

## ANTI-PATTERNS — Never Do These

- ❌ Wait for full LLM response before TTS — always chunk at sentence boundary
- ❌ 128kbps audio for STT — 64kbps is identical accuracy, 50% faster upload
- ❌ Blocking UI during voice — ACK + async TTS always
- ❌ Single language STT — always match STT lang to UI lang
- ❌ Manual stop only — VAD is mandatory for natural conversation
- ❌ `noiseSuppression: true` with Whisper — Whisper handles noise better natively
