/**
 * Cosmos Controls: project-level editorial/brand configuration.
 *
 * Cosmos is configuration, not an agent - it never generates content. These
 * grouped, bounded fields (Identity / Voice / Editorial / SEO / Knowledge) are
 * read by AI features as context. Values persist to
 * `seo_projects.settings.cosmos`; an editor+ saves them explicitly, matching the
 * existing project-settings convention.
 */
import { useEffect, useState } from 'react';
import {
  COSMOS_FIELD_MAX_CHARS,
  emptyCosmosConfig,
  parseCosmosConfig,
  type CosmosConfig,
  type CosmosSectionId,
} from '@seo/contracts';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/ui';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

interface FieldSpec {
  key: string;
  label: string;
  placeholder: string;
  multiline?: boolean;
}

const SECTIONS: Array<{ id: CosmosSectionId; title: string; description: string; fields: FieldSpec[] }> = [
  {
    id: 'identity',
    title: 'Identity',
    description: 'Who the site is and who it is for.',
    fields: [
      { key: 'name', label: 'Site / project name', placeholder: 'e.g. Acme Analytics' },
      { key: 'description', label: 'Positioning', placeholder: 'What the site is about, in one or two sentences', multiline: true },
      { key: 'audience', label: 'Target audience', placeholder: 'Who the content is written for', multiline: true },
    ],
  },
  {
    id: 'voice',
    title: 'Voice',
    description: 'How the writing should sound.',
    fields: [
      { key: 'tone', label: 'Tone', placeholder: 'e.g. confident, friendly, matter-of-fact' },
      { key: 'formality', label: 'Formality', placeholder: 'e.g. neutral, informal, formal' },
      { key: 'personality', label: 'Personality', placeholder: 'e.g. concise and practical, no hype' },
      { key: 'vocabulary', label: 'Preferred vocabulary', placeholder: 'Terms to favour (or avoid) and phrasing preferences', multiline: true },
    ],
  },
  {
    id: 'editorial',
    title: 'Editorial',
    description: 'Structure and non-negotiable writing rules.',
    fields: [
      { key: 'writingRules', label: 'Writing rules', placeholder: 'One rule per line', multiline: true },
      { key: 'preferredStructure', label: 'Preferred structure', placeholder: 'e.g. intro, 3-5 H2 sections, short conclusion', multiline: true },
      { key: 'articleCharacteristics', label: 'Article characteristics', placeholder: 'What good articles look like for this site', multiline: true },
      { key: 'forbidden', label: 'Forbidden patterns / terminology', placeholder: 'Phrases, claims or words to never use', multiline: true },
    ],
  },
  {
    id: 'seo',
    title: 'SEO',
    description: 'Standing SEO/editorial rules for search.',
    fields: [
      { key: 'rules', label: 'General SEO rules', placeholder: 'e.g. answer the query in the first paragraph', multiline: true },
      { key: 'searchIntent', label: 'Search-intent handling', placeholder: 'How to match informational / commercial intent', multiline: true },
      { key: 'internalLinking', label: 'Internal-linking guidance', placeholder: 'How and when to link other pages', multiline: true },
    ],
  },
  {
    id: 'knowledge',
    title: 'Knowledge',
    description: 'How project knowledge should be used as context.',
    fields: [{ key: 'notes', label: 'Guidance', placeholder: 'When to rely on the knowledge base, what is trusted', multiline: true }],
  },
];

function valueOf(config: CosmosConfig, section: CosmosSectionId, field: string): string {
  const bag = config[section] as unknown as Record<string, unknown>;
  const value = bag[field];
  return typeof value === 'string' ? value : '';
}

export function CosmosPanel({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const state = useAsync<unknown>(() => api(`/projects/${projectId}/cosmos`), [projectId]);
  const [config, setConfig] = useState<CosmosConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (state.data !== null && state.data !== undefined) setConfig(parseCosmosConfig(state.data));
  }, [state.data]);

  if (state.loading && !config) return <p className="text-sm text-muted-foreground">Loading Cosmos…</p>;
  if (state.error)
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {state.error}
      </div>
    );
  if (!config) return null;

  const setField = (section: CosmosSectionId, field: string, value: string) => {
    setConfig((current) =>
      current
        ? { ...current, [section]: { ...(current[section] as unknown as Record<string, unknown>), [field]: value } }
        : current,
    );
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const saved = await api<unknown>(`/projects/${projectId}/cosmos`, {
        method: 'PUT',
        body: config as unknown as Record<string, unknown>,
      });
      setConfig(parseCosmosConfig(saved ?? emptyCosmosConfig()));
      setOk('Cosmos saved.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cosmos</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="m-0 text-sm text-muted-foreground">
          Project-level editorial and brand guidance used as AI context across the editor and writer. Cosmos is
          configuration only — it never generates content on its own.
        </p>

        {err && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{err}</div>
        )}
        {ok && <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{ok}</div>}

        {SECTIONS.map((section) => (
          <fieldset key={section.id} className="grid gap-3 rounded-lg border p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {section.title}
            </legend>
            <p className="m-0 text-xs text-muted-foreground">{section.description}</p>
            {section.fields.map((field) => (
              <label key={field.key} className="grid gap-1 text-xs text-muted-foreground">
                <span>{field.label}</span>
                {field.multiline ? (
                  <Textarea
                    value={valueOf(config, section.id, field.key)}
                    placeholder={field.placeholder}
                    maxLength={COSMOS_FIELD_MAX_CHARS}
                    disabled={!canEdit}
                    rows={3}
                    onChange={(e) => setField(section.id, field.key, e.target.value)}
                  />
                ) : (
                  <Input
                    value={valueOf(config, section.id, field.key)}
                    placeholder={field.placeholder}
                    maxLength={COSMOS_FIELD_MAX_CHARS}
                    disabled={!canEdit}
                    onChange={(e) => setField(section.id, field.key, e.target.value)}
                  />
                )}
              </label>
            ))}
          </fieldset>
        ))}

        {canEdit && (
          <div className="flex items-center gap-2">
            <Button onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save Cosmos'}
            </Button>
            <span className="text-xs text-muted-foreground">Applies to this project only.</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
