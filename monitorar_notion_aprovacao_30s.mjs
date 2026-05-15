import fs from 'node:fs';

const env = fs.readFileSync('.env', 'utf8');
const notionToken = env.match(/^NOTION_TOKEN=(.+)$/m)?.[1]?.trim();

const INTERVAL_MS = 30_000;
const STATE_FILE = process.env.STATE_FILE || 'notion_aprovacao_state.json';
const LOG_FILE = process.env.LOG_FILE || 'notion_aprovacao_monitor.log';
const PID_FILE = process.env.PID_FILE || 'notion_aprovacao_monitor.pid';
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://localhost:8080/message/sendText/br360';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY;
const WHATSAPP_GROUP = process.env.WHATSAPP_GROUP;
const REQUEST_TIMEOUT_MS = 20_000;
let scanRunning = false;

const databases = [
  {
    area: 'Vídeos',
    equipe: 'Beto & Prince',
    id: '34a48284-2b44-80b0-97d8-ce6d435d8687',
  },
  {
    area: 'Mídias',
    equipe: 'Twister & Kaique',
    id: '34a48284-2b44-8029-868d-d7575c8684a3',
  },
];

const watchedResponsaveis = ['Beto', 'Kaique', 'Twister', 'Prince'];
const watchedStatus = new Set(['Aguardando aprovação', 'Aguardando aprovacao']);

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

function normalize(page, config) {
  return {
    id: page.id,
    url: page.url,
    area: config.area,
    equipe: config.equipe,
    nome: textValue(prop(page, 'Nome')) || 'Sem nome',
    status: textValue(prop(page, 'Status')),
    responsavel: textValue(prop(page, 'Responsável')) || textValue(prop(page, 'Responsavel')) || 'Sem responsável',
    urgencia: textValue(prop(page, 'Urgência')) || textValue(prop(page, 'Urgencia')),
    projeto: textValue(prop(page, 'Projeto')),
    ultimaEdicao: page.last_edited_time || '',
  };
}

async function notionQuery(databaseId) {
  const results = [];
  let cursor;

  do {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
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
    if (!response.ok) throw new Error(`${databaseId}: ${json.message}`);

    results.push(...(json.results || []));
    cursor = json.has_more ? json.next_cursor : undefined;
  } while (cursor);

  return results;
}

async function getItems() {
  const groups = await Promise.all(
    databases.map(async (config) => {
      const pages = await notionQuery(config.id);
      return pages.map((page) => normalize(page, config));
    }),
  );
  return groups.flat();
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

function shouldWatch(item) {
  const responsavel = item.responsavel
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  return responsavel.some((name) => watchedResponsaveis.includes(name)) && watchedStatus.has(item.status);
}

function messageFor(item) {
  const lines = [
    '⏳ *Novo item aguardando aprovação*',
    '',
    `Equipe: *${item.equipe}*`,
    `Responsável: *${item.responsavel}*`,
    `Item: ${item.nome}`,
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
      const enteredApproval = shouldWatch(item) && previous && previous.status !== item.status;

      state.items[item.id] = {
        nome: item.nome,
        status: item.status,
        responsavel: item.responsavel,
        ultimaEdicao: item.ultimaEdicao,
        checkedAt: new Date().toISOString(),
      };

      if (!state.initialized || !enteredApproval) continue;

      const messageId = await sendWhatsApp(messageFor(item));
      state.sent.push({
        pageId: item.id,
        nome: item.nome,
        responsavel: item.responsavel,
        messageId,
        sentAt: new Date().toISOString(),
      });
      sent += 1;
      log(`Enviado WhatsApp: ${item.nome} (${item.responsavel}) ${messageId}`);
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
  if (!notionToken) throw new Error('NOTION_TOKEN não encontrado no .env.');
  if (!EVOLUTION_KEY) throw new Error('EVOLUTION_KEY nao encontrado no ambiente.');
  if (!WHATSAPP_GROUP) throw new Error('WHATSAPP_GROUP nao encontrado no ambiente.');

  fs.writeFileSync(PID_FILE, String(process.pid));
  log('Iniciando monitor do Notion a cada 30 segundos.');
  await scan();
  setInterval(() => {
    scan().catch((error) => log(`Erro no scan: ${error.stack || error.message}`));
  }, INTERVAL_MS);
}

main().catch((error) => {
  log(`Erro fatal: ${error.stack || error.message}`);
  process.exit(1);
});
