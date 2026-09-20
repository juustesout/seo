# Roadmap: Editor-Native Designer Agent

> Saved verbatim as the guiding brief for the UI rebuild phase. Dutch source
> text is preserved on purpose. This is the product direction for the R-series
> briefings; do not start R1 code before R0 (Product Reset & Experience
> Contract) is agreed.

De UI moet omgebouwd. We zijn erg functioneel bezig geweest en het moet even tot
een geheel gekneed worden met een goede UI. Dit is de roadmap voor die nieuwe
fase.

Dit wordt geen cosmetische verbouwing. We gaan de productervaring opnieuw
ordenen rond één uitgangspunt:

> De gebruiker werkt in de Editor. AI-functionaliteit komt naar de gebruiker
> toe, niet andersom.

De huidige Designer-, Composer- en Editor-pagina's zijn technisch begrijpelijk
opgebouwd, maar productmatig vormen ze nu losse kamers. De gebruiker moet straks
één professionele werkruimte ervaren waarin content, vormgeving, media, SEO en
AI logisch samenwerken.

De ambitie:

> Apple-achtig in eenvoud. Professioneel in resultaat. Volledige kracht onder de
> motorkap, zonder dat de gebruiker die hoeft te begrijpen.

Geen technisch dashboard vermomd als product. Geen workflows waarbij de
gebruiker eerst moet raden waar hij moet zijn.

## 1. Productprincipes voor deze verbouwing

Deze principes zijn leidend voor alle volgende Monkey-briefings.

### 1.1 De Editor is de primaire werkplek

De gebruiker opent een document en blijft daar.

Vanuit dezelfde werkplek kan hij:

- tekst schrijven en aanpassen;
- afbeeldingen invoegen;
- bestaande media laten zoeken;
- layout laten verbeteren;
- SEO laten controleren;
- content laten uitbreiden;
- content laten herschrijven;
- suggesties accepteren of afwijzen;
- publiceren of plannen.

De gebruiker hoeft niet naar een aparte Designer-pagina om een ontwerpactie uit
te voeren.

### 1.2 AI is een capability, geen bestemming

De Designer Agent is geen aparte wereld waar de gebruiker naartoe navigeert.

Het is een intelligente laag binnen de Editor:

- beschikbaar wanneer relevant;
- contextbewust;
- verbonden met het actieve document;
- verbonden met de cursor, selectie of actieve block;
- zichtbaar zonder de werkruimte over te nemen.

De gebruiker denkt niet:

> "Ik moet nu de Designer openen."

Maar:

> "Ik wil hier een passende afbeelding."

### 1.3 Directe feedback is belangrijker dan workflow-formaliteit

De gebruiker moet onmiddellijk kunnen zien wat een opdracht doet.

Bijvoorbeeld:

- gebruiker schrijft: "Zet hier een passende afbeelding";
- Agent begrijpt de locatie;
- Agent zoekt of kiest een geschikte afbeelding;
- afbeelding verschijnt op de juiste plek in de Editor;
- gebruiker kan direct doorgaan.

Voor risicovolle acties blijft bevestiging mogelijk, maar die bevestiging moet
plaatsvinden in de Editor, niet op een los review-scherm.

### 1.4 Complexiteit wordt verborgen, niet verwijderd

Onder de motorkap mogen blijven bestaan:

- durable runs;
- proposals;
- revisions;
- conflict detection;
- capabilities;
- MCP;
- auditability;
- permissions;
- deterministic asset selection;
- planner/executor;
- domain-specific agents.

Maar de gebruiker krijgt geen infrastructuur te zien tenzij die informatie
werkelijk helpt.

Geen:

- "document found";
- technische run-status als hoofdinterface;
- losse proposalpagina;
- content-ID's;
- revision hashes;
- interne agentterminologie.

### 1.5 Eén actie, één begrijpelijk resultaat

Elke gebruikersactie moet een duidelijke uitkomst hebben.

Bijvoorbeeld:

- "Afbeelding toegevoegd"
- "Tekst verbeterd"
- "SEO-titel voorgesteld"
- "3 varianten beschikbaar"
- "Kan geen geschikte afbeelding vinden"

Niet:

- "Run succeeded"
- "Proposal generated"
- "Agent execution completed"

Dat zijn interne toestanden, geen producttaal.

## 2. Doelarchitectuur van de gebruikerservaring

De toekomstige werkruimte:

```text
Project
└── Content Editor
    ├── Document canvas
    ├── Contextuele toolbar
    ├── Inline AI actions
    ├── Designer Agent input
    ├── Media insertion
    ├── Content suggestions
    ├── SEO intelligence
    ├── Undo / redo
    ├── Preview
    └── Publish / schedule
```

