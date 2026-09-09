# W10 roadmap — controlled "magic" capabilities for the Writer agent

Scope of the W10 milestone. Build in phases; each phase is shipped and
verified before the next starts. Never merge everything into one giant agent
prompt.

## Feature catalog (target state)

- W10.1 Research & Evidence
- W10.2 Writer Intelligence
- W10.3 Section-level Magic
- W10.4 Revision Strategies
- W10.5 Internal Critic
- W10.6 Source & Claim Awareness
- W10.7 Final Polish

## Architecture

W10 is not a "super-agent with twenty tools". It extends the existing Writer
graph with explicit AI boundaries:

```
Writer Graph
     |
     |-- Context
     |
     |-- Planner
     |
     |-- Section Writer
     |
     |-- Revision Writer
     |
     |-- AI Critic
     |
     `-- Deterministic Review
```

Every AI boundary follows the same shape:

```
explicit dependency
      |
      v
bounded input
      |
      v
structured output
      |
      v
Zod validation
      |
      v
honest failure
```

Never:

```
LLM
  |
  v
arbitrary tools
  |
  v
arbitrary services
  |
  v
arbitrary writes
```

## Capability model

W10 adds only these explicit Writer capabilities:

- `strategy.analyze`
- `evidence.analyze`
- `section.transform`
- `critique.analyze`

Still forbidden:

- `credentials.read`
- `publish.execute`
- `schedule.execute`
- `api_keys.read`
- `project.admin`
- `database.direct`
- `network.arbitrary`
- `mcp.invoke`
- `shell.execute`

All new features resolve AI through the existing `AIService.resolve(projectId)`.
Credential access stays outside the Writer.

## UI principles

The Writer UI is a creative workspace, not a chatbot. No free-form "ask the AI
anything" box. Use targeted controls:

```
ARTICLE        [ Strategy ]

SECTION 1      [ Improve ] [ Shorten ] [ Expand ]
SECTION 2      [ Improve ] [ Simplify ] [ Alternative ]

ARTICLE        [ Critique ] [ Evidence ] [ Final polish ]
```

Every action shows:

```
Working...
      |
      v
Proposal / Result
      |
      v
User decides
```

No auto-apply.

## Per-phase contracts

### W10.1 Research & Evidence

The Writer must understand: what do we already know, what information is
missing, which topics are under-covered, which existing project sources are
relevant.

Phase constraint: only existing, safe project sources are used — Knowledge
Base, Qdrant, existing content, GSC, DataForSEO intelligence, existing project
data. No arbitrary web browsing. The W1 context layer stays the security
boundary.

After context gathering the Writer deterministically / AI-assisted assesses
coverage per planned section, e.g. `sufficient` / `partial` / `insufficient`,
and reports what evidence supports each section (e.g. knowledge: 3 relevant
sources, existing content: 1 related article, GSC: no useful signal).

The Writer may say "I have insufficient project evidence to support this claim
reliably" but must never fabricate evidence.

```ts
interface WriterEvidence {
  sourceType:
    | "knowledge"
    | "existing_content"
    | "gsc"
    | "intelligence";
  sourceId?: string;
  relevance: "high" | "medium" | "low";
  excerpt?: string;
  trust: "untrusted";
}
```

No credentials, no provider internals, no unbounded full documents.

### W10.2 Writer Intelligence

A "thinking dashboard": structured reasoning results explicitly intended for
the user, not hidden chain-of-thought.

```ts
interface WriterStrategy {
  searchIntent:
    | "informational"
    | "commercial"
    | "transactional"
    | "navigational"
    | "mixed";
  audienceLevel: "beginner" | "intermediate" | "advanced";
  recommendedDepth: "light" | "standard" | "comprehensive";
  cannibalizationRisk: "low" | "medium" | "high";
  notes: string[];
}
```

Bounded and Zod-validated. Example surface: primary intent, target audience,
recommended depth, content opportunity, existing content overlap,
cannibalisation risk.

### W10.3 Section Magic

Per-section user-chosen actions:

- improve
- expand (add depth)
- shorten
- simplify
- improve SEO
- explain better
- alternative version

Each action carries: action, target section, bounded instruction, current
section, approved plan, relevant context.

```ts
type SectionMagicAction =
  | "improve"
  | "expand"
  | "shorten"
  | "simplify"
  | "improve_seo"
  | "alternative";
