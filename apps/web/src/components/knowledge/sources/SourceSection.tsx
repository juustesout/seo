/**
 * Source Detail section card (KBUI2). One consistent visual section with a
 * small heading so the drawer reads as clear blocks instead of a tab explosion.
 */
export function SourceSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}
