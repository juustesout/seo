# Skill 04 — Content flow (genereren / bijwerken / analyseren)

WBS: 50

## Doel
Bewijs dat Hermes een volledige content-schrijfstroom kan draaien via jobs:
draft genereren, volgen via de jobqueue, bijwerken en analyseren. Nooit
automatisch publiceren naar een kanaal.

## Beginsituatie
- Hermes verbonden met een key met `read` + `write` scope.
- Inhoud via skill 03 is zichtbaar (dit bestand gebruikt dezelfde project-id).

## Stappen
1. Laat Hermes een korte draft genereren (voorbeeldprompt):
   "Genereer content over 'Waarom interne links belangrijk zijn', taal nl,
   korte lengte, in project <PROJECT_ID>."
   Dit roept `content_generate` aan en retourneert onmiddellijk een job id.
2. Laat Hermes pollen tot de job klaar is:
   "Poll jobs_list tot de content_generate job met id <JOB_ID> klaar is."
   Een job is klaar zodra de status niet meer `running` is (succes/failed).
3. Vind het gegenereerde item:
   "Toon de nieuwste drafts in project <PROJECT_ID>." Gebruik `content_list`
   (status draft). Noteer het `<CONTENT_ID>`.
4. Laat Hermes het resultaat bekijken en bijwerken zonder te publiceren:
   "Haal content <CONTENT_ID> op en zet de meta_description op een
   samenvatting van maximaal 160 tekens" (`content_update`). Statuswijziging
   naar `in_review` is toegestaan; `published`/`archived` vereisen
   `confirm:true` en zijn voor deze trial niet nodig.
5. Laat Hermes de audit draaien: "Analyseer content <CONTENT_ID> en vat de
   drie belangrijkste issues samen." (`content_analyze`).

## Verwachte output
- content_generate: `{ job, note: "Job queued - poll jobs_list ..." }`.
- jobs_list toont voortgang en uiteindelijk een geslaagde content_generate
  job.
- content_get toont de draft met blocks; content_update bevestigt de nieuwe
  meta_description.
- content_analyze geeft score + issues/warnings terug.

## Acceptatie
- Hermes kan genereren, pollen, vinden, bijwerken en analyseren zonder een
  foutmelding over project-id of scopes.
- Er is niets naar een publisher gestuurd (publication_list bleef leeg voor
  dit item, tenzij je in skill 05 publiceert).

## Troubleshooting
- content_generate faalt met een providerfout: het project heeft geen
  AI/LLM-key geconfigureerd (server-side). Zonder AI-provider kan deze tool
  eerlijk niet draaien; meld dit als "niet geconfigureerd" en sla de rest
  van de skill over.
- De job blijft `running`: er draait geen worker op de VPS. Start
  `seo-worker` (zie project docs).
- Geen nieuw draft na een geslaagde job: check of de job daadwerkelijk
  `succeeded` was en of de draft misschien een andere status kreeg.
