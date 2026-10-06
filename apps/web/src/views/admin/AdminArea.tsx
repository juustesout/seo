/**
 * Platform administration area (P3).
 *
 * Owns the `/admin` section layout and section switch. This is the single
 * client-side mount point for admin views: when the caller is not a platform
 * administrator nothing is fetched or rendered except a not-authorized notice -
 * the server independently rejects every `/api/admin/*` request, so the UI
 * guard is convenience, never the boundary.
 */
import { ShieldAlert } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { AdminOverview } from './AdminOverview';
import { AdminUsers } from './AdminUsers';
import { AdminAccounts } from './AdminAccounts';
import { AdminProjects } from './AdminProjects';
import { AdminUsage } from './AdminUsage';
import { AdminPlans } from './AdminPlans';

const ADMIN_NAV = [
  { id: 'overview', label: 'Overview' },
  { id: 'users', label: 'Users' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'projects', label: 'Projects' },
  { id: 'usage', label: 'Usage' },
  { id: 'plans', label: 'Plans' },
] as const;

function NotAuthorized() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-12">
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <ShieldAlert className="h-8 w-8 text-muted-foreground" aria-hidden />
          <div className="text-base font-medium">Platform administrator access required</div>
          <p className="max-w-md text-sm text-muted-foreground">
            This area is limited to registered platform operators. Project ownership or
            administration does not grant access.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export function AdminArea({
  view,
  isAdmin,
  onNavigate,
}: {
  view: string;
  isAdmin: boolean;
  onNavigate: (view: string) => void;
}) {
  if (!isAdmin) return <NotAuthorized />;

  const current = ADMIN_NAV.some((item) => item.id === view) ? view : 'overview';

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 gap-8 px-6 py-8">
      <nav className="w-40 shrink-0" aria-label="Platform administration">
        <ul className="space-y-1">
          {ADMIN_NAV.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onNavigate(item.id)}
                aria-current={current === item.id ? 'page' : undefined}
                className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  current === item.id
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        <div className="mb-6 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          Platform administration - operator area, separate from project roles.
        </div>
        {current === 'overview' && <AdminOverview />}
        {current === 'users' && <AdminUsers />}
        {current === 'accounts' && <AdminAccounts />}
        {current === 'projects' && <AdminProjects />}
        {current === 'usage' && <AdminUsage />}
        {current === 'plans' && <AdminPlans />}
      </div>
    </div>
  );
}
