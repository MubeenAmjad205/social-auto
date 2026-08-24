import { MongoClient } from 'mongodb';
import * as fs from 'fs';

const devVars = fs.readFileSync('.dev.vars', 'utf-8');
const env: Record<string, string> = {};
for (const line of devVars.split('\n')) {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
  }
}

async function main() {
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(env.MONGODB_DB || 'social');
  await db.collection('rate_limits').deleteMany({});
  console.log('Cleared rate_limits collection.');
  await client.close();
}

main().catch(console.error);
