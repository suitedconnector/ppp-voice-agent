import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';

// Load ANTHROPIC_API_KEY from .env
const env = fs.readFileSync('.env', 'utf8');
const match = env.match(/ANTHROPIC_API_KEY=(.+)/);
if (!match) {
  console.error('❌ ANTHROPIC_API_KEY not found in .env');
  process.exit(1);
}
const apiKey = match[1].trim();
console.log(`🔑 Using key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);

const client = new Anthropic({ apiKey });

console.log('📡 Sending test message to Claude...\n');

const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'Reply with exactly: "Anthropic API connection successful."' }],
});

console.log('✅ Response:', response.content[0].text);
console.log(`📊 Tokens — input: ${response.usage.input_tokens}, output: ${response.usage.output_tokens}`);
