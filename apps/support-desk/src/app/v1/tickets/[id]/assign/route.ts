import { route } from '../../../../../server/http';
import { assignTicket } from '../../../../../server/tickets';

export const POST = route(assignTicket);
