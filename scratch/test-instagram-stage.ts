import fs from 'fs';
import { MongoStore } from '../src/store';
import { generateInstagramDraft } from '../src/instagram-generate';

// Parse .dev.vars
const vars = fs.readFileSync('.dev.vars', 'utf8');
const env: Record<string, string> = {};
for (const line of vars.split('\n')) {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) {
    env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
  }
}

async function runTest() {
  console.log('Connecting to MongoStore...');
  const store = new MongoStore(env as any);
  await store.init();

  console.log('Testing generateInstagramDraft...');
  const mockCtx = {
    waitUntil: (promise: Promise<any>) => {
      promise.catch(err => console.error('ctx.waitUntil error:', err));
    }
  };

  try {
    await generateInstagramDraft(env as any, store, mockCtx as any);
    console.log('generateInstagramDraft SUCCESS');
  } catch (err: any) {
    console.error('generateInstagramDraft FAILED with error:', err);
    console.error('Stack:', err?.stack);
  } finally {
    await store.close();
  }
}

runTest();
