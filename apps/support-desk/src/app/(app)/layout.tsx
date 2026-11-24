import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { orgActions } from '../../server/members';
import { load } from '../../server/page-data';
import { APP_TITLE } from '../_components/app-title';
import { OrgSwitcher, SignOutButton } from '../_components/forms';
import ui from '../_components/ui.module.css';

// Every page below reads the session, so none of them is rendered statically.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await load(orgActions.getMe);
  if (!me.ok) redirect('/sign-in');
  const { user, memberships, activeOrgId } = me.value;
  return (
    <div className={ui.shell}>
      <header className={ui.topbar}>
        <span className={ui.brand}>{APP_TITLE}</span>
        <nav className={ui.nav} aria-label="Main">
          <Link href="/tickets">Tickets</Link>
          <Link href="/members">Members</Link>
        </nav>
        <OrgSwitcher memberships={memberships} activeOrgId={activeOrgId} />
        <span className={ui.muted}>{user.email}</span>
        <SignOutButton />
      </header>
      <main className={ui.main}>
        {activeOrgId === null ? (
          <div className={`${ui.card} ${ui.stack}`}>
            <h1>Choose an organization</h1>
            <p className={ui.muted}>
              {memberships.length === 0
                ? 'You are not a member of any organization yet. Ask an owner for an invitation link.'
                : 'Pick the organization to work in with the selector above.'}
            </p>
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
