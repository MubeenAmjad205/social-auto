import * as fs from 'fs';
import { MongoClient } from 'mongodb';

// Parse .dev.vars
const devVars = fs.readFileSync('.dev.vars', 'utf-8');
const env: Record<string, string> = {};
for (const line of devVars.split('\n')) {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const idx = trimmed.indexOf('=');
    if (idx > 0) env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
}

async function testTavilyPrimary() {
  console.log('\n--- 1. Testing Primary Research API: Tavily ---');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query: 'Cloudflare Workers MongoDB Atlas integration',
      max_results: 3,
    }),
  });
  if (!res.ok) throw new Error(`Tavily failed ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  console.log(`✅ Tavily Primary SUCCESS: Retrieved ${data.results?.length ?? 0} results.`);
  if (data.results?.[0]) console.log(`   Sample result: "${data.results[0].title}"`);
}

async function testGitHubPrimary() {
  console.log('\n--- 2. Testing Primary Research API: GitHub ---');
  const res = await fetch('https://api.github.com/search/repositories?q=cloudflare+workers+mongodb&per_page=3', {
    headers: {
      'User-Agent': 'social-worker/1.0',
      'Authorization': `token ${env.GITHUB_PAT}`,
    },
  });
  if (!res.ok) throw new Error(`GitHub failed ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  console.log(`✅ GitHub Primary SUCCESS: Total count ${data.total_count}, returned ${data.items?.length ?? 0} repos.`);
}

async function testMongoAtlasPrimary() {
  console.log('\n--- 3. Testing Primary Database: MongoDB Atlas ---');
  const client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  const db = client.db(env.MONGODB_DB || 'social');
  const collections = await db.listCollections().toArray();
  const names = collections.map(c => c.name);
  console.log(`✅ MongoDB Atlas Primary SUCCESS: Connected to DB "${db.databaseName}". Collections: ${names.join(', ')}`);
  await client.close();
}

async function testCloudinaryPrimary() {
  console.log('\n--- 4. Testing Primary Media Storage: Cloudinary Signed API ---');
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;

  const timestamp = Math.floor(Date.now() / 1000);
  const signatureString = `timestamp=${timestamp}${apiSecret}`;
  
  // SHA-1 signature
  const encoder = new TextEncoder();
  const data = encoder.encode(signatureString);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const signature = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const usageRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/usage`, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64'),
    },
  });
  if (!usageRes.ok) throw new Error(`Cloudinary Usage API failed ${usageRes.status}: ${await usageRes.text()}`);
  const usage: any = await usageRes.json();
  console.log(`✅ Cloudinary Primary SUCCESS: Usage API active. Credits used: ${usage.credits?.usage ?? 0} / limit: ${usage.credits?.limit ?? 'N/A'}`);
}

async function main() {
  console.log('=== AUDITING PRIMARY PATHS (NO FALLBACKS) ===');
  await testTavilyPrimary();
  await testGitHubPrimary();
  await testMongoAtlasPrimary();
  await testCloudinaryPrimary();
  console.log('\n=== ALL PRIMARY SERVICE CHECKS PASSED ===');
}

main().catch(err => {
  console.error('\n🔴 Primary Path Verification Failed:', err);
  process.exit(1);
});
