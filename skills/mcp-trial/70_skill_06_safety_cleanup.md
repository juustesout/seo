# Skill 06 — Veiligheid en cleanup

WBS: 70

## Doel
Verifieer de grenzen van de MCP-toegang en ruim de trial netjes op. Dit
bewijst dat een externe agent (Hermes) precies de toegang heeft die de key
geeft - niet meer.

## Stappen
1. Project-isolatie (Hermes)
   Laat Hermes een lees-actie proberen met een ander project-id dan dat van de
   key, bijv. `schedule_list` met een willekeurig ander UUID. Verwachting: de
   tool faalt met `project_id does not match` en er wordt niets geretourneerd.
2. Scope-grenzen (Hermes)
   - Maak (skill 01) een tijdelijke key met alleen `read`. Sluit de Hermes
     config daarop aan. Verwachting: schrijf-tools verschijnen niet en zijn
     niet aan te roepen.
   - Zet daarna de read+write key terug.
3. Geen destructieve kracht (Hermes)
   Bevestig dat er geen delete-tools in de lijst staan. Content/schedules/
   publicaties kunnen alleen in status veranderen (cancel bewaart historie);
   verwijderen doe je in de UI, niet via MCP.
4. Revoke (operator, in de web console of via skill 01 commando)
   Trek de `hermes-mcp-trial` key in via
   `POST /api/projects/<PROJECT_ID>/api-keys/<KEY_ID>/revoke`.
   Laat Hermes daarna een nieuwe sessie openen: die moet falen met HTTP 401.
5. Hygiëne
   - Verwijder de Hermes MCP-serverconfig (of zet de key erop bij een nieuwe
     proef) zodat er geen ingetrokken/onbewaakte key in Hermes blijft staan.
   - Test-publicaties die je niet wilt bewaren: annuleer ze in de UI
     (geschiedenis blijft; dat is bewust).
   - De API key is de enige credential die Hermes ooit zag: nooit Supabase
     service-role, `.env` of provider-secrets naar Hermes of logs.

## Verwachte output
- Alle pogingen buiten project/scope leveren een duidelijke fout op.
- Na revoke kan Hermes geen nieuwe sessie meer openen (bestaande sessies
  kunnen nog even leven tot ze sluiten - dat is normaal bij MCP-sessies).

## Acceptatie
- Hermes heeft nooit toegang gekregen tot een ander project, tot
  schrijf-acties met een read-only key, of tot delete-functionaliteit.
- Na revoke is de toegang weg.
- Geen geheimen gelekt naar chat/logs/commits.

## Rapportage aan de ontwikkelaar
Vul na de trial kort in:
- Welke skills 40-70 lukten, welke niet.
- Foutmeldingen letterlijk (job/publication error, HTTP-status).
- Of publicaties echt op het kanaal verschenen (Variant B).
- Eventuele gaten in deze skills of in de MCP-server.
