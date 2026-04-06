
import React, { useState, useRef } from 'react';
import { ConnectionStatus, Message, ConsultationDetails, Language } from './types';
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
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [consultation, setConsultation] = useState<Partial<ConsultationDetails> | null>(null);
  const [language, setLanguage] = useState<Language>('English');

  const recognitionRef = useRef<any>(null);
  const historyRef = useRef<ChatMessage[]>([]);
  const isConnectedRef = useRef(false);
  const isProcessingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

      const recognition = new SpeechRecognitionCtor();
      recognition.lang = langCode[language];
      recognition.continuous = true;
      recognition.interimResults = true;
      recognitionRef.current = recognition;

      const startListening = () => {
        if (!isConnectedRef.current || isProcessingRef.current) return;
        try { recognition.start(); } catch (_) { /* already running */ }
      };

      const stopListening = () => {
        try { recognition.stop(); } catch (_) {}
      };

      const speak = async (text: string, onEnd?: () => void) => {
        stopListening();
        if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
        setIsSpeaking(true);
        try {
          const res = await fetch('/api/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
          });
          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Speak API error ${res.status}: ${errText}`);
          }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = () => { setIsSpeaking(false); URL.revokeObjectURL(url); audioRef.current = null; onEnd?.(); };
          audio.onerror = (e) => { console.error('[speak] audio error:', e); setIsSpeaking(false); URL.revokeObjectURL(url); audioRef.current = null; onEnd?.(); };
          await audio.play();
        } catch (err) {
          console.error('[speak] error:', err);
          setIsSpeaking(false);
          onEnd?.();
        }
      };

      const callChat = async (userText: string) => {
        isProcessingRef.current = true;
        historyRef.current.push({ role: 'user', content: userText });
        setMessages(prev => [...prev, { role: 'user', text: userText, timestamp: Date.now() }]);

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

          const data = await res.json() as {
            text: string;
            toolCall?: ConsultationDetails;
          };

          if (data.toolCall) {
            setConsultation(data.toolCall);
            setMessages(prev => [...prev, {
              role: 'assistant',
              text: `[SYSTEM] Consultation details captured for ${data.toolCall!.name} regarding ${data.toolCall!.legalIssue}.`,
              timestamp: Date.now(),
            }]);
          }

          if (data.text) {
            historyRef.current.push({ role: 'assistant', content: data.text });
            setMessages(prev => [...prev, { role: 'assistant', text: data.text, timestamp: Date.now() }]);
            speak(data.text, () => { isProcessingRef.current = false; startListening(); });
          } else {
            isProcessingRef.current = false;
            startListening();
          }
        } catch (err) {
          console.error('[callChat] error:', err);
          setErrorMessage(err instanceof Error ? err.message : String(err));
          setStatus(ConnectionStatus.ERROR);
          isConnectedRef.current = false;
          isProcessingRef.current = false;
        }
      };

      recognition.onresult = (event: any) => {
        if (isProcessingRef.current) return;
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          }
        }
        if (finalTranscript.trim()) {
          stopListening();
          callChat(finalTranscript.trim());
        }
      };

      recognition.onerror = (event: any) => {
        if (event.error === 'no-speech' || event.error === 'aborted') return;
        console.error('Recognition error:', event.error);
        setErrorMessage(`Speech recognition error: ${event.error}`);
        setStatus(ConnectionStatus.ERROR);
        isConnectedRef.current = false;
      };

      recognition.onend = () => {
        if (isConnectedRef.current && !isProcessingRef.current) {
          setTimeout(startListening, 300);
        }
      };

      setStatus(ConnectionStatus.CONNECTED);

      // Initial greeting
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello.' }],
          language,
        }),
      });

      const greeting = await res.json() as { text: string };
      if (greeting.text) {
        historyRef.current.push({ role: 'user', content: 'Hello.' });
        historyRef.current.push({ role: 'assistant', content: greeting.text });
        setMessages(prev => [...prev, { role: 'assistant', text: greeting.text, timestamp: Date.now() }]);
        speak(greeting.text, startListening);
      } else {
        startListening();
      }
    } catch (err) {
      console.error('Connection failed:', err);
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus(ConnectionStatus.ERROR);
    }
  };

  const disconnectVoice = () => {
    isConnectedRef.current = false;
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setStatus(ConnectionStatus.IDLE);
    setIsSpeaking(false);
  };

  const languages: Language[] = ['English', 'Spanish', 'German'];

  return (
    <div className="min-h-screen flex flex-col md:flex-row overflow-hidden bg-white">
      <div className="flex-1 flex flex-col items-center justify-center p-8 relative border-r border-black/5">
        <header className="absolute top-8 text-center">
          <h1 className="cinzel text-4xl font-bold text-[#1d4ed8] mb-2">Potter Padilla & Pfau</h1>
          <p className="text-gray-500 tracking-widest uppercase text-xs">Legal AI Concierge</p>
        </header>

        <VoiceVisualizer isActive={status === ConnectionStatus.CONNECTED} isSpeaking={isSpeaking} />

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

          <div className="glass-panel px-6 py-4 rounded-2xl mx-auto">
            {status === ConnectionStatus.IDLE && (
              <p className="text-gray-600 text-sm">
                {language === 'English' && "Welcome to Potter Padilla & Pfau. I'm here to find out about your legal situation and help schedule your free consultation."}
                {language === 'Spanish' && "Bienvenido a Potter Padilla & Pfau. Estoy aquí para conocer su situación legal y ayudarle a programar su consulta gratuita."}
                {language === 'German' && "Willkommen bei Potter Padilla & Pfau. Ich bin hier, um mehr über Ihre rechtliche Situation zu erfahren und Ihnen bei der Vereinbarung Ihrer kostenlosen Beratung zu helfen."}
              </p>
            )}
            {status === ConnectionStatus.CONNECTED && (
              <p className="text-blue-600 text-sm animate-pulse">Assistant is listening in {language}...</p>
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
            {status === ConnectionStatus.CONNECTED ? 'End Conversation' : status === ConnectionStatus.CONNECTING ? 'Connecting...' : 'Ask a Question'}
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
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>
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
