import * as fs from 'fs';

const devVars = fs.readFileSync('.dev.vars', 'utf-8');
const env: Record<string, string> = {};
for (const line of devVars.split('\n')) {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const idx = trimmed.indexOf('=');
    if (idx > 0) env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
}

async function main() {
  const key = env.GEMINI_API_KEY;
  console.log('Testing gemini-3.6-flash...');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Hello, respond with OK.' }] }] }),
    }
  );
  console.log('Status:', res.status);
  const text = await res.text();
  console.log('Response:', text.slice(0, 300));
}

main().catch(console.error);
