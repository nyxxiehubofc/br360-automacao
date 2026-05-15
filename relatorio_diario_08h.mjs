import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPORT_PERIOD = 'manha';
const CHECK_INTERVAL_MS = 60_000;
const SEND_HOUR = 8;
const STATE_FILE = process.env.STATE_FILE || 'relatorio_08h_state.json';
const LOG_FILE = process.env.LOG_FILE || 'relatorio_08h.log';
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://localhost:8080/message/sendText/br360';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY;
const WHATSAPP_GROUP = process.env.WHATSAPP_GROUP;
const REQUEST_TIMEOUT_MS = 25_000;

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const sendNow = args.has('--send-now');
const once = args.has('--once') || dryRun || sendNow;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, `${line}\n`);
}

function saoPauloParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: values.weekday,
  };
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return { sent: [] };
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function shouldSendNow() {
  if (dryRun) return true;
  if (sendNow) return true;

  const current = saoPauloParts();
  return current.hour === SEND_HOUR;
}

function buildReport() {
  return execFileSync('node', ['gerar_relatorio_detalhado_codex.mjs', REPORT_PERIOD], {
    encoding: 'utf8',
  }).trim();
}

async function sendWhatsApp(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const response = await fetch(EVOLUTION_URL, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      apikey: EVOLUTION_KEY,
    },
    body: JSON.stringify({
      number: WHATSAPP_GROUP,
      text,
      linkPreview: false,
      previewUrl: false,
      options: {
        linkPreview: false,
        previewUrl: false,
      },
    }),
  });
  clearTimeout(timeout);

  const json = await response.json();
  if (!response.ok) throw new Error(`Evolution: ${JSON.stringify(json)}`);
  return json?.key?.id || 'sem-id';
}

async function tick() {
  const current = saoPauloParts();
  const state = readState();

  if (!shouldSendNow()) {
    log(`Aguardando 08h. Agora: ${current.dateKey} ${String(current.hour).padStart(2, '0')}:${String(current.minute).padStart(2, '0')}.`);
    return;
  }

  if (!sendNow && state.lastSentDate === current.dateKey) {
    log(`Relatorio 08h ja enviado em ${current.dateKey}.`);
    return;
  }

  const report = buildReport();

  if (dryRun) {
    log(`Teste sem envio. Relatorio gerado com ${report.length} caracteres.`);
    console.log('\n--- RELATORIO 08H ---\n');
    console.log(report);
    return;
  }

  const messageId = await sendWhatsApp(report);
  state.lastSentDate = current.dateKey;
  state.sent.push({
    date: current.dateKey,
    messageId,
    sentAt: new Date().toISOString(),
  });
  writeState(state);
  log(`Relatorio 08h enviado. ID: ${messageId}`);
}

async function main() {
  if (!EVOLUTION_KEY) throw new Error('EVOLUTION_KEY nao encontrado no ambiente.');
  if (!WHATSAPP_GROUP) throw new Error('WHATSAPP_GROUP nao encontrado no ambiente.');

  log('Iniciando relatorio diario 08h.');

  await tick().catch((error) => log(`Erro: ${error.stack || error.message}`));
  if (once) return;

  setInterval(() => {
    tick().catch((error) => log(`Erro: ${error.stack || error.message}`));
  }, CHECK_INTERVAL_MS);
}

main().catch((error) => {
  log(`Erro fatal: ${error.stack || error.message}`);
  process.exit(1);
});