De Designer Agent werkt met de actuele context:

- Active project
- Active document
- Current document revision
- Current selection
- Active block
- Cursor position
- Nearby content
- Document structure
- Available media
- User instruction

De Editor wordt daarmee de orkestratielaag voor de gebruiker, terwijl de
bestaande backend-agentarchitectuur grotendeels herbruikbaar blijft.

## 3. Scope van deze verbouwing

We bouwen niet meteen alles opnieuw.

We voeren de verbouwing uit via verticale slices. Elke fase moet een tastbaar
productresultaat opleveren en mag geen nieuwe abstracte infrastructuur bouwen
zonder zichtbaar gebruikersvoordeel.

In scope:

- Editor als centrale werkplek;
- ingebouwde Designer Agent;
- contextbewuste opdrachten;
- inline acties;
- afbeeldingen en media;
- in-editor preview;
- directe toepassing met undo;
- eenvoudige feedback;
- professionele interaction design;
- geleidelijke integratie van SEO en content intelligence;
- behoud van bestaande backend-capabilities waar nuttig.

Buiten scope voor de eerste verbouwing:

- volledige collaborative editing;
- generieke agent marketplace in de UI;
- complexe multi-agent chat;
- volledige vrije canvas-editor;
- arbitrary CSS design system;
- automatische publicatie zonder gebruikerscontrole;
- een compleet nieuw backend-runframework;
- aparte pagina's voor elke AI-capability.

## 4. Nieuwe fasering

### Phase R0: Product Reset & Experience Contract

Doel: vastleggen hoe het product zich voor de gebruiker hoort te gedragen
voordat we verder bouwen.

Resultaat: een product- en UX-contract dat als handvat dient voor Monkey. Daarin
leggen we vast:

- Editor-first principe;
- welke pagina's primair zijn;
- welke bestaande pagina's blijven, verdwijnen of degraderen;
- interaction principles;
- terminologie;
- states en feedback;
- regels voor inline AI;
- regels voor context;
- regels voor preview en apply;
- regels voor fouten en onzekerheid.

Belangrijk besluit:

> De Editor is niet één module naast Designer. De Editor is het product.
> Designer is één van de intelligente mogelijkheden daarin.

### Phase R1: Editor Shell & Interaction Foundation

Doel: de Editor ombouwen tot een professionele werkruimte waarop de rest kan
landen.

Werkzaamheden:

- inventariseren van huidige Editor-componenten;
- verbeteren van de layout en visuele hiërarchie;
- document header;
- duidelijke save-status;
- undo/redo;
- preview;
- publish/schedule-acties;
- contextuele toolbar;
- selection state;
- actieve block state;
- vaste plek voor AI-assistentie;
- responsive gedrag;
- keyboard-first basis;
- rustige empty/loading/error states.

Gebruikersresultaat: de Editor voelt als een echte applicatie, niet als een
verzameling ontwikkelpanelen.

Nog geen volledige Designer-integratie. Deze fase legt de werkruimte vast. We
voorkomen dat AI later weer als los paneel wordt aangeplakt.

### Phase R2: Embedded Designer Agent Shell

Doel: de Designer Agent zichtbaar en bruikbaar maken vanuit de Editor.

Werkzaamheden:

- ingebouwde Agent command surface;
- openen vanuit toolbar, shortcut en contextmenu;
- compacte input;
- natuurlijke taal;
- actieve documentcontext automatisch gekoppeld;
- selectie en block-context automatisch meegestuurd;
- geen document selector;
- geen project selector;
- geen aparte Designer-route nodig voor edit-acties;
- duidelijke statusweergave;
- compacte inline feedback.

Voorbeeldinteractie: gebruiker selecteert een block en typt:

> "Maak dit wat professioneler."

Of:

> "Zet hier een passende afbeelding."

De Agent weet automatisch:

- welk project actief is;
- welk document actief is;
- waar de gebruiker werkt;
- wat er rondom de selectie staat.

Gebruikersresultaat: de gebruiker hoeft nooit meer uit de Editor te stappen om
een Designer-opdracht uit te voeren.

### Phase R3: First Vertical Slice, Image Insertion

Doel: één volledig werkende, extreem goede gebruikersflow bouwen. Dit is de
belangrijkste fase.

Eerste supported intent:

> "Zet hier een passende afbeelding."

Ook varianten zoals:

- "Voeg hier een afbeelding toe."
- "Zoek een passende foto voor dit gedeelte."
- "Maak dit visueel aantrekkelijker."
- "Zet een afbeelding boven deze tekst."
- "Gebruik een andere afbeelding."

