import fs from 'fs';
import { MongoClient } from 'mongodb';

const vars = fs.readFileSync('.dev.vars', 'utf8');
const env: Record<string, string> = {};
for (const line of vars.split('\n')) {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) {
    env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
  }
}

async function check() {
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(env.MONGODB_DB || 'social');

  console.log('--- ALL RUN LOGS ---');
  const logs = await db.collection('run_logs').find().sort({ started_at: -1 }).limit(10).toArray();
  for (const log of logs) {
    console.log(`Log ${log._id}: cron=${log.cron}, ok=${log.ok}, duration=${log.duration_ms}ms, error=${log.error}`);
    if (log.steps) console.log('  steps:', JSON.stringify(log.steps));
  }

  await client.close();
}

check();
