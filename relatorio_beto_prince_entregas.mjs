import fs from 'node:fs';

const env = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
const notionToken = process.env.NOTION_TOKEN || env.match(/^NOTION_TOKEN=(.+)$/m)?.[1]?.trim();

const CHECK_INTERVAL_MS = 60_000;
const DAILY_HOUR = Number(process.env.BETO_PRINCE_DAILY_REPORT_HOUR || 19);
const DAILY_MINUTE = Number(process.env.BETO_PRINCE_DAILY_REPORT_MINUTE || 0);
const WEEKLY_WEEKDAY = Number(process.env.BETO_PRINCE_WEEKLY_REPORT_WEEKDAY || 0);
const WEEKLY_HOUR = Number(process.env.BETO_PRINCE_WEEKLY_REPORT_HOUR || 19);
const WEEKLY_MINUTE = Number(process.env.BETO_PRINCE_WEEKLY_REPORT_MINUTE || 10);
const STATE_FILE = process.env.STATE_FILE || 'beto_prince_entregas_state.json';
const LOG_FILE = process.env.LOG_FILE || 'beto_prince_entregas.log';
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://localhost:8080/message/sendText/br360';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY;
const WHATSAPP_GROUP_NAME = process.env.BETO_PRINCE_GROUP_NAME || 'Br360 - Beto & Prince notificações';
let whatsappGroup = process.env.BETO_PRINCE_GROUP || process.env.WHATSAPP_GROUP_BETO_PRINCE;
const REQUEST_TIMEOUT_MS = 25_000;

const DATABASE_ID = '34a48284-2b44-80b0-97d8-ce6d435d8687';
const APPROVED_STATUSES = new Set(['Aprovado', 'Aprovado/Checklist aplicado']);
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const sendDailyNow = args.has('--send-daily-now');
const sendWeeklyNow = args.has('--send-weekly-now');
const once = args.has('--once') || dryRun || sendDailyNow || sendWeeklyNow;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, `${line}\n`);
}

function saoPauloDate(date = new Date()) {
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
  const dateKey = `${values.year}-${values.month}-${values.day}`;
  return {
    dateKey,
    displayDate: `${values.day}/${values.month}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday),
  };
}

function todayRange() {
  const now = new Date();
  const current = saoPauloDate(now);
  const start = new Date(`${current.dateKey}T00:00:00-03:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end, key: current.dateKey, display: current.displayDate };
}

function weekRange() {
  const now = new Date();
  const current = saoPauloDate(now);
  const todayStart = new Date(`${current.dateKey}T00:00:00-03:00`);
  const start = new Date(todayStart.getTime() - current.weekday * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  const startParts = saoPauloDate(start);
  const endDisplay = saoPauloDate(new Date(end.getTime() - 1));
  return {
    start,
    end,
    key: startParts.dateKey,
    display: `${startParts.displayDate} a ${endDisplay.displayDate}`,
  };
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return { sent: [] };
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function prop(page, name) {
  return page.properties?.[name];
}

function textValue(value) {
  if (!value) return '';
  if (value.title) return value.title.map((part) => part.plain_text).join('');
  if (value.rich_text) return value.rich_text.map((part) => part.plain_text).join('');
  if (value.select) return value.select.name ?? '';
  if (value.multi_select) return value.multi_select.map((option) => option.name).filter(Boolean).join(', ');
  if (value.status) return value.status.name ?? '';
  if (value.date) return value.date.start ?? '';
  if (value.people) return value.people.map((person) => person.name || person.person?.email).filter(Boolean).join(', ');
  return '';
}

function normalize(page) {
  return {
    id: page.id,
    nome: textValue(prop(page, 'Nome')) || 'Sem nome',
    midia: textValue(prop(page, 'Midia')) || textValue(prop(page, 'Mídia')) || 'Não informado',
    status: textValue(prop(page, 'Status')),
    responsavel: textValue(prop(page, 'Responsável')) || textValue(prop(page, 'Responsavel')) || 'Sem responsável',
    projeto: textValue(prop(page, 'Projeto')),
    ultimaEdicao: page.last_edited_time || '',
  };
}

async function notionQuery(cursor) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${notionToken}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      page_size: 100,
      start_cursor: cursor,
    }),
  });
  clearTimeout(timeout);
  const json = await response.json();
  if (!response.ok) throw new Error(`Notion: ${json.message}`);
  return json;
}

async function getApprovedItems() {
  const results = [];
  let cursor;
  do {
    const json = await notionQuery(cursor);
    results.push(...(json.results || []));
    cursor = json.has_more ? json.next_cursor : undefined;
  } while (cursor);
  return results.map(normalize).filter((item) => APPROVED_STATUSES.has(item.status));
}

function inRange(item, range) {
  const date = new Date(item.ultimaEdicao);
  return date >= range.start && date < range.end;
}

