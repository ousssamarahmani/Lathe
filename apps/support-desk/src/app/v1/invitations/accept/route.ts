import { route } from '../../../../server/http';
import { orgActions } from '../../../../server/members';

export const POST = route(orgActions.acceptInvitation);
