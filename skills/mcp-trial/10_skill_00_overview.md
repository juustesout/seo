# Skill 00 — Overview: Hermes MCP trial

WBS: 10

## Doel
Laat de Hermes desktop agent als externe MCP-client werken tegen het SEO
platform, remote via HTTPS. Hermes krijgt een project API key
(`seo_live_...`) en praat daarmee tegen dezelfde SEO Core services als de web
UI en de REST API (one brain, two mouths). De key bepaalt project en scopes;
Hermes krijgt nooit Supabase/service-role toegang.

## Architectuur (waar Hermes tegenaan praat)

```
Hermes desktop
    |  HTTPS + Authorization: Bearer seo_live_...
    v
https://<PUBLIC_API_BASE>/api/mcp     (streamable HTTP)
    |  ApiKeyStore: hash-check, actief?, niet revoked
    |  context: { project_id, read/write scopes }
    v
MCP tool registry (content/schedule/publication/jobs)
    |  dezelfde services als REST en de UI
    v
Supabase + providers (alleen server-side)
```

De stdio-entry (`dist/mcp/index.js`, MCP_API_KEY env) en de HTTP-entry
(`/api/mcp`) delen exact dezelfde registry en context-bouwer
(`apps/api/src/mcp/session.ts`).

## Voorwaarden
- API + worker gedeployed en publiek bereikbaar (zowel `/api` als `/api/mcp`).
- Een project met inhoud. Voor publicatie-skills: een verbonden publisher
  (bijv. X) in dat project.
- Supabase SQL migration `20260101000017_publish_kind.sql` is toegepast op de
  hosted DB (anders falen schedule/publication reads en writes).

## Lezen van de reeks
Elke skill heeft: Doel / Beginsituatie / Stappen / Verwachte output /
Acceptatie / Troubleshooting. Voer ze in volgorde uit; skills bouwen op
elkaar (ids uit skill 01 worden in latere skills gebruikt).

| Skill | Onderwerp | WBS |
|---|---|---|
| 00 | Overview (dit bestand) | 10 |
| 01 | Project API key provisioneren | 20 |
| 02 | Hermes configureren en verbinden | 30 |
| 03 | Ontdekken + read-only oefening | 40 |
| 04 | Content flow (genereren / analyseren) | 50 |
| 05 | Publish flow (plannen / publiceren / cancel) | 60 |
| 06 | Veiligheid en cleanup | 70 |

## Plaatshouders
Vervang deze door eigen waarden:

| Plaatshouder | Betekenis |
|---|---|
| `<PUBLIC_API_BASE>` | publieke API origin, bijv. `https://www.oldskoolseo.com` |
| `<PROJECT_ID>` | UUID van het project |
| `<API_KEY>` | `seo_live_...` project API key (alleen in skill 01 zichtbaar) |
| `<PUBLISHER_ID>` | UUID van de verbonden publisher |
| `<CONTENT_ID>` | UUID van een content item |

## Belangrijke afspraken voor Hermes
- `project_id` tool-argumenten mogen alleen het project van de gebonden key
  zijn; iets anders wordt geweigerd (`project_id does not match`).
- Schrijf-tools vereisen dat de key `write` scope heeft; lees-tools `read`.
- Destructieve acties vragen `confirm` en zijn beperkt; delete-tools bestaan
  niet. Annuleren bewaart geschiedenis.
- Lange operaties (content_generate, content_resolve_images) zijn jobs: poll
  `jobs_list` tot ze klaar zijn, ga niet op gokken.