Flow:

```text
User instruction
    ↓
Editor context captured
    ↓
Designer intent resolved
    ↓
Suitable asset selected
    ↓
Preview appears in current Editor
    ↓
User accepts, changes or undoes
    ↓
Document updated
```

Belangrijke UX-regel: de afbeelding verschijnt in de bestaande Editor, op de
bedoelde locatie.

Niet:

- op een aparte Designer-pagina;
- in een los documentvoorbeeld;
- in een modal met een tweede editor;
- achter een "open result"-knop.

Eerste versie mag beperkt zijn. Bijvoorbeeld:

- bestaande afbeeldingen uit de mediabibliotheek;
- beperkte ondersteunde blocktypes;
- één afbeelding per opdracht;
- eenvoudige plaatsing;
- bestaande deterministic asset selection.

Maar de flow moet volledig en professioneel voelen.

### Phase R4: In-Editor Proposal, Apply & Undo

Doel: de bestaande proposal- en revision-infrastructuur naar de juiste plek
brengen. De backend mag met proposals blijven werken. De gebruiker hoeft dat
niet te zien.

Gebruikersmodel. De gebruiker ziet:

- wijziging direct in context;
- subtiele markering van wat veranderd is;
- Apply;
- Undo;
- eventueel "Andere optie";
- eventueel "Niet gebruiken".

Technisch model. Onder water blijven mogelijk:

- base revision;
- proposal;
- stale revision check;
- explicit apply;
- conflict response;
- durable run;
- audit trail.

Productregel: preview en toepassing vinden plaats in de Editor. Een aparte
reviewpagina is voor deze flow niet toegestaan.

### Phase R5: Contextual Designer Actions

Doel: de Agent bruikbaar maken vanuit verschillende plekken in het document.

Contexten:

- Cursor-context: "Voeg hier een afbeelding toe."
- Geselecteerde tekst: "Herschrijf dit zakelijker."
- Geselecteerd block: "Maak dit visueel sterker."
- Sectie-context: "Geef deze sectie een betere structuur."
- Document-context: "Maak dit artikel duidelijker voor ondernemers."
- Media-context: "Gebruik een andere afbeelding met een zakelijkere uitstraling."

UI-oppervlakken:

- inline command;
- contextmenu;
- toolbar;
- keyboard shortcut;
- compacte Agent input;
- optionele suggestiechips.

Geen van deze acties mag de gebruiker naar een andere pagina sturen.

### Phase R6: Designer Capabilities as Native Editor Tools

Doel: bestaande Designer-domeinen beschikbaar maken als natuurlijke
Editor-acties.

Capabilities:

- content rewrite;
- content expansion;
- structure improvement;
- image selection;
- visual variants;
- layout improvements;
- metadata suggestions;
- alt text;
- SEO title;
- meta description;
- internal linking suggestions;
- readability improvements.

Belangrijk: de gebruiker hoeft niet te weten welk domein wordt aangeroepen. Hij
zegt:

> "Maak dit beter."

De applicatie bepaalt intern of dat betekent: content, layout, visual, SEO of
een combinatie daarvan. De interface moet niet worden georganiseerd rond
backend-domeinen.

### Phase R7: Unified Intelligence Layer

Doel: AI-functionaliteit samenbrengen zonder de Editor te overladen.

Mogelijke intelligentie:

- SEO-signalen;
- keyword context;
- GSC-data;
- DataForSEO;
- knowledge base;
- project tone of voice;
- doelgroep;
- content quality;
- media library;
- publication context.

Gebruikerservaring: de gebruiker krijgt geen technisch rapport als
standaardantwoord.

Bijvoorbeeld niet:

> "Content score 74/100, 6 failed checks."

Maar:

> "Dit stuk kan sterker. Ik zie drie verbeterpunten."

Met optionele details:

- "Toon waarom"
- "Pas toe"
- "Negeer"

Principe: progressive disclosure - eerst duidelijkheid, daarna diepte.

### Phase R8: Professional Polish & Product Quality

Doel: van functioneel naar professioneel product. Hier wordt streng gekeken naar
details die het verschil maken tussen "werkt" en "voelt af".

Onderwerpen:

- spacing;
- typography;
- visual hierarchy;
- animation;
- loading behavior;
- optimistic updates;
- keyboard navigation;
- focus management;
- undo feedback;
- error recovery;
- empty states;
- accessibility;
- responsive layout;
- mobile/tablet gedrag;
- latency perception;
- consistent iconography;
- microcopy;
- confirmation behavior;
- destructive action handling.

Producttest. Een niet-technische gebruiker moet zonder uitleg kunnen:

