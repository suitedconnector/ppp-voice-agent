
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { SYSTEM_INSTRUCTION } from './constants';
import { decode, decodeAudioData, createBlob } from './services/audio-utils';
import { ConnectionStatus, Message, ConsultationDetails, Language } from './types';
import VoiceVisualizer from './components/VoiceVisualizer';

const MODEL_NAME = 'gemini-3.1-flash-live-preview';

const scheduleConsultationDeclaration: FunctionDeclaration = {
  name: 'scheduleConsultation',
  parameters: {
    type: Type.OBJECT,
    description: 'Capture details to schedule a free legal consultation.',
    properties: {
      name: { type: Type.STRING, description: 'Full name of the client.' },
      phone: { type: Type.STRING, description: 'Contact phone number.' },
      email: { type: Type.STRING, description: 'Contact email address.' },
      legalIssue: { type: Type.STRING, description: 'Brief description of the legal matter (e.g. social security, employment law).' },
      preferredDate: { type: Type.STRING, description: 'The user\'s preferred date or time for the consultation.' },
    },
    required: ['name', 'phone', 'legalIssue'],
  },
};

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.IDLE);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [consultation, setConsultation] = useState<Partial<ConsultationDetails> | null>(null);
  const [language, setLanguage] = useState<Language>('English');
  
  const audioContextRef = useRef<{ input: AudioContext; output: AudioContext } | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const transcriptionRef = useRef({ user: '', model: '' });

  const clearHistory = () => setMessages([]);

  const handleToolCall = useCallback(async (fc: any) => {
    if (fc.name === 'scheduleConsultation') {
      const args = fc.args as ConsultationDetails;
      setConsultation(args);
      
      if (sessionRef.current) {
        sessionRef.current.sendToolResponse({
          functionResponses: [{
            id: fc.id,
            name: fc.name,
            response: { result: "Consultation request recorded. I will inform the team at Potter Padilla & Pfau." },
          }]
        });
      }
      
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        text: `[SYSTEM] Consultation details captured for ${args.name} regarding ${args.legalIssue}.`, 
        timestamp: Date.now() 
      }]);
    }
  }, []);

  const connectVoice = async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      setErrorMessage('');
      const apiKey = process.env.GEMINI_API_KEY || '';
      if (!apiKey) {
        throw new Error("API key is missing. Please ensure it is configured in the environment.");
      }
      const ai = new GoogleGenAI({ apiKey });

      const inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextRef.current = { input: inputAudioContext, output: outputAudioContext };

      if (inputAudioContext.state === 'suspended') await inputAudioContext.resume();
      if (outputAudioContext.state === 'suspended') await outputAudioContext.resume();

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Microphone access is not supported in this browser. Please ensure you are using a secure context (HTTPS) and a modern browser.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const customInstruction = `YOU MUST CONDUCT THIS ENTIRE CONVERSATION IN ${language.toUpperCase()}. ${SYSTEM_INSTRUCTION}`;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: customInstruction,
          tools: [{ functionDeclarations: [scheduleConsultationDeclaration] }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            
            // Trigger the initial greeting
            sessionPromise.then(session => {
              session.sendRealtimeInput([{ text: "Hello." }]);
            });

            const source = inputAudioContext.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContext.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ audio: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContext.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              setIsSpeaking(true);
              const ctx = outputAudioContext;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.onended = () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setIsSpeaking(false);
              };
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }

            if (message.serverContent?.inputTranscription) {
              transcriptionRef.current.user += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              transcriptionRef.current.model += message.serverContent.outputTranscription.text;
            }
            if (message.serverContent?.turnComplete) {
              const u = transcriptionRef.current.user;
              const m = transcriptionRef.current.model;
              if (u) setMessages(prev => [...prev, { role: 'user', text: u, timestamp: Date.now() }]);
              if (m) setMessages(prev => [...prev, { role: 'assistant', text: m, timestamp: Date.now() }]);
              transcriptionRef.current = { user: '', model: '' };
            }

            if (message.toolCall) {
              message.toolCall.functionCalls.forEach(handleToolCall);
            }
          },
          onerror: (e) => {
            console.error('Voice Error:', e);
            setErrorMessage(e instanceof Error ? e.message : String(e));
            setStatus(ConnectionStatus.ERROR);
          },
          onclose: () => {
            setStatus(ConnectionStatus.IDLE);
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error('Connection failed:', err);
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus(ConnectionStatus.ERROR);
    }
  };

  const disconnectVoice = () => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.input.close();
      audioContextRef.current.output.close();
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
