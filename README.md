# BR360 Automação

Automação local da BR360 para avisos e relatórios via WhatsApp.

## O que roda

- **Evolution API**: conexão com WhatsApp.
- **N8N**: mantido para credencial do Google Drive.
- **Monitor do Drive**: checa pastas selecionadas a cada 30 segundos e avisa arquivos novos.
- **Monitor do Notion**: checa status a cada 30 segundos e avisa quando item entra em `Aguardando aprovação`.
- **Relatório 08h**: envia relatório diário às 08h, todos os dias.

## Pastas monitoradas no Drive

- Beto & Prince
- Twister & Kaique
- Entregas internas

O monitor olha essas pastas e suas subpastas.

## Notion monitorado

- Database de Vídeos
- Database de Mídias

Responsáveis que disparam aviso:

- Beto
- Kaique
- Twister
- Prince

## Como rodar

1. Copie `.env.example` para `.env`.
2. Preencha as chaves reais no `.env`.
3. Suba os serviços:

```bash
docker compose up -d
```

## Serviços principais

```bash
docker compose ps
```

Logs:

```bash
tail -f drive_monitor.log
tail -f notion_aprovacao_monitor.log
tail -f relatorio_08h.log
```

## Testar relatório sem enviar

```bash
node relatorio_diario_08h.mjs --dry-run
```

## Observações de segurança

O arquivo `.env`, logs, estados e QR Codes não devem ser commitados. Eles ficam fora do Git pelo `.gitignore`.
