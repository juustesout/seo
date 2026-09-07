# Skill 03 — Ontdekken + read-only oefening

WBS: 40

## Doel
Laat Hermes de beschikbare tools en scopes ontdekken en bewijs dat lees-tools
echt data uit het project ophalen. Deze skill mag Hermes alleen laten lezen.

## Beginsituatie
- Hermes is verbonden (skill 02) met een key die minimaal `read` heeft.

## Stappen
1. Vraag Hermes de tool-lijst op te halen. Verwachte tools:

   | Tool | Scope | Doel |
   |---|---|---|
   | content_list | read | content items filteren |
   | content_get | read | een content item met blokken/HTML |
   | content_analyze | read | deterministische SEO-audit |
   | jobs_list | read | jobstatus pollen |
   | schedule_list | read | publicatieplanning lezen |
   | publication_list | read | publicatie-geschiedenis lezen |
   | publication_get | read | een publicatie-attempt lezen |

   Met `write` scope komen daar bij: content_generate,
   content_resolve_images, content_update, schedule_create,
   schedule_reschedule, schedule_cancel.

2. Laat Hermes dit uitvoeren (voorbeeldprompt):
   "Lijst de eerste 5 content items in project <PROJECT_ID>."
3. Laat Hermes het project controleren: "Hoeveel publicaties staan er op
   status failed in project <PROJECT_ID>? Welke publishers bestaan er?"
   (`publication_list` met `status:"failed"`.) Merk op: publishers zelf zijn
   geen MCP-tool; publicaties/schedules verwijzen ernaar.
4. Laat Hermes een item analyseren: `content_analyze` op een `<CONTENT_ID>`
   uit stap 2. Output bevat score/issues/warnings, geen wijzigingen.

## Verwachte output
- Tools verschijnen exact volgens de scope van de key.
- content_list retourneert echte projectinhoud (of een lege lijst als het
  project leeg is - dat is eerlijk, geen fout).
- content_analyze retourneert een audit zonder dat er iets wordt opgeslagen.

## Acceptatie
- Hermes geeft correct weer hoeveel content/publicaties er zijn, zonder
  project-id-fouten.
- Read-only key kan geen schrijf-tool aanroepen (melding tool niet
  beschikbaar / niet gevonden).

## Troubleshooting
- `project_id does not match the project this API key is bound to`: Hermes
  gebruikte een ander project-id dan dat van de key. Gebruik `<PROJECT_ID>`.
- Foutmelding over `publish_kind` kolom: DB-migratie 00017 ontbreekt op de
  hosted DB (zie skill 00, voorwaarden).
- Lege lijsten terwijl je inhoud verwacht: check het project-id, en of de
  content niet in een ander project staat.
