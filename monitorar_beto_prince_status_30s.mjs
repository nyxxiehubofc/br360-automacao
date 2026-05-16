import fs from 'node:fs';

const env = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
const notionToken = process.env.NOTION_TOKEN || env.match(/^NOTION_TOKEN=(.+)$/m)?.[1]?.trim();

const INTERVAL_MS = 30_000;
const STATE_FILE = process.env.STATE_FILE || 'beto_prince_status_state.json';
const LOG_FILE = process.env.LOG_FILE || 'beto_prince_status_monitor.log';
const PID_FILE = process.env.PID_FILE || 'beto_prince_status_monitor.pid';
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://localhost:8080/message/sendText/br360';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY;
const WHATSAPP_GROUP_NAME = process.env.BETO_PRINCE_GROUP_NAME || 'Br360 - Beto & Prince notificações';
let whatsappGroup = process.env.BETO_PRINCE_GROUP || process.env.WHATSAPP_GROUP_BETO_PRINCE;
const REQUEST_TIMEOUT_MS = 20_000;

const DATABASE_ID = '34a48284-2b44-80b0-97d8-ce6d435d8687';
const WATCHED_STATUS = new Map([
  ['Fila', { emoji: '📥', label: 'entrou na fila' }],
  ['Aprovado', { emoji: '✅', label: 'foi aprovado' }],
  ['Aprovado/Checklist aplicado', { emoji: '✅', label: 'foi aprovado' }],
  ['Modificando', { emoji: '🛠️', label: 'voltou para modificação' }],
  ['Modificando/Corrigindo', { emoji: '🛠️', label: 'voltou para modificação' }],
]);

let scanRunning = false;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, `${line}\n`);
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      initialized: false,
      startedAt: new Date().toISOString(),
      items: {},
      sent: [],
    };
  }
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
  if (value.status) return value.status.name ?? '';
  if (value.date) return value.date.start ?? '';
  if (value.people) return value.people.map((person) => person.name || person.person?.email).filter(Boolean).join(', ');
  return '';
}

function normalize(page) {
  return {
    id: page.id,
    url: page.url,
    nome: textValue(prop(page, 'Nome')) || 'Sem nome',
    status: textValue(prop(page, 'Status')),
    responsavel: textValue(prop(page, 'Responsável')) || textValue(prop(page, 'Responsavel')) || 'Sem responsável',
    urgencia: textValue(prop(page, 'Urgência')) || textValue(prop(page, 'Urgencia')),
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

async function getItems() {
  const results = [];
  let cursor;

  do {
    const json = await notionQuery(cursor);
    results.push(...(json.results || []));
    cursor = json.has_more ? json.next_cursor : undefined;
  } while (cursor);

  return results.map(normalize);
}

function watchedStatus(item) {
  return WATCHED_STATUS.has(item.status);
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

function evolutionBaseUrl() {
  return EVOLUTION_URL.replace(/\/message\/sendText\/[^/]+\/?$/, '');
}

async function resolveWhatsAppGroup() {
  if (whatsappGroup) return whatsappGroup;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const response = await fetch(`${evolutionBaseUrl()}/group/fetchAllGroups/br360?getParticipants=false`, {
    signal: controller.signal,
    headers: {
      apikey: EVOLUTION_KEY,
    },
  });
  clearTimeout(timeout);

  const json = await response.json();
  if (!response.ok) throw new Error(`Evolution grupos: ${JSON.stringify(json)}`);

  const groups = Array.isArray(json) ? json : json.groups || json.data || [];
  const normalizedTarget = WHATSAPP_GROUP_NAME.trim().toLowerCase();
  const group = groups.find((item) => {
    const name = item.subject || item.name || item.groupName || '';
    return name.trim().toLowerCase() === normalizedTarget;
  });

  if (!group) {
    throw new Error(`Grupo do WhatsApp nao encontrado: ${WHATSAPP_GROUP_NAME}`);
  }

  whatsappGroup = group.id || group.jid || group.remoteJid;
  if (!whatsappGroup) {
    throw new Error(`Grupo encontrado, mas sem ID: ${WHATSAPP_GROUP_NAME}`);
  }

  log(`Grupo encontrado: ${WHATSAPP_GROUP_NAME}`);
  return whatsappGroup;
}

function messageFor(item) {
  const statusInfo = WATCHED_STATUS.get(item.status);
  const lines = [
    `${statusInfo.emoji} *${statusInfo.label}*`,
    '',
    `Item: *${item.nome}*`,
    `Responsável: *${item.responsavel}*`,
    `Status: ${item.status}`,
  ];

  if (item.projeto) lines.push(`Projeto: ${item.projeto}`);
  if (item.urgencia) lines.push(`Urgência: ${item.urgencia}`);
  lines.push(`Notion: ${item.url.replace(/^https?:\/\//, '')}`);

  return lines.join('\n');
}

async function scan() {
  if (scanRunning) {
    log('Scan ignorado: a rodada anterior ainda esta em andamento.');
    return;
  }

  scanRunning = true;
  const state = readState();

  try {
    const items = await getItems();
    let sent = 0;

    for (const item of items) {
      const previous = state.items[item.id];
      const isNewItem = !previous;
      const changedToWatchedStatus = previous && previous.status !== item.status;
      const shouldNotify =
        state.initialized &&
        (isNewItem || changedToWatchedStatus) &&
        watchedStatus(item);

      state.items[item.id] = {
        nome: item.nome,
        status: item.status,
        responsavel: item.responsavel,
        ultimaEdicao: item.ultimaEdicao,
        checkedAt: new Date().toISOString(),
      };

      if (!shouldNotify) continue;

      const messageId = await sendWhatsApp(messageFor(item));
      state.sent.push({
        pageId: item.id,
        nome: item.nome,
        status: item.status,
        responsavel: item.responsavel,
        messageId,
        sentAt: new Date().toISOString(),
      });
      sent += 1;
      log(`Enviado WhatsApp: ${item.nome} -> ${item.status} (${messageId})`);
    }

    state.initialized = true;
    state.lastScanAt = new Date().toISOString();
    writeState(state);
    log(`Scan concluido. Itens monitorados: ${items.length}. Avisos enviados: ${sent}`);
  } finally {
    scanRunning = false;
  }
}

async function main() {
  if (!notionToken) throw new Error('NOTION_TOKEN nao encontrado.');
  if (!EVOLUTION_KEY) throw new Error('EVOLUTION_KEY nao encontrado no ambiente.');

  fs.writeFileSync(PID_FILE, String(process.pid));
  log('Iniciando monitor Beto & Prince a cada 30 segundos.');
  await resolveWhatsAppGroup();
  await scan();
  setInterval(() => {
    scan().catch((error) => log(`Erro no scan: ${error.stack || error.message}`));
  }, INTERVAL_MS);
}

main().catch((error) => {
  log(`Erro fatal: ${error.stack || error.message}`);
  process.exit(1);
});
