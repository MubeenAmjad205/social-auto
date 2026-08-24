import { MongoClient } from 'mongodb';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

// Parse .dev.vars
const devVars = fs.readFileSync('.dev.vars', 'utf-8');
const env: Record<string, string> = {};
for (const line of devVars.split('\n')) {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      env[key] = val;
    }
  }
}

async function main() {
  console.log('Connecting to MongoDB Atlas...');
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(env.MONGODB_DB || 'social');
  
  const seed = {
    note: 'Tested live Cloudflare Worker social media pipeline with MongoDB Atlas, Cloudinary, and Telegram integration.',
    angle: 'How to build high-reliability assisted AI publishing pipelines on free tier infrastructure.',
    kind: 'own',
    used: false,
    created_at: new Date(),
  };

  const res = await db.collection('seeds').insertOne(seed);
  console.log('Successfully inserted test seed:', res.insertedId);
  await client.close();
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
