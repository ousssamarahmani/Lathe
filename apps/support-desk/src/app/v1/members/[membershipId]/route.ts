import { route } from '../../../../server/http';
import { orgActions } from '../../../../server/members';

export const PATCH = route(orgActions.changeMemberRole);
export const DELETE = route(orgActions.removeMember, { status: 204 });
