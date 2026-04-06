import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_INSTRUCTION, FIRM_INFO } from '../constants';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const scheduleConsultationTool: Anthropic.Tool = {
  name: 'scheduleConsultation',
  description: 'Capture details to schedule a free legal consultation.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Full name of the client.' },
      phone: { type: 'string', description: 'Contact phone number.' },
      email: { type: 'string', description: 'Contact email address.' },
      legalIssue: { type: 'string', description: 'Brief description of the legal matter (e.g. social security, employment law).' },
      preferredDate: { type: 'string', description: "The user's preferred date or time for the consultation." },
    },
    required: ['name', 'phone', 'legalIssue'],
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, language } = req.body as {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    language: string;
  };

  if (!messages || !language) {
    return res.status(400).json({ error: 'Missing messages or language' });
  }

  const systemPrompt = `YOU MUST CONDUCT THIS ENTIRE CONVERSATION IN ${language.toUpperCase()}. ${SYSTEM_INSTRUCTION}\n\n${FIRM_INFO}`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      tools: [scheduleConsultationTool],
    });

    // Handle tool use entirely server-side
    if (response.stop_reason === 'tool_use') {
      const toolBlock = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      );

      if (toolBlock && toolBlock.name === 'scheduleConsultation') {
        const toolCall = toolBlock.input as {
          name: string; phone: string; email?: string;
          legalIssue: string; preferredDate?: string;
        };

        const followUp = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: systemPrompt,
          messages: [
            ...messages,
            { role: 'assistant' as const, content: response.content },
            {
              role: 'user' as const,
              content: [{
                type: 'tool_result' as const,
                tool_use_id: toolBlock.id,
                content: 'Consultation request recorded. I will inform the team at Potter Padilla & Pfau.',
              }],
            },
          ],
          tools: [scheduleConsultationTool],
        });

        const text = followUp.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map(b => b.text)
          .join(' ');

        return res.json({ text, toolCall });
      }
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join(' ');

    res.json({ text });
  } catch (err) {
    console.error('[api/chat] error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
  }
}
