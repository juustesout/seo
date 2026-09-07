# Skill 05 — Publish flow (plannen / verplaatsen / cancelen / publiceren)

WBS: 60

## Doel
Bewijs dat Hermes een publicatie kan plannen, verplaatsen en annuleren via de
scheduling-tools, en dat een echt publicatie-attempt (bijv. naar X) via de
worker wordt uitgevoerd. Start met de veilige variant (A: alleen plannen +
cancelen) en doe daarna pas de echte post (B).

## Beginsituatie
- Hermes verbonden met een key met `read` + `write` scope.
- Het project heeft een verbonden publisher met de juiste capability:
  - tekst-post naar X: publisher met `publish_text` en `publish_kind: text`;
  - artikel naar WordPress: publisher met `publish_article` en
    `publish_kind: article`.
- Een `<CONTENT_ID>` uit het project (skill 03/04).

## Variant A — plan en cancel (geen echte post)
1. Laat Hermes plannen op een moment over ~5 minuten:
   "Plan content <CONTENT_ID> voor publicatie via publisher <PUBLISHER_ID> als
   text op <TIJD+05min, ISO-8601 met tijdszone> in project <PROJECT_ID>."
   Gebruik bijvoorbeeld `scheduled_at` = `2026-09-08T09:05:00+02:00` (altijd
   met offset, `Z` of `+hh:mm`).
2. Controleer: "Toon de schedules van project <PROJECT_ID>" - het item staat
   op `scheduled`.
3. Annuleer: "Cancel schedule <SCHEDULE_ID> in project <PROJECT_ID>."
4. Controleer: status is `cancelled`; er is geen publicatie-attempt gelopen.

## Variant B — echte publicatie (alleen als je een echte post wilt)
1. Plan op +2 minuten zoals in variant A.
2. Laat Hermes pollen tot na het tijdstip: "Poll jobs_list en publication_list
   in project <PROJECT_ID> tot de publicatie een eindstatus heeft."
3. Bij succes heeft publication_list een rij met `status: published`,
   `remote_id` en `target_url`. Open `target_url` en verifieer de post op het
   kanaal (bijv. x.com).
4. Bij falen toont publication_list `status: failed` met `error`; geef die
   melding door, verzint Hermes niets (honesty rule).

## Verplaatsen (optioneel)
"Verplaats pending schedule <SCHEDULE_ID> naar <TIJD+10min> in project
<PROJECT_ID>." (`schedule_reschedule`). Dezelfde backing job wordt verplaatst;
er ontstaat geen tweede publicatie.

## Verwachte output
- schedule_create retourneert het schedule-object (id, content, publisher,
  status `scheduled`).
- schedule_reschedule verplaatst; schedule_cancel zet op `cancelled` en
  bewaart de geschiedenis (rij wordt nooit verwijderd).
- Variant B: publication_list toont `published` met remote_id/target_url of
  `failed` met een echte foutmelding.

## Acceptatie
- Hermes kan de volledige cyclus draaien zonder handmatige DB/UI-ingreep.
- Een write-actie zonder `write` scope faalt; `project_id` van een ander
  project wordt geweigerd.
- Times zonder tijdszone-offset worden geweigerd (`invalid_datetime`).

## Troubleshooting
- `Publisher ... cannot publish ... (capabilities: ...)`: verkeerde
  publish_kind voor deze publisher. Gebruik `text` voor X, `article` voor
  WordPress, of kies de juiste publisher.
- Publicatie blijft `queued`/`publishing`: draait `seo-worker` op de VPS?
- `failed` met fout over credentials: publisher niet (meer) verbonden; test
  de verbinding in de UI en connect opnieuw.
- Deze skill is na succes klaar: bedenk geen extra MCP-tools, webhooks of
  autonome scheduling (buiten scope van deze trial).