- een document openen;
- tekst aanpassen;
- een afbeelding toevoegen;
- AI om hulp vragen;
- wijziging beoordelen;
- doorgaan;
- publiceren.

Als daarvoor uitleg nodig is, is de interface nog niet klaar.

### Phase R9: Simplification Pass & Navigation Cleanup

Doel: alle oude architectuur zichtbaar opruimen uit de gebruikerservaring.

Onderzoek:

- Is de aparte Designer-pagina nog nodig?
- Is Composer nog een aparte bestemming?
- Welke functies horen in de Editor?
- Welke pagina's zijn alleen voor geavanceerde workflows?
- Welke navigatie-items zijn overbodig?
- Welke technische concepten lekken nog naar de gebruiker?

Waarschijnlijke richting:

| Onderdeel | Nieuwe rol |
| --- | --- |
| Editor | Centrale werkplek |
| Designer | Embedded capability |
| Composer | Mogelijk creation workflow, niet voor gewone edits |
| Media | Bibliotheek of contextueel onderdeel |
| SEO | Intelligence-paneel binnen project/editor |
| Publish | Editoractie |
| Agent runs | Interne infrastructuur, niet primaire navigatie |

## 5. Fasevolgorde in één overzicht

| Fase | Naam | Hoofdresultaat |
| --- | --- | --- |
| R0 | Product Reset & Experience Contract | Eén duidelijke productvisie |
| R1 | Editor Shell & Interaction Foundation | Professionele Editor-basis |
| R2 | Embedded Designer Agent Shell | Agent direct beschikbaar in Editor |
| R3 | Image Insertion Vertical Slice | Eerste volledige magie-flow |
| R4 | In-Editor Proposal, Apply & Undo | Veilige wijzigingen zonder aparte pagina |
| R5 | Contextual Designer Actions | Cursor-, selectie-, block- en documentcontext |
| R6 | Native Editor Capabilities | Content, visual, layout en SEO als natuurlijke acties |
| R7 | Unified Intelligence Layer | Contextuele intelligentie zonder overload |
| R8 | Professional Polish | Apple-achtige afwerking |
| R9 | Simplification & Navigation Cleanup | Oude losse workflows opruimen |

## 6. Wat we nadrukkelijk niet gaan doen

Vanaf nu gelden deze verboden voor nieuwe Monkey-briefings:

- geen nieuwe aparte Designer-pagina voor edit-acties;
- geen document selector binnen de Editor-agent;
- geen project selector als project al actief is;
- geen "document found"-meldingen;
- geen detached preview buiten de Editor;
- geen losse proposalpagina voor gewone wijzigingen;
- geen technische run-status als hoofdinterface;
- geen nieuwe route tenzij technisch noodzakelijk;
- geen nieuwe UI-box zonder concrete gebruikerswaarde;
- geen backend-capability bouwen zonder bijbehorende gebruikersflow;
- geen generieke chatinterface bouwen voordat de concrete interacties werken;
- geen "AI dashboard" dat de Editor overschaduwt.

## 7. Definition of Done voor de verbouwing

De verbouwing is pas geslaagd wanneer een gebruiker in de Editor dit kan doen:

> "Zet daar een passende afbeelding."

En vervolgens:

- de Agent begrijpt waar "daar" is;
- de Agent gebruikt de actieve documentcontext;
- de afbeelding wordt gevonden of er wordt eerlijk gemeld dat dit niet lukt;
- de afbeelding verschijnt op de juiste plek in de Editor;
- de gebruiker ziet wat er veranderd is;
- de gebruiker kan accepteren, wijzigen of ongedaan maken;
- de gebruiker blijft in dezelfde werkruimte;
- er zijn geen technische tussenstappen zichtbaar;
- de actie voelt snel, rustig en betrouwbaar;
- een niet-technische professional kan dit zonder instructie gebruiken.

Dat is onze eerste echte producttest.

## 8. Voorgestelde volgende stap

We beginnen niet direct met R1-code.

Eerst maken we:

- ADR Phase R0: Product Reset & Experience Contract.

Daarin leggen we de nieuwe productgrenzen vast en laten we Monkey eerst de
bestaande UI inventariseren tegen deze principes.

Daarna:

- Phase R1.1: Editor Shell Recon & Experience Foundation.

Pas na die recon schrijven we de concrete implementatiebrief.

De eerste echte bouwslice wordt vervolgens:

- Phase R3.1: Embedded Designer Image Insertion.

Dat is het moment waarop we niet meer praten over architectuur, maar testen of
het product eindelijk doet wat jij bedoelt:

> Ik werk in mijn document. Ik vraag iets. Het gebeurt daar.
