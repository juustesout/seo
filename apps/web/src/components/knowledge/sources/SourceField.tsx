/**
 * Shared label/value pair for the Source Detail sections (KBUI2). Purely
 * presentational: values are rendered as plain text and callers only pass
 * already-safe DTO fields.
 */
export function SourceField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}