function countBy(items, getter) {
  const counts = new Map();
  for (const item of items) {
    const key = getter(item) || 'Não informado';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function formatCounts(items) {
  if (!items.length) return '— Nenhuma entrega.';
  return items.map(([name, total]) => `• ${name}: ${total}`).join('\n');
}

function formatList(items) {
  if (!items.length) return '— Nenhuma entrega no período.';
  return items
    .sort((a, b) => a.nome.localeCompare(b.nome))
    .slice(0, 20)
    .map((item) => {
      const bits = [`• ${item.nome}`];
      if (item.midia) bits.push(item.midia);
      if (item.responsavel) bits.push(item.responsavel);
      if (item.projeto) bits.push(item.projeto);
      return bits.join(' → ');
    })
    .join('\n');
}

function reportTitle(period, range) {
  if (period === 'daily') return `📊 *Entregas do dia — ${range.display}*`;
  return `📊 *Entregas da semana — ${range.display}*`;
}

function buildReport(period, items, range) {
  const mediaCounts = countBy(items, (item) => item.midia);
  const ownerCounts = countBy(items, (item) => item.responsavel);
  return [
    reportTitle(period, range),
    '',
    `Total: *${items.length}*`,
    '',
    '*Por mídia*',
    formatCounts(mediaCounts),
    '',
    '*Por responsável*',
    formatCounts(ownerCounts),
    '',
    '*Entregas*',
    formatList(items),
  ].join('\n');
}

function evolutionBaseUrl() {
  return EVOLUTION_URL.replace(/\/message\/sendText\/[^/]+\/?$/, '');
}

async function resolveWhatsAppGroup() {
  if (whatsappGroup) return whatsappGroup;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const response = await fetch(`${evolutionBaseUrl()}/group/fetchAllGroups/br360?getParticipants=false`, {
    signal: controller.signal,
    headers: { apikey: EVOLUTION_KEY },
  });
  clearTimeout(timeout);
  const json = await response.json();
  if (!response.ok) throw new Error(`Evolution grupos: ${JSON.stringify(json)}`);

  const groups = Array.isArray(json) ? json : json.groups || json.data || [];
  const target = WHATSAPP_GROUP_NAME.trim().toLowerCase();
  const group = groups.find((item) => {
    const name = item.subject || item.name || item.groupName || '';
    return name.trim().toLowerCase() === target;
  });

  if (!group) throw new Error(`Grupo do WhatsApp nao encontrado: ${WHATSAPP_GROUP_NAME}`);
  whatsappGroup = group.id || group.jid || group.remoteJid;
  if (!whatsappGroup) throw new Error(`Grupo encontrado, mas sem ID: ${WHATSAPP_GROUP_NAME}`);
  log(`Grupo encontrado: ${WHATSAPP_GROUP_NAME}`);
  return whatsappGroup;
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
      number: whatsappGroup,
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

function shouldSend(period, current, state, range) {
  if (dryRun) return true;
  if (period === 'daily' && sendDailyNow) return true;
  if (period === 'weekly' && sendWeeklyNow) return true;

  if (period === 'daily') {
    return current.hour === DAILY_HOUR && current.minute >= DAILY_MINUTE && state.lastDailyDate !== range.key;
  }

  return (
    current.weekday === WEEKLY_WEEKDAY &&
    current.hour === WEEKLY_HOUR &&
    current.minute >= WEEKLY_MINUTE &&
    state.lastWeeklyKey !== range.key
  );
}

async function runPeriod(period, allItems, state) {
  const current = saoPauloDate();
  const range = period === 'daily' ? todayRange() : weekRange();
  if (!shouldSend(period, current, state, range)) return false;

  const items = allItems.filter((item) => inRange(item, range));
  const report = buildReport(period, items, range);

  if (dryRun) {
    console.log(`\n--- ${period.toUpperCase()} ---\n`);
    console.log(report);
    return true;
  }

  const messageId = await sendWhatsApp(report);
  if (period === 'daily') state.lastDailyDate = range.key;
  if (period === 'weekly') state.lastWeeklyKey = range.key;
  state.sent.push({
    period,
    key: range.key,
    total: items.length,
    messageId,
    sentAt: new Date().toISOString(),
  });
  writeState(state);
  log(`Relatorio ${period} enviado. Total: ${items.length}. ID: ${messageId}`);
  return true;
}

async function tick() {
  const state = readState();
  const allItems = await getApprovedItems();
  const sentDaily = await runPeriod('daily', allItems, state);
  const sentWeekly = await runPeriod('weekly', allItems, state);

  if (!sentDaily && !sentWeekly) {
    const current = saoPauloDate();
    log(`Aguardando horario. Agora: ${current.dateKey} ${String(current.hour).padStart(2, '0')}:${String(current.minute).padStart(2, '0')}.`);
  }
}

async function main() {
  if (!notionToken) throw new Error('NOTION_TOKEN nao encontrado.');
  if (!EVOLUTION_KEY) throw new Error('EVOLUTION_KEY nao encontrado no ambiente.');

  log('Iniciando relatorio de entregas Beto & Prince.');
  await resolveWhatsAppGroup();
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
