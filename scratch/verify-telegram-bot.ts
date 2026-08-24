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
  const token = env.TELEGRAM_BOT_TOKEN;
  console.log('--- Checking Telegram Bot API Status ---');
  
  // 1. getMe
  const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  if (!meRes.ok) throw new Error(`getMe failed ${meRes.status}: ${await meRes.text()}`);
  const meData: any = await meRes.json();
  console.log(`✅ Telegram Bot Identity: @${meData.result.username} (ID: ${meData.result.id})`);

  // 2. getWebhookInfo
  const whRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  if (!whRes.ok) throw new Error(`getWebhookInfo failed ${whRes.status}: ${await whRes.text()}`);
  const whData: any = await whRes.json();
  console.log(`✅ Telegram Webhook Info:`);
  console.log(`   URL: ${whData.result.url}`);
  console.log(`   Has Custom Certificate: ${whData.result.has_custom_certificate}`);
  console.log(`   Pending Update Count: ${whData.result.pending_update_count}`);
  if (whData.result.last_error_message) {
    console.log(`   Last Error Message: ${whData.result.last_error_message}`);
  }
}

main().catch(err => {
  console.error('Telegram check failed:', err);
  process.exit(1);
});
