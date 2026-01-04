
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { SYSTEM_INSTRUCTION } from './constants';
import { decode, decodeAudioData, createBlob } from './services/audio-utils';
import { ConnectionStatus, Message, ConsultationDetails, Language } from './types';
import VoiceVisualizer from './components/VoiceVisualizer';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';

const scheduleConsultationDeclaration: FunctionDeclaration = {
  name: 'scheduleConsultation',
  parameters: {
    type: Type.OBJECT,
    description: 'Capture details to schedule a free legal consultation.',
    properties: {
      name: { type: Type.STRING, description: 'Full name of the client.' },
      phone: { type: Type.STRING, description: 'Contact phone number.' },
      email: { type: Type.STRING, description: 'Contact email address.' },
      legalIssue: { type: Type.STRING, description: 'Brief description of the legal matter (e.g. workers comp, social security).' },
      preferredDate: { type: Type.STRING, description: 'The user\'s preferred date or time for the consultation.' },
    },
    required: ['name', 'phone', 'legalIssue'],
  },
};

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.IDLE);
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
          functionResponses: {
            id: fc.id,
            name: fc.name,
            response: { result: "Consultation request recorded. I will inform the team at Potter Padilla & Pfau." },
          }
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
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

      const inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextRef.current = { input: inputAudioContext, output: outputAudioContext };

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
            const source = inputAudioContext.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContext.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
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

  const languages: Language[] = ['English', 'Spanish', 'Mandarin Chinese'];

  return (
    <div className="min-h-screen flex flex-col md:flex-row overflow-hidden bg-[#050507]">
      <div className="flex-1 flex flex-col items-center justify-center p-8 relative border-r border-white/5">
        <header className="absolute top-8 text-center">
          <h1 className="serif text-4xl font-bold text-yellow-500 mb-2">Potter Padilla & Pfau</h1>
          <p className="text-gray-400 tracking-widest uppercase text-xs">Legal AI Concierge</p>
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
                    ? 'bg-yellow-600 text-white shadow-lg shadow-yellow-900/20' 
                    : 'bg-white/5 text-gray-500 hover:text-gray-300'
                } ${status !== ConnectionStatus.IDLE ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {lang === 'Mandarin Chinese' ? 'Mandarin' : lang}
              </button>
            ))}
          </div>

          <div className="glass-panel px-6 py-4 rounded-2xl mx-auto">
            {status === ConnectionStatus.IDLE && (
              <p className="text-gray-400 text-sm">
                {language === 'English' && "Welcome to Potter Padilla & Pfau. I am here to help with Social Security, Workers' Comp, or Employment Law questions."}
                {language === 'Spanish' && "Bienvenido a Potter Padilla & Pfau. Estoy aquí para ayudar con preguntas sobre Seguro Social, Compensación al Trabajador o Derecho Laboral."}
                {language === 'Mandarin Chinese' && "欢迎来到 Potter Padilla & Pfau。我可以协助解答有关社会保障、劳工赔偿或雇佣法的问题。"}
              </p>
            )}
            {status === ConnectionStatus.CONNECTED && (
              <p className="text-blue-400 text-sm animate-pulse">Assistant is listening in {language}...</p>
            )}
            {status === ConnectionStatus.ERROR && (
              <p className="text-red-400 text-sm">Connection failed. Please check permissions and try again.</p>
            )}
          </div>

          <button
            onClick={status === ConnectionStatus.CONNECTED ? disconnectVoice : connectVoice}
            disabled={status === ConnectionStatus.CONNECTING}
            className={`w-full px-12 py-4 rounded-full font-semibold transition-all duration-300 transform hover:scale-105 shadow-2xl ${
              status === ConnectionStatus.CONNECTED 
                ? 'bg-red-600/20 text-red-400 border border-red-500/50 hover:bg-red-600/30'
                : 'bg-yellow-600 text-white hover:bg-yellow-500 shadow-yellow-900/40'
            }`}
          >
            {status === ConnectionStatus.CONNECTED ? 'End Conversation' : status === ConnectionStatus.CONNECTING ? 'Connecting...' : 'Ask a Question'}
          </button>
        </div>

        {consultation && (
          <div className="mt-8 glass-panel p-6 rounded-2xl border-yellow-500/30 w-full max-w-md animate-in fade-in slide-in-from-bottom-4">
            <h3 className="serif text-xl text-yellow-500 mb-4">Consultation Request Details</h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-gray-500 uppercase text-[10px]">Client Name</p>
                <p className="font-medium text-white">{consultation.name}</p>
              </div>
              <div>
                <p className="text-gray-500 uppercase text-[10px]">Legal Issue</p>
                <p className="font-medium text-white">{consultation.legalIssue}</p>
              </div>
              <div>
                <p className="text-gray-500 uppercase text-[10px]">Phone</p>
                <p className="font-medium text-white">{consultation.phone}</p>
              </div>
              <div>
                <p className="text-gray-500 uppercase text-[10px]">Preferred Date</p>
                <p className="font-medium text-white">{consultation.preferredDate || 'Not specified'}</p>
              </div>
            </div>
            <button 
              onClick={() => setConsultation(null)}
              className="mt-6 w-full py-2 bg-yellow-600/10 text-yellow-500 rounded-lg border border-yellow-500/20 hover:bg-yellow-600/20 transition-colors"
            >
              Confirm & Clear
            </button>
          </div>
        )}
      </div>

      <div className="w-full md:w-[400px] flex flex-col glass-panel border-l border-white/5">
        <div className="p-6 border-b border-white/5 flex justify-between items-center bg-black/20">
          <h2 className="serif text-xl">Transcripts</h2>
          <button onClick={clearHistory} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">Clear History</button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center text-gray-600 space-y-4">
              <div className="w-12 h-12 rounded-full border border-gray-800 flex items-center justify-center">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>
              </div>
              <p className="text-sm">Your conversation will appear here in real-time.</p>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className={`max-w-[85%] rounded-2xl p-4 text-sm ${
                  m.role === 'user' 
                    ? 'bg-blue-600/10 text-blue-100 border border-blue-500/20 rounded-tr-none' 
                    : 'bg-white/5 text-gray-300 border border-white/5 rounded-tl-none'
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

        <footer className="p-6 border-t border-white/5 bg-black/40 text-[10px] text-gray-500 text-center uppercase tracking-widest">
          Potter Padilla & Pfau &bull; Attorneys at Law
        </footer>
      </div>
    </div>
  );
};

export default App;
