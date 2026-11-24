import { route } from '../../../../../server/http';
import { addComment, listComments } from '../../../../../server/tickets';

export const GET = route(listComments);
export const POST = route(addComment, { status: 201 });
