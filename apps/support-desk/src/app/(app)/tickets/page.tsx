import type { Metadata } from 'next';
import Link from 'next/link';
import { orgActions } from '../../../server/members';
import { load } from '../../../server/page-data';
import { listTickets } from '../../../server/tickets';
import { NewTicketForm } from '../../_components/forms';
import ui from '../../_components/ui.module.css';
import { LoadError } from '../_components/load-error';

export const metadata: Metadata = { title: 'Tickets' };

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string | string[]; assignee?: string | string[] }>;
}) {
  const { cursor, assignee } = await searchParams;
  const input: Record<string, string> = {};
  if (typeof cursor === 'string') input['cursor'] = cursor;
  if (assignee === 'me') input['assignee'] = 'me';
  const [page, me] = await Promise.all([load(listTickets, input), load(orgActions.getMe)]);
  if (!page.ok) return <LoadError code={page.code} />;
  const perms = me.ok ? me.value.permissions : [];
  const staff = perms.includes('tickets.read_all');
  return (
    <div className={ui.stack}>
      <h1>{staff ? 'Tickets' : 'My tickets'}</h1>
      {staff && (
        <nav className={ui.row} aria-label="Filter">
          <Link href="/tickets">All</Link>
          <Link href="/tickets?assignee=me">Assigned to me</Link>
        </nav>
      )}
      {perms.includes('tickets.create') && (
        <section className={ui.card} aria-label="New ticket">
          <NewTicketForm canSetPriority={perms.includes('tickets.triage')} />
        </section>
      )}
      {page.value.items.length === 0 ? (
        <p className={ui.muted}>No tickets.</p>
      ) : (
        <ul className={ui.list}>
          {page.value.items.map((t) => (
            <li key={t.id} className={ui.card}>
              <Link href={`/tickets/${t.id}`}>{t.title}</Link>
              <p className={ui.muted}>
                {t.status} · {t.priority} · updated {new Date(t.updatedAt).toLocaleString('en')}
              </p>
            </li>
          ))}
        </ul>
      )}
      {page.value.nextCursor && (
        <Link href={`/tickets?cursor=${encodeURIComponent(page.value.nextCursor)}`}>
          Older tickets
        </Link>
      )}
    </div>
  );
}
