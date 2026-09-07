# Skill 01 — Project API key provisioneren

WBS: 20

## Doel
Maak een project API key (`seo_live_...`) voor de Hermes-sessie. De key is
gebonden aan een project en heeft `read` en/of `write` scopes. De plaintext
key wordt precies eenmaal getoond; bewaar hem direct veilig.

## Beginsituatie
- Je bent ingelogd in de web app met een account dat admin is van het project.
- Het project id is bekend (UUID in de URL, bijv.
  `https://<PUBLIC_API_BASE>/p/<PROJECT_ID>/...`).

## Stappen
1. Haal een sessie-JWT op van de ingelogde web app:
   - DevTools openen op de web app.
   - Application tab -> Local Storage -> sleutel die begint met `sb-` ->
     de JSON bevat een `access_token`. Kopieer die waarde.
   - (Sneller alternatief in de console: na `fetch('/api/health')` is er geen
     token; gebruik de Local Storage route hierboven.)
2. Maak de key aan (admin-only endpoint):
   ```
   curl -X POST https://<PUBLIC_API_BASE>/api/projects/<PROJECT_ID>/api-keys \
     -H "Authorization: Bearer <SESSION_JWT>" \
     -H "Content-Type: application/json" \
     -d '{"name":"hermes-mcp-trial","scopes":["read","write"]}'
   ```
   Wil je Hermes alleen laten lezen, gebruik dan `"scopes":["read"]`.
3. Het antwoord bevat `data.key` (begint met `seo_live_`) plus de opmerking
   dat de key niet opnieuw getoond wordt. Sla deze veilig op.

## Verwachte output
- HTTP 201 met `data.key = seo_live_...`, `data.scopes`, `data.id`.
- Bij fouten: HTTP 401 (geen/ongeldige sessie) of 403 (geen admin).

## Acceptatie
- De key werkt tegen het platform: zie skill 02.
- Een tweede aanroep van stap 2 met dezelfde naam maakt gewoon een nieuwe key;
  wil je oude keys zien of intrekken, gebruik dan:

  ```
  curl https://<PUBLIC_API_BASE>/api/projects/<PROJECT_ID>/api-keys \
    -H "Authorization: Bearer <SESSION_JWT>"
  curl -X POST https://<PUBLIC_API_BASE>/api/projects/<PROJECT_ID>/api-keys/<KEY_ID>/revoke \
    -H "Authorization: Bearer <SESSION_JWT>"
  ```

## Troubleshooting
- `401` bij stap 2: sessie-JWT verlopen of verkeerd gekopieerd (kopieer
  `access_token`, niet `refresh_token`).
- `403`: het account is geen admin van dit project.
- Geen `data.key` in de response: de key is al weg; maak een nieuwe aan.
