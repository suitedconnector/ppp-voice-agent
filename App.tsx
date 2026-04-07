
import React, { useState, useRef } from 'react';
import { ConnectionStatus, Message, ConsultationDetails, Language, VoicePhase } from './types';
import VoiceVisualizer from './components/VoiceVisualizer';

const langCode: Record<Language, string> = {
  English: 'en-US',
  Spanish: 'es-ES',
  German: 'de-DE',
};

type ChatMessage = { role: 'user' | 'assistant'; content: string };

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.IDLE);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [consultation, setConsultation] = useState<Partial<ConsultationDetails> | null>(null);
  const [language, setLanguage] = useState<Language>('English');

  const recognitionRef = useRef<any>(null);
  const historyRef = useRef<ChatMessage[]>([]);
  const isConnectedRef = useRef(false);
  const isProcessingRef = useRef(false);

  // Silence-debounce: accumulated final transcript fragments and the pending submit timer.
  // Chrome fires isFinal after ~1s of silence; our 2s debounce gives ~3s total before submit,
  // which is enough for mid-sentence pauses like phone numbers ("555... 867... 5309").
  const pendingTranscriptRef = useRef('');
  const submitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SUBMIT_DEBOUNCE_MS = 2000;

  // Single AudioContext created on the first user gesture and reused for every playback.
  // This is the only reliable way to play audio on Chrome mobile: resume() in the gesture
  // permanently unlocks the context; all async decoding/playback thereafter is allowed.
  const audioCtxRef = useRef<AudioContext | null>(null);
  // Currently playing source node — kept so we can stop it on disconnect.
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);

  // Streaming audio queue: each entry is a Promise<AudioBuffer> (already decoded).
  // Fetch + decode starts immediately when a sentence arrives, concurrent with playback,
  // so the next sentence is ready the instant the current one ends.
  const audioQueueRef = useRef<Array<Promise<AudioBuffer>>>([]);
  const isPlayingAudioRef = useRef(false);
  // Set to true when the SSE 'done' event fires; triggers mic restart once queue drains.
  const streamDoneRef = useRef(false);

  const clearHistory = () => setMessages([]);

  const connectVoice = async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      setErrorMessage('');

      const SpeechRecognitionCtor =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SpeechRecognitionCtor) {
        throw new Error('Speech recognition is not supported in this browser.');
      }

      historyRef.current = [];
      isConnectedRef.current = true;
      isProcessingRef.current = false;
      audioQueueRef.current = [];
      isPlayingAudioRef.current = false;
      streamDoneRef.current = false;

      // ── AudioContext unlock (must happen inside the user gesture) ──────────
      // Create once; if it already exists from a previous session, just resume it.
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      await audioCtxRef.current.resume(); // unlocks the context on mobile

      const recognition = new SpeechRecognitionCtor();
      recognition.lang = langCode[language];
      recognition.continuous = true;
      recognition.interimResults = true;
      recognitionRef.current = recognition;

      // ── Mic control ────────────────────────────────────────────────────────

      const startListening = () => {
        if (!isConnectedRef.current || isProcessingRef.current) return;
        // Clear any stale debounce state from the previous turn.
        pendingTranscriptRef.current = '';
        if (submitTimerRef.current) { clearTimeout(submitTimerRef.current); submitTimerRef.current = null; }
        setPhase('listening');
        try { recognition.start(); } catch (_) { /* already running */ }
      };

      const stopListening = () => {
        // Cancel any pending debounced submit — the turn is being interrupted or processed.
        if (submitTimerRef.current) { clearTimeout(submitTimerRef.current); submitTimerRef.current = null; }
        pendingTranscriptRef.current = '';
        try { recognition.stop(); } catch (_) {}
      };

      // ── Stream / audio coordination ────────────────────────────────────────

      /**
       * Called when the audio queue drains OR when the SSE 'done' event fires.
       * Re-enables the mic only once BOTH conditions are true.
       */
      const checkAndRestartListening = () => {
        if (
          streamDoneRef.current &&
          !isPlayingAudioRef.current &&
          audioQueueRef.current.length === 0
        ) {
          streamDoneRef.current = false;
          isProcessingRef.current = false;
          startListening();
        }
      };

      /**
       * Plays the next AudioBuffer from the queue.
       * The buffer was already decoded by enqueueTTS, so this path is synchronous
       * after the await — source.start() fires immediately with no decode gap.
       * Runs recursively until the queue is empty, then restores the mic.
       */
      const playNextInQueue = async () => {
        if (audioQueueRef.current.length === 0) {
          isPlayingAudioRef.current = false;
          checkAndRestartListening();
          return;
        }

        isPlayingAudioRef.current = true;
        setPhase('speaking');

        // Each entry is a Promise<AudioBuffer> — decode started in enqueueTTS,
        // so this await is near-instant for any sentence that arrived before the
        // previous one finished playing.
        const audioBufferPromise = audioQueueRef.current.shift()!;

        try {
          const audioBuffer = await audioBufferPromise;
          if (!isConnectedRef.current) {
            isPlayingAudioRef.current = false;
            return;
          }
          const ctx = audioCtxRef.current!;
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(ctx.destination);
          audioSourceRef.current = source;
          source.onended = () => {
            audioSourceRef.current = null;
            playNextInQueue();
          };
          source.start();
        } catch (err) {
          console.error('[playNextInQueue]', err);
          audioSourceRef.current = null;
          playNextInQueue();
        }
      };

      /**
       * Kicks off a TTS fetch + decode for `text` immediately (concurrent with any
       * ongoing playback). By the time the current sentence ends, the next AudioBuffer
       * is already decoded and ready — source.start() fires with near-zero gap.
       */
      const enqueueTTS = (text: string) => {
        if (!text.trim() || !isConnectedRef.current) return;

        // Capture ctx synchronously — it's always set before any sentence arrives.
        const ctx = audioCtxRef.current!;

        const audioBufferPromise = fetch('/api/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })
          .then(r => {
            if (!r.ok) throw new Error(`TTS ${r.status}`);
            return r.arrayBuffer();
          })
          .then(ab => ctx.decodeAudioData(ab)); // decode immediately, not at play time

        audioQueueRef.current.push(audioBufferPromise);

        if (!isPlayingAudioRef.current) {
          playNextInQueue();
        }
      };

      // ── Main chat function ─────────────────────────────────────────────────

      const callChat = async (userText: string, hideFromTranscript = false) => {
        // Reset queue state for this turn
        if (audioSourceRef.current) {
          try { audioSourceRef.current.stop(); } catch {}
          audioSourceRef.current = null;
        }
        audioQueueRef.current = [];
        isPlayingAudioRef.current = false;
        streamDoneRef.current = false;
        isProcessingRef.current = true;

        // Re-check context once per turn (mobile browsers can auto-suspend it during silence).
        if (audioCtxRef.current?.state === 'suspended') await audioCtxRef.current.resume();

        setPhase('thinking');
        historyRef.current.push({ role: 'user', content: userText });
        if (!hideFromTranscript) {
          setMessages(prev => [...prev, { role: 'user', text: userText, timestamp: Date.now() }]);
        }

        let fullResponseText = '';

        try {
          const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: historyRef.current, language }),
          });

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Chat API error ${res.status}: ${errText}`);
          }

          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let lineBuffer = '';
          let currentEvent = '';

          const handleEvent = (eventType: string, data: any) => {
            switch (eventType) {
              case 'sentence':
                if (data.text) enqueueTTS(data.text);
                break;

              case 'toolCall':
                if (data.toolCall) {
                  setConsultation(data.toolCall);
                  setMessages(prev => [...prev, {
                    role: 'assistant',
                    text: `[SYSTEM] Consultation captured for ${data.toolCall.name} — ${data.toolCall.legalIssue}.`,
                    timestamp: Date.now(),
                  }]);
                }
                break;

              case 'done':
                fullResponseText = data.fullText ?? '';
                if (fullResponseText) {
                  historyRef.current.push({ role: 'assistant', content: fullResponseText });
                  setMessages(prev => [...prev, {
                    role: 'assistant',
                    text: fullResponseText,
                    timestamp: Date.now(),
                  }]);
                }
                streamDoneRef.current = true;
                checkAndRestartListening();
                break;

              case 'error':
                throw new Error(data.message ?? 'Stream error');
            }
          };

          // Consume the SSE stream
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            lineBuffer += decoder.decode(value, { stream: true });
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() ?? '';

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                currentEvent = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                const raw = line.slice(6).trim();
                if (!raw) continue;
                let data: any;
                try { data = JSON.parse(raw); } catch { continue; }
                handleEvent(currentEvent, data);
                currentEvent = '';
              } else if (line.trim() === '') {
                currentEvent = '';
              }
            }
          }

          // Process any final partial line
          if (lineBuffer.startsWith('data: ')) {
            const raw = lineBuffer.slice(6).trim();
            if (raw) {
              try { handleEvent(currentEvent, JSON.parse(raw)); } catch {}
            }
          }

        } catch (err) {
          console.error('[callChat]', err);
          setErrorMessage(err instanceof Error ? err.message : String(err));
          setStatus(ConnectionStatus.ERROR);
          isConnectedRef.current = false;
          isProcessingRef.current = false;
          setPhase('idle');
        }
      };

      // ── SpeechRecognition handlers ─────────────────────────────────────────

      recognition.onresult = (event: any) => {
        if (isProcessingRef.current) return;

        let hasInterim = false;
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            // Accumulate — don't submit yet; the user may resume after a pause.
            const piece = event.results[i][0].transcript;
            pendingTranscriptRef.current +=
              (pendingTranscriptRef.current ? ' ' : '') + piece;
          } else {
            hasInterim = true;
          }
        }

        // Any speech activity (interim OR new final fragment) resets the silence timer.
        // The timer fires only after SUBMIT_DEBOUNCE_MS of true silence.
        if (pendingTranscriptRef.current.trim()) {
          if (hasInterim || pendingTranscriptRef.current) {
            if (submitTimerRef.current) clearTimeout(submitTimerRef.current);
            submitTimerRef.current = setTimeout(() => {
              submitTimerRef.current = null;
              const text = pendingTranscriptRef.current.trim();
              pendingTranscriptRef.current = '';
              if (text && !isProcessingRef.current) {
                stopListening();
                callChat(text);
              }
            }, SUBMIT_DEBOUNCE_MS);
          }
        }
      };

      recognition.onerror = (event: any) => {
        // Transient errors: let onend fire and restart recognition automatically.
        if (event.error === 'no-speech' || event.error === 'aborted' || event.error === 'network') return;
        console.error('Recognition error:', event.error);
        setErrorMessage(`Speech recognition error: ${event.error}`);
        setStatus(ConnectionStatus.ERROR);
        isConnectedRef.current = false;
        setPhase('idle');
      };

      recognition.onend = () => {
        if (isConnectedRef.current && !isProcessingRef.current) {
          setTimeout(startListening, 300);
        }
      };

      // ── Initial greeting ───────────────────────────────────────────────────

      setStatus(ConnectionStatus.CONNECTED);
      await callChat('Hello.', true); // hide "Hello." from the transcript

    } catch (err) {
      console.error('Connection failed:', err);
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus(ConnectionStatus.ERROR);
      setPhase('idle');
    }
  };

  const disconnectVoice = () => {
    isConnectedRef.current = false;
    streamDoneRef.current = false;
    audioQueueRef.current = [];
    isPlayingAudioRef.current = false;
    if (submitTimerRef.current) { clearTimeout(submitTimerRef.current); submitTimerRef.current = null; }
    pendingTranscriptRef.current = '';
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    if (audioSourceRef.current) {
      try { audioSourceRef.current.stop(); } catch {}
      audioSourceRef.current = null;
    }
    // Keep audioCtxRef alive — resume() on next connect re-unlocks it instantly.
    setStatus(ConnectionStatus.IDLE);
    setPhase('idle');
  };

  const languages: Language[] = ['English', 'Spanish', 'German'];

  const phaseLabel: Record<VoicePhase, string> = {
    listening: `Listening in ${language}... speak now`,
    thinking: 'Thinking...',
    speaking: 'Jazmin is speaking...',
    idle: '',
  };

  const phaseColor: Record<VoicePhase, string> = {
    listening: 'text-green-600',
    thinking: 'text-yellow-600',
    speaking: 'text-blue-600',
    idle: 'text-gray-500',
  };

  const phaseDot: Record<VoicePhase, string> = {
    listening: 'bg-green-500',
    thinking: 'bg-yellow-500',
    speaking: 'bg-blue-500',
    idle: '',
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row overflow-hidden bg-white">
      <div className="flex-1 flex flex-col items-center justify-center p-8 relative border-r border-black/5">
        <header className="absolute top-8 text-center">
          <h1 className="cinzel text-4xl font-bold text-[#1d4ed8] mb-2">Potter Padilla & Pfau</h1>
          <p className="text-gray-500 tracking-widest uppercase text-xs">Legal AI Concierge</p>
        </header>

        <VoiceVisualizer isActive={phase === 'listening'} isSpeaking={phase === 'speaking'} />

        <div className="mt-12 text-center space-y-6 w-full max-w-sm">
          <div className="flex justify-center space-x-2 mb-4">
            {languages.map((lang) => (
              <button
                key={lang}
                onClick={() => setLanguage(lang)}
                disabled={status !== ConnectionStatus.IDLE}
                className={`px-3 py-1 rounded-full text-[10px] uppercase tracking-tighter transition-all ${
                  language === lang
                    ? 'bg-[#1d4ed8] text-white shadow-lg shadow-[#1d4ed8]/20'
                    : 'bg-black/5 text-gray-500 hover:text-gray-800'
                } ${status !== ConnectionStatus.IDLE ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {lang}
              </button>
            ))}
          </div>

          <div className="glass-panel px-6 py-4 rounded-2xl mx-auto min-h-[64px] flex items-center justify-center">
            {status === ConnectionStatus.IDLE && (
              <p className="text-gray-600 text-sm">
                {language === 'English' && "Welcome to Potter Padilla & Pfau. I'm here to find out about your legal situation and help schedule your free consultation."}
                {language === 'Spanish' && "Bienvenido a Potter Padilla & Pfau. Estoy aquí para conocer su situación legal y ayudarle a programar su consulta gratuita."}
                {language === 'German' && "Willkommen bei Potter Padilla & Pfau. Ich bin hier, um mehr über Ihre rechtliche Situation zu erfahren und Ihnen bei der Vereinbarung Ihrer kostenlosen Beratung zu helfen."}
              </p>
            )}
            {status === ConnectionStatus.CONNECTED && phase !== 'idle' && (
              <div className="flex items-center gap-2">
                <span className="relative flex h-3 w-3 flex-shrink-0">
                  <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${phaseDot[phase]}`} />
                  <span className={`relative inline-flex rounded-full h-3 w-3 ${phaseDot[phase]}`} />
                </span>
                <p className={`text-sm font-medium ${phaseColor[phase]}`}>{phaseLabel[phase]}</p>
              </div>
            )}
            {status === ConnectionStatus.CONNECTING && (
              <p className="text-gray-500 text-sm animate-pulse">Connecting...</p>
            )}
            {status === ConnectionStatus.ERROR && (
              <div className="text-red-600 text-sm">
                <p>Connection failed. Please check permissions and try again.</p>
                {errorMessage && <p className="mt-2 text-xs opacity-80">{errorMessage}</p>}
              </div>
            )}
          </div>

          <button
            onClick={status === ConnectionStatus.CONNECTED ? disconnectVoice : connectVoice}
            disabled={status === ConnectionStatus.CONNECTING}
            className={`w-full px-12 py-4 rounded-full font-semibold transition-all duration-300 transform hover:scale-105 shadow-2xl ${
              status === ConnectionStatus.CONNECTED
                ? 'bg-red-600/20 text-red-400 border border-red-500/50 hover:bg-red-600/30'
                : 'bg-[#1d4ed8] text-white hover:bg-blue-600 shadow-[#1d4ed8]/40'
            }`}
          >
            {status === ConnectionStatus.CONNECTED
              ? 'End Conversation'
              : status === ConnectionStatus.CONNECTING
              ? 'Connecting...'
              : 'Ask a Question'}
          </button>
        </div>

        {consultation && (
          <div className="mt-8 glass-panel p-6 rounded-2xl border-[#1d4ed8]/30 w-full max-w-md animate-in fade-in slide-in-from-bottom-4">
            <h3 className="serif text-xl text-[#1d4ed8] mb-4">Consultation Request Details</h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-gray-500 uppercase text-[10px]">Client Name</p>
                <p className="font-medium text-gray-900">{consultation.name}</p>
              </div>
              <div>
                <p className="text-gray-500 uppercase text-[10px]">Legal Issue</p>
                <p className="font-medium text-gray-900">{consultation.legalIssue}</p>
              </div>
              <div>
                <p className="text-gray-500 uppercase text-[10px]">Phone</p>
                <p className="font-medium text-gray-900">{consultation.phone}</p>
              </div>
              <div>
                <p className="text-gray-500 uppercase text-[10px]">Preferred Date</p>
                <p className="font-medium text-gray-900">{consultation.preferredDate || 'Not specified'}</p>
              </div>
            </div>
            <button
              onClick={() => setConsultation(null)}
              className="mt-6 w-full py-2 bg-[#1d4ed8]/10 text-[#1d4ed8] rounded-lg border border-[#1d4ed8]/20 hover:bg-[#1d4ed8]/20 transition-colors"
            >
              Confirm & Clear
            </button>
          </div>
        )}
      </div>

      <div className="w-full md:w-[400px] flex flex-col glass-panel border-l border-black/5">
        <div className="p-6 border-b border-black/5 flex justify-between items-center bg-gray-50/50">
          <h2 className="serif text-xl text-gray-900">Transcripts</h2>
          <button onClick={clearHistory} className="text-xs text-gray-500 hover:text-gray-800 transition-colors">Clear History</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center text-gray-600 space-y-4">
              <div className="w-12 h-12 rounded-full border border-gray-200 flex items-center justify-center">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
              </div>
              <p className="text-sm">Your conversation will appear here in real-time.</p>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className={`max-w-[85%] rounded-2xl p-4 text-sm ${
                  m.role === 'user'
                    ? 'bg-blue-50 text-blue-900 border border-blue-100 rounded-tr-none'
                    : 'bg-gray-100 text-gray-800 border border-gray-200 rounded-tl-none'
                }`}>
                  <p>{m.text}</p>
                  <span className="text-[10px] text-gray-500 mt-2 block opacity-50">
                    {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        <footer className="p-6 border-t border-black/5 bg-gray-50/50 text-[10px] text-gray-500 text-center uppercase tracking-widest flex flex-col gap-2">
          <span className="cinzel">Potter Padilla & Pfau &bull; Attorneys at Law</span>
          <span className="text-[#1d4ed8]/70 normal-case tracking-normal">This is not legal advice.</span>
        </footer>
      </div>
    </div>
  );
};

export default App;
