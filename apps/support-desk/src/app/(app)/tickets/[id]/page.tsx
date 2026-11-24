import type { Metadata } from 'next';
import Link from 'next/link';
import { canWorkTickets } from '../../../../server/authz';
import { listMembers, orgActions } from '../../../../server/members';
import { load } from '../../../../server/page-data';
import { getTicket, listComments } from '../../../../server/tickets';
import { CommentForm, TicketControls } from '../../../_components/forms';
import ui from '../../../_components/ui.module.css';
import { LoadError } from '../../_components/load-error';

export const metadata: Metadata = { title: 'Ticket' };

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [ticket, comments, me] = await Promise.all([
    load(getTicket, { id }),
    load(listComments, { id }),
    load(orgActions.getMe),
  ]);
  if (!ticket.ok) {
    return <LoadError code={ticket.code === 'validation_failed' ? 'not_found' : ticket.code} />;
  }
  const perms = me.ok ? me.value.permissions : [];
  const t = ticket.value;
  const members = perms.includes('members.read') ? await load(listMembers) : null;
  const assignees =
    members?.ok === true
      ? members.value
          .filter((m) => canWorkTickets(m.role))
          .map((m) => ({ membershipId: m.membershipId, name: m.name }))
      : [];
  return (
    <div className={ui.stack}>
      <Link href="/tickets">Back to tickets</Link>
      <article className={`${ui.card} ${ui.stack}`}>
        <h1>{t.title}</h1>
        <p className={ui.muted}>
          {t.status} · {t.priority} · opened {new Date(t.createdAt).toLocaleString('en')}
        </p>
        {t.body && <p>{t.body}</p>}
      </article>
      {perms.includes('tickets.triage') && (
        <section className={ui.card} aria-label="Ticket controls">
          <TicketControls
            id={t.id}
            status={t.status}
            priority={t.priority}
            assigneeMembershipId={t.assigneeMembershipId}
            assignees={assignees}
          />
        </section>
      )}
      <section className={ui.stack} aria-label="Conversation">
        <h2>Conversation</h2>
        {comments.ok && comments.value.length > 0 ? (
          <ul className={ui.list}>
            {comments.value.map((c) => (
              <li key={c.id} className={ui.card}>
                <p className={ui.muted}>
                  {c.authorName}
                  {c.internal ? ' · internal note' : ''} ·{' '}
                  {new Date(c.createdAt).toLocaleString('en')}
                </p>
                <p>{c.body}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className={ui.muted}>No replies yet.</p>
        )}
        {t.status !== 'closed' && perms.includes('comments.create') && (
          <CommentForm id={t.id} canInternal={perms.includes('comments.internal')} />
        )}
      </section>
    </div>
  );
}
