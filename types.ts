
export interface ConsultationDetails {
  name: string;
  phone: string;
  email: string;
  legalIssue: string;
  preferredDate: string;
}

export type Language = 'English' | 'Spanish' | 'German';

export interface Message {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export enum ConnectionStatus {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

export type VoicePhase = 'listening' | 'thinking' | 'speaking' | 'idle';
