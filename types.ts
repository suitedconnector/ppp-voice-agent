
export interface ConsultationDetails {
  name: string;
  phone: string;
  email: string;
  legalIssue: string;
  preferredDate: string;
}

export type Language = 'English' | 'Spanish' | 'Mandarin Chinese';

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
