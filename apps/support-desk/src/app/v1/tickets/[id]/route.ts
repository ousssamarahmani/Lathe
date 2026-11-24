import { route } from '../../../../server/http';
import { getTicket, updateTicket } from '../../../../server/tickets';

export const GET = route(getTicket);
export const PATCH = route(updateTicket);
