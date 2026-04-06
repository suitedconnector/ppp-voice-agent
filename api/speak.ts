export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });
  }

  const { text } = await req.json() as { text: string };
  if (!text) {
    return Response.json({ error: 'Missing text' }, { status: 400 });
  }

  const voice = process.env.OPENAI_VOICE || 'shimmer';

  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'tts-1', input: text, voice }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return Response.json({ error: errText }, { status: response.status });
    }

    const buffer = await response.arrayBuffer();
    return new Response(buffer, {
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  } catch (err: any) {
    console.error('[api/speak] error:', err);
    return Response.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
