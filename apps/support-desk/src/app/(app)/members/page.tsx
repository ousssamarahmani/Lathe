import type { Metadata } from 'next';
import { authz } from '../../../server/authz';
import { listMembers, orgActions } from '../../../server/members';
import { load } from '../../../server/page-data';
import { InviteForm, MemberControls } from '../../_components/forms';
import ui from '../../_components/ui.module.css';
import { LoadError } from '../_components/load-error';

export const metadata: Metadata = { title: 'Members' };

export default async function MembersPage() {
  const [members, me] = await Promise.all([load(listMembers), load(orgActions.getMe)]);
  if (!members.ok) return <LoadError code={members.code} />;
  const perms = me.ok ? me.value.permissions : [];
  const myMembership = me.ok
    ? me.value.memberships.find((m) => m.orgId === me.value.activeOrgId)?.membershipId
    : undefined;
  // The UI hint only. Every change is re-checked by the action, including "no escalation".
  const roles = authz.roles;
  return (
    <div className={ui.stack}>
      <h1>Members</h1>
      {perms.includes('members.invite') && (
        <section className={ui.card} aria-label="Invite">
          <InviteForm roles={roles} />
        </section>
      )}
      <ul className={ui.list}>
        {members.value.map((m) => (
          <li key={m.membershipId} className={`${ui.card} ${ui.row}`}>
            <div className={ui.stack}>
              <strong>{m.name}</strong>
              <span className={ui.muted}>
                {m.email} · {m.role}
                {m.membershipId === myMembership ? ' · you' : ''}
              </span>
            </div>
            {perms.includes('members.manage') && m.membershipId !== myMembership && (
              <MemberControls membershipId={m.membershipId} role={m.role} roles={roles} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
