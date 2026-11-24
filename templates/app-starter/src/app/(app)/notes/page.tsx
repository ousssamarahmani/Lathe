import type { Metadata } from 'next';
import Link from 'next/link';
import { listNotes } from '../../../server/notes';
import { load } from '../../../server/page-data';
import { orgActions } from '../../../server/members';
import { NoteForm } from '../../_components/forms';
import ui from '../../_components/ui.module.css';
import { LoadError } from '../_components/load-error';

export const metadata: Metadata = { title: 'Notes' };

export default async function NotesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string | string[] }>;
}) {
  const { cursor } = await searchParams;
  const [page, me] = await Promise.all([
    load(listNotes, typeof cursor === 'string' ? { cursor } : {}),
    load(orgActions.getMe),
  ]);
  if (!page.ok) return <LoadError code={page.code} />;
  const canCreate = me.ok && me.value.permissions.includes('notes.create');
  return (
    <div className={ui.stack}>
      <h1>Notes</h1>
      {canCreate && (
        <section className={ui.card} aria-label="New note">
          <NoteForm />
        </section>
      )}
      {page.value.items.length === 0 ? (
        <p className={ui.muted}>No notes yet.</p>
      ) : (
        <ul className={ui.list}>
          {page.value.items.map((n) => (
            <li key={n.id} className={ui.card}>
              <Link href={`/notes/${n.id}`}>{n.title}</Link>
              <p className={ui.muted}>Updated {new Date(n.updatedAt).toLocaleString('en')}</p>
            </li>
          ))}
        </ul>
      )}
      {page.value.nextCursor && (
        <Link href={`/notes?cursor=${encodeURIComponent(page.value.nextCursor)}`}>Older notes</Link>
      )}
    </div>
  );
}
