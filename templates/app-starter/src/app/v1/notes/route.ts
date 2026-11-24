import { route } from '../../../server/http';
import { createNote, listNotes } from '../../../server/notes';

export const GET = route(listNotes);
export const POST = route(createNote, { status: 201 });
