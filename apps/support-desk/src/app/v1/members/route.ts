import { route } from '../../../server/http';
import { listMembers } from '../../../server/members';

export const GET = route(listMembers);
