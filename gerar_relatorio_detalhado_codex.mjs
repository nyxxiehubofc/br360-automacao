import { execFileSync } from 'node:child_process';

const periodo = process.argv[2] || 'manha';
const contexto = JSON.parse(execFileSync('node', ['coletar_contexto_codex.mjs', periodo], { encoding: 'utf8' }));

const dataBase = periodo === 'manha' ? contexto.datas.yesterday : contexto.datas.today;
const [ano, mes, dia] = dataBase.split('-');
const dataCurta = `${dia}/${mes}`;

function areaLabel(area) {
  return area === 'Videos' ? 'Videos' : 'Midias';
}

function resp(item) {
  return item.responsavel || 'Sem responsavel';
}

function shortStatus(status) {
  return status === 'Aguardando aprovação' ? 'Ag. aprovação' : status;
}

function byArea(items, area) {
  return items.filter((item) => item.area === area);
}

function lineItem(item, mode = 'status') {
  if (mode === 'responsavel') return `• ${item.nome} → ${resp(item)}`;
  if (mode === 'fila') return `• ${item.nome} (${resp(item)})`;
  if (mode === 'social') return `• ${item.nome} → ${item.projeto || item.status || 'Sem projeto'}`;
  return `• ${item.nome} → ${shortStatus(item.status)} (${resp(item)})`;
}

function list(items, emptyText, mode = 'status', limit = 8) {
  if (!items.length) return `— ${emptyText}`;
  const shown = items.slice(0, limit).map((item) => lineItem(item, mode));
  if (items.length > limit) shown.push(`• +${items.length - limit} itens`);
  return shown.join('\n');
}

function areaBlock(title, icon, items, emptyText, mode = 'responsavel') {
  return `${icon} *${title}*\n${list(items, emptyText, mode)}`;
}

function producaoSections(items, emptyText, mode = 'responsavel') {
  return [
    areaBlock('Vídeos (Beto & Prince)', '📹', byArea(items, 'Videos'), emptyText, mode),
    '',
    areaBlock('Mídias (Twister & Kaique)', '🖼️', byArea(items, 'Midias'), emptyText, mode),
  ].join('\n');
}

function header(label) {
  return `📊 *BR360 — Relatório ${dataCurta}${label ? ` — ${label}` : ''}*\n──────────────────`;
}

function manha() {
  return [
    header('08h'),
    '',
    '✅ *APROVADOS ONTEM*',
    producaoSections(contexto.itens.aprovadosOntem, 'Nenhum aprovado ontem'),
    '',
    '──────────────────',
    '🔄 *MOVIDOS DE STATUS*',
    list(contexto.itens.movidosOntem, 'Nenhum item movido ontem'),
    '',
    '──────────────────',
    '⏳ *AGUARDANDO APROVAÇÃO*',
    list(contexto.itens.aguardandoAprovacao, 'Nada aguardando aprovação', 'status', 999),
    '',
    '──────────────────',
    '📅 *NA FILA HOJE*',
    producaoSections(contexto.itens.fila, 'Nada na fila hoje', 'fila'),
    '',
    '──────────────────',
    '📱 *SOCIAL MEDIA HOJE*',
    list(contexto.itens.socialHoje, 'Nenhum post agendado para hoje', 'social'),
  ].join('\n');
}

function meioDia() {
  return [
    header('13h'),
    '',
    '✅ *APROVADOS HOJE*',
    producaoSections(contexto.itens.aprovadosHoje, 'Nenhum aprovado hoje'),
    '',
    '──────────────────',
    '🔄 *EM PRODUÇÃO / MODIFICANDO*',
    list(contexto.itens.emProducao, 'Nada em produção ou modificando'),
    '',
    '──────────────────',
    '⏳ *AGUARDANDO APROVAÇÃO*',
    list(contexto.itens.aguardandoAprovacao, 'Nada aguardando aprovação', 'status', 999),
    '',
    '──────────────────',
    '📱 *SOCIAL MEDIA*',
    '*Agendados hoje*',
    list(contexto.itens.socialHoje, 'Nenhum post agendado para hoje', 'social'),
  ].join('\n');
}

function noite() {
  return [
    header('19h'),
    '',
    '✅ *APROVADOS HOJE*',
    producaoSections(contexto.itens.aprovadosHoje, 'Nenhum aprovado hoje'),
    '',
    '──────────────────',
    '⏳ *AGUARDANDO APROVAÇÃO*',
    list(contexto.itens.aguardandoAprovacao, 'Nada aguardando aprovação', 'status', 999),
    '',
    '──────────────────',
    '🔄 *EM PRODUÇÃO / MODIFICANDO*',
    list(contexto.itens.emProducao, 'Nada em produção ou modificando'),
    '',
    '──────────────────',
    '📱 *SOCIAL MEDIA*',
    '*Postados hoje*',
    list(contexto.itens.postadosHoje || [], 'Nenhum postado hoje', 'social'),
    '',
    '*Agendados amanhã*',
    list(contexto.itens.socialAmanha, 'Nenhum post agendado para amanhã', 'social'),
  ].join('\n');
}

const output = periodo === 'meio_dia' ? meioDia() : periodo === 'noite' ? noite() : manha();
console.log(output);
