import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOTS = [
  { team: 'Beto & Prince', event: 'Temporada 26', id: '1XfZm9NPcJ1MbKAqO0CnLalYxjIk96WNJ' },
  { team: 'Twister & Kaique', event: 'Temporada 26', id: '1Km-OAh9DdaonR2VDyHe3Zuu1j7KKtlB0' },
  { team: 'Entregas internas', event: '26', id: '1xAvITsiYTZFXvPkuTq43htrTXdAYJ8cc' },
];

const INTERVAL_MS = 30_000;
const FOLDER_REFRESH_MS = 5 * 60_000;
const STATE_FILE = 'drive_monitor_state.json';
const LOG_FILE = 'drive_monitor.log';
const PID_FILE = 'drive_monitor.pid';
const CREDENTIAL_ID = 'Ovl2iGrQqCR8kNmn';
const N8N_CONTAINER = 'br360-automacao-n8n-1';
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://localhost:8080/message/sendText/br360';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY;
const WHATSAPP_GROUP = process.env.WHATSAPP_GROUP;

let credentials;
let accessToken;
let accessTokenExpiresAt = 0;
let folders = [];
let foldersLoadedAt = 0;

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
      seen: {},
      sent: [],
    };
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function writeState(state) {
  const seenIds = Object.keys(state.seen);
  if (seenIds.length > 10_000) {
    for (const id of seenIds.slice(0, seenIds.length - 8_000)) delete state.seen[id];
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadCredentialsFromN8N() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br360-google-cred-'));
  const containerFile = `/tmp/google_cred_${Date.now()}.json`;
  const localFile = path.join(tmpDir, 'google_cred.json');

  execFileSync('docker', [
    'exec',
    N8N_CONTAINER,
    'n8n',
    'export:credentials',
    `--id=${CREDENTIAL_ID}`,
    '--decrypted',
    `--output=${containerFile}`,
  ]);
  execFileSync('docker', ['cp', `${N8N_CONTAINER}:${containerFile}`, localFile]);
  execFileSync('docker', ['exec', N8N_CONTAINER, 'rm', '-f', containerFile]);

  const exported = JSON.parse(fs.readFileSync(localFile, 'utf8'));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const credential = Array.isArray(exported) ? exported[0] : exported;
  const data = credential?.data;
  const tokenData = data?.oauthTokenData;

  if (!data?.clientId || !data?.clientSecret || !tokenData?.refresh_token) {
    throw new Error('Credencial do Google Drive sem clientId/clientSecret/refresh_token.');
  }

  credentials = {
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    refreshToken: tokenData.refresh_token,
  };
}

async function refreshAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt - 60_000) return accessToken;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`Google token: ${JSON.stringify(json)}`);

  accessToken = json.access_token;
  accessTokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
  return accessToken;
}

async function driveList(params) {
  const token = await refreshAccessToken();
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`Drive API: ${JSON.stringify(json)}`);
  return json.files || [];
}

async function listChildFolders(parentId) {
  return driveList({
    q: `'${parentId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
    fields: 'files(id,name,modifiedTime)',
    pageSize: '1000',
  });
}

async function listDirectFiles(parentId) {
  return driveList({
    q: `'${parentId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
    fields: 'files(id,name,webViewLink,createdTime,modifiedTime,mimeType,parents)',
    pageSize: '1000',
    orderBy: 'createdTime desc',
  });
}

async function walkFolders(folder, pathParts = [], result = []) {
  const currentPath = [...pathParts, folder.event || folder.name].filter(Boolean);
  result.push({ team: folder.team, event: currentPath.join(' / '), id: folder.id });

  const children = await listChildFolders(folder.id);
  for (const child of children) {
    await walkFolders({ team: folder.team, event: child.name, id: child.id }, currentPath, result);
  }

  return result;
}

async function refreshFolders(force = false) {
  if (!force && folders.length && Date.now() - foldersLoadedAt < FOLDER_REFRESH_MS) return;

  const nextFolders = [];
  for (const root of ROOTS) {
    await walkFolders(root, [], nextFolders);
  }
  folders = nextFolders;
  foldersLoadedAt = Date.now();
  fs.writeFileSync('br360_drive_folders.json', JSON.stringify(folders, null, 2));
  log(`Pastas monitoradas: ${folders.length}`);
}

async function sendWhatsApp(text) {
  const response = await fetch(EVOLUTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: EVOLUTION_KEY,
    },
    body: JSON.stringify({
      number: WHATSAPP_GROUP,
      text,
    }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`Evolution: ${JSON.stringify(json)}`);
  return json?.key?.id || 'sem-id';
}

function eventName(pathName) {
  const parts = String(pathName)
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  const event = parts.find((part) => /\b\d{2}\b/.test(part) && !/^temporada\b/i.test(part)) || parts.at(-1) || pathName;
  return event.replace(/^\d+\.\s*/, '').trim();
}

async function scan() {
  const state = readState();
  await refreshFolders();

  let newFiles = 0;
  for (const folder of folders) {
    const files = await listDirectFiles(folder.id);
    const ordered = files
      .filter((file) => file.id && file.name)
      .sort((a, b) => new Date(a.createdTime || a.modifiedTime || 0) - new Date(b.createdTime || b.modifiedTime || 0));

    for (const file of ordered) {
      if (state.seen[file.id]) continue;

      state.seen[file.id] = {
        name: file.name,
        folderId: folder.id,
        firstSeenAt: new Date().toISOString(),
      };

      if (!state.initialized) continue;

      const link = file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`;
      const text = `☁️ *Novo arquivo no Drive*\n\nEquipe/Pasta: *${folder.team}*\nEvento: *${eventName(folder.event)}*\nArquivo: ${file.name}\nLink: ${link}`;
      const messageId = await sendWhatsApp(text);
      newFiles += 1;
      state.sent.push({
        fileId: file.id,
        name: file.name,
        messageId,
        sentAt: new Date().toISOString(),
      });
      log(`Enviado WhatsApp: ${file.name} (${messageId})`);
    }
  }

  state.initialized = true;
  state.lastScanAt = new Date().toISOString();
  writeState(state);
  log(`Scan concluido. Novos arquivos enviados: ${newFiles}`);
}

async function main() {
  if (!EVOLUTION_KEY) throw new Error('EVOLUTION_KEY nao encontrado no ambiente.');
  if (!WHATSAPP_GROUP) throw new Error('WHATSAPP_GROUP nao encontrado no ambiente.');

  fs.writeFileSync(PID_FILE, String(process.pid));
  log('Iniciando monitor do Drive a cada 30 segundos.');
  loadCredentialsFromN8N();
  await refreshFolders(true);
  await scan();
  setInterval(() => {
    scan().catch((error) => log(`Erro no scan: ${error.stack || error.message}`));
  }, INTERVAL_MS);
}

main().catch((error) => {
  log(`Erro fatal: ${error.stack || error.message}`);
  process.exit(1);
});
