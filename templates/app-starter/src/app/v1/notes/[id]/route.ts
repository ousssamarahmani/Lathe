import { route } from '../../../../server/http';
import { deleteNote, getNote, updateNote } from '../../../../server/notes';

export const GET = route(getNote);
export const PATCH = route(updateNote);
export const DELETE = route(deleteNote, { status: 204 });
