import { route } from '../../../server/http';
import { createTicket, listTickets } from '../../../server/tickets';

export const GET = route(listTickets);
export const POST = route(createTicket, { status: 201 });
