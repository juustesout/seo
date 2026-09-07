# Skill 02 — Hermes configureren en verbinden

WBS: 30

## Doel
Hermes zo configureren dat het verbinding maakt met
`https://<PUBLIC_API_BASE>/api/mcp` met de project API key uit skill 01, en
de verbinding valideren.

## Beginsituatie
- Een geldige `seo_live_...` key (skill 01).
- Het MCP endpoint is publiek bereikbaar.

## Stap 1 — endpoint controleren zonder client
Zonder key moet de server weigeren, met key moet hij een MCP initialize
accepteren.

```
curl -i -X POST https://<PUBLIC_API_BASE>/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```

Verwachting: HTTP 401 (geen Authorization header). Daarna hetzelfde met
`-H "Authorization: Bearer <API_KEY>"`: HTTP 200, header `Mcp-Session-Id`,
JSON of SSE met `serverInfo.name = "seo-mcp"`.

## Stap 2 — Hermes MCP config
Hermes desktop agents configureren MCP servers per client. Voeg een
streamable-HTTP MCP server toe met de volgende waarden (velden aanpassen aan
de Hermes MCP-instellingen van jouw installatie):

| Veld | Waarde |
|---|---|
| type | `http` (streamable HTTP) |
| url | `https://<PUBLIC_API_BASE>/api/mcp` |
| authorization | `Bearer <API_KEY>` |
| header(s) | `Authorization: Bearer <API_KEY>` als de client headers apart vraagt |

Als Hermes alleen stdio ondersteunt, is er een tweede optie: draai lokaal

```
MCP_API_KEY=<API_KEY> node --env-file=apps/api/.env apps/api/dist/mcp/index.js
```

maar dat vereist de service-role `.env` lokaal. De HTTP-route is de
aanbevolen weg zodat geheimen op de VPS blijven.

## Verwachte output
- Hermes toont de server `seo-mcp` en de tools (zie skill 03).
- Zonder geldige key: verbinding mislukt met HTTP 401.

## Acceptatie
- Hermes kan `tools/list` uitvoeren en ziet minimaal `content_list`,
  `schedule_list`, `publication_list`, `jobs_list`.
- Bij een key met alleen `read` scope ziet Hermes geen schrijf-tools.

## Troubleshooting
- Verbinding blijft hangen / SSL-fout: is de VPS-reverse proxy ingesteld om
  `/api` naar de API (poort 3001) te sturen en loopt er TLS?
- `404` op `/api/mcp`: draait de nieuwste build? Het endpoint bestaat sinds
  de MCP Remote Transport fase; herstart `seo-api` na `git pull` + build.
- `401` ondanks key: key ingetrokken of uit ander project? Maak in skill 01
  een verse key en zet hem in Hermes.
