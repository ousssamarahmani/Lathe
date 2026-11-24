import type { Metadata } from 'next';
import Link from 'next/link';
import { orgActions } from '../../../../server/members';
import { getNote } from '../../../../server/notes';
import { load } from '../../../../server/page-data';
import { DeleteNoteButton, NoteForm } from '../../../_components/forms';
import ui from '../../../_components/ui.module.css';
import { LoadError } from '../../_components/load-error';

export const metadata: Metadata = { title: 'Note' };

export default async function NotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [note, me] = await Promise.all([load(getNote, { id }), load(orgActions.getMe)]);
  if (!note.ok)
    return <LoadError code={note.code === 'validation_failed' ? 'not_found' : note.code} />;
  const perms = me.ok ? me.value.permissions : [];
  return (
    <div className={ui.stack}>
      <Link href="/notes">Back to notes</Link>
      {perms.includes('notes.update') ? (
        <section className={ui.card}>
          <NoteForm note={note.value} />
        </section>
      ) : (
        <article className={`${ui.card} ${ui.stack}`}>
          <h1>{note.value.title}</h1>
          <p>{note.value.body}</p>
        </article>
      )}
      {perms.includes('notes.delete') && <DeleteNoteButton id={note.value.id} />}
    </div>
  );
}
