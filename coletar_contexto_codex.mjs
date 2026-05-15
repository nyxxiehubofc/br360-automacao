import fs from 'node:fs';

const env = fs.readFileSync('.env', 'utf8');
const notionToken = env.match(/^NOTION_TOKEN=(.+)$/m)?.[1]?.trim();

const dbs = {
  videos: '34a48284-2b44-80b0-97d8-ce6d435d8687',
  midias: '34a48284-2b44-8029-868d-d7575c8684a3',
  social: '34a48284-2b44-80ca-8e38-d84b380cd1c1',
};

async function notionQuery(databaseId) {
  const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${notionToken}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ page_size: 100 }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${databaseId}: ${json.message}`);
  return json.results ?? [];
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
  if (value.last_edited_time) return value.last_edited_time ?? '';
  return '';
}

function item(page, area) {
  return {
    area,
    nome: textValue(prop(page, 'Nome')) || 'Sem nome',
    status: textValue(prop(page, 'Status')),
    responsavel: textValue(prop(page, 'Responsável')) || textValue(prop(page, 'Responsavel')),
    urgencia: textValue(prop(page, 'Urgência')) || textValue(prop(page, 'Urgencia')),
    projeto: textValue(prop(page, 'Projeto')),
    dataPostagem: textValue(prop(page, 'Data de postagem')),
    ultimaEdicao: textValue(prop(page, 'Última edição')) || textValue(prop(page, 'Última edição 1')) || page.last_edited_time || '',
  };
}

function dayKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function sameDay(value, day) {
  return typeof value === 'string' && value.startsWith(day);
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) {
    const value = item[key] || 'Sem ' + key;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

const [videosRaw, midiasRaw, socialRaw] = await Promise.all([
  notionQuery(dbs.videos),
  notionQuery(dbs.midias),
  notionQuery(dbs.social),
]);

const now = new Date();
const today = dayKey(now);
const yesterday = dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
const tomorrow = dayKey(new Date(now.getTime() + 24 * 60 * 60 * 1000));

const videos = videosRaw.map((page) => item(page, 'Videos'));
const midias = midiasRaw.map((page) => item(page, 'Midias'));
const social = socialRaw.map((page) => item(page, 'Social'));
const producao = [...videos, ...midias];

const aprovado = new Set(['Aprovado', 'Aprovado/Checklist aplicado']);
const aberta = producao.filter((it) => !aprovado.has(it.status));
const urgentes = aberta.filter((it) => it.urgencia === 'Alta');
const aguardando = aberta.filter((it) => it.status === 'Aguardando aprovação' || it.status === 'Aguardando aprovacao');
const emProducao = aberta.filter((it) => it.status === 'Em produção' || it.status === 'Em producao' || it.status === 'Modificando/Corrigindo');
const fila = aberta.filter((it) => it.status === 'Fila');
const aprovadosHoje = producao.filter((it) => aprovado.has(it.status) && sameDay(it.ultimaEdicao, today));
const aprovadosOntem = producao.filter((it) => aprovado.has(it.status) && sameDay(it.ultimaEdicao, yesterday));
const movidosOntem = producao.filter((it) => sameDay(it.ultimaEdicao, yesterday) && !aprovado.has(it.status) && it.status !== 'Fila');
const postadosHoje = social.filter((it) => it.status === 'Postado' && sameDay(it.ultimaEdicao, today));
const agendadosHoje = social.filter((it) => it.status === 'Agendado' && sameDay(it.dataPostagem, today));
const agendadosAmanha = social.filter((it) => it.status === 'Agendado' && sameDay(it.dataPostagem, tomorrow));

const output = {
  periodo: process.argv[2] || 'manual',
  datas: { today, yesterday, tomorrow },
  totais: {
    videos: videos.length,
    midias: midias.length,
    social: social.length,
    abertas: aberta.length,
    fila: fila.length,
    emProducao: emProducao.length,
    aguardandoAprovacao: aguardando.length,
    urgenciasAltas: urgentes.length,
    aprovadosHoje: aprovadosHoje.length,
    aprovadosOntem: aprovadosOntem.length,
    movidosOntem: movidosOntem.length,
    postadosHoje: postadosHoje.length,
    agendadosHoje: agendadosHoje.length,
    agendadosAmanha: agendadosAmanha.length,
  },
  rankings: {
    gargaloPorResponsavel: countBy([...urgentes, ...aguardando], 'responsavel').slice(0, 5),
    gargaloPorProjeto: countBy([...urgentes, ...aguardando], 'projeto').slice(0, 5),
    abertasPorStatus: countBy(aberta, 'status'),
  },
  itens: {
    urgenciasAltas: urgentes.slice(0, 25),
    aguardandoAprovacao: aguardando,
    emProducao: emProducao.slice(0, 25),
    fila: fila.slice(0, 25),
    aprovadosHoje: aprovadosHoje.slice(0, 25),
    aprovadosOntem: aprovadosOntem.slice(0, 25),
    movidosOntem: movidosOntem.slice(0, 25),
    postadosHoje: postadosHoje.slice(0, 25),
    socialHoje: agendadosHoje.slice(0, 25),
    socialAmanha: agendadosAmanha.slice(0, 25),
  },
};

console.log(JSON.stringify(output, null, 2));