```

Security invariant: an action may only change the selected section.

```
Section 3
   |
   v
Magic: Improve SEO
   |
   v
Proposal
   |
   v
User accepts
   |
   v
Section 3 updated
```

Never: Section 3 -> AI -> entire article silently rewritten.

### W10.4 Revision Strategies

W8 already revises selected sections; W10 makes the revision instructions
smarter with named strategies:

```ts
type WriterRevisionStrategy =
  | "custom"
  | "improve"
  | "expand"
  | "shorten"
  | "simplify"
  | "seo"
  | "clarity"
  | "authority"
  | "examples";
```

The UI may offer several strategies, but the end result is always one bounded
revision request:

```ts
{
  sections: ["section_2", "section_4"],
  strategy: "clarity",
  instruction: "..."
}
```

The existing W8 revision boundary stays responsible for section validation,
project isolation, bounds, hostile instruction containment and lifecycle
transitions. W10 must not duplicate or bypass W8 security.

### W10.5 Internal Critic

Optional AI critic. The AI critic is distinct from the deterministic SEO
evaluator: the evaluator stays the source of truth for SEO score, SEO checks
and deterministic issues; the critic gives qualitative feedback only
(strengths, weaknesses, suggestions). No automatic changes; the output is a
proposal and the user explicitly chooses what to do with it.

```ts
interface WriterCritique {
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
}
```

### W10.6 Claim & Source Awareness

The Writer distinguishes general explanation, claims based on project
evidence, and potentially unsupported factual claims. Not a full academic
citation engine; a bounded evidence association per section:

```ts
interface SectionEvidenceSummary {
  supportedTopics: string[];
  weaklySupportedTopics: string[];
  unsupportedClaims: string[];
}
```

Crucial rule: retrieved knowledge is not the same as verified fact. Retrieved
project content stays `trust: "untrusted"` even when it comes from the
project's own Knowledge Base.

### W10.7 Final Polish

Optional, requested by the user while content is `review_ready`. Polish does
not rewrite strategy, change topic, change project identity, publish anything,
or change metadata without explicit selection. Possible actions: improve flow,
remove repetition, improve consistency, improve transitions, grammar/style
polish. The result is again a proposal, never a silent overwrite. After
polish: review -> `review_ready`, and the existing deterministic review runs
again.

## Implementation order

1. Section Magic foundation (improve / expand / shorten / simplify /
   alternative) — reuse the W8 revision infrastructure; most value for least
   architectural churn.
2. Revision strategies (clarity / seo / authority / examples) on the same
   infrastructure.
3. AI critic — read-only analysis, structured result, user decides, no writes.
4. Strategy & intelligence — article-level intent / audience / depth / overlap
   / opportunity.
5. Evidence awareness — supported / weak / unsupported per section, no fake
   citations.
6. Final polish — optional article-level transformation, always proposal ->
   review -> `review_ready`.

## Out of scope for W10

- Autonomous publishing
- Autonomous web browsing
- Arbitrary tool calling
- Agent-to-agent delegation
- Hidden chain-of-thought
- AI-determined permissions
- AI-determined project access
- Direct credential access
- "Chat with unrestricted agent"
- Self-modifying workflows

## Definition of done (per W10 subphase)

- Existing W0-W9 invariants stay intact
- Capability surface stays explicit
- AI output is schema-validated
- All inputs bounded
- Project isolation stays enforced
- No silent content overwrite
- Every mutation is explicitly scoped
- Deterministic review stays authoritative for SEO
- AI failures are honest
- Security regression tests stay green

Required gates:

```
pnpm --filter @seo/contracts build
pnpm --filter @seo/api typecheck
pnpm --filter @seo/api test
pnpm --filter @seo/api build
pnpm --filter @seo/web typecheck
pnpm --filter @seo/web test
pnpm --filter @seo/web build
```

Fresh DB migration smoke when the schema changes.
