'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { callApi } from './api';
import ui from './ui.module.css';

/** Shared state for a form that calls one route: pending flag and the last error. */
function useSubmit() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    call: () => ReturnType<typeof callApi>,
    onOk?: (data: unknown) => void,
  ): Promise<void> => {
    setPending(true);
    setError(null);
    const r = await call();
    setPending(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    onOk?.(r.data);
    router.refresh();
  };
  return { router, pending, error, run };
}

const ErrorLine = ({ error }: { error: string | null }) =>
  error ? (
    <p className={ui.error} role="alert">
      {error}
    </p>
  ) : null;

export function SignInForm() {
  const { router, pending, error, run } = useSubmit();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    void run(
      () =>
        callApi('POST', '/auth/sign-in/email', {
          email: String(data.get('email') ?? ''),
          password: String(data.get('password') ?? ''),
        }),
      () => router.push('/tickets'),
    );
  };
  return (
    <form className={ui.stack} onSubmit={onSubmit}>
      <label className={ui.label}>
        Email
        <input className={ui.input} name="email" type="email" autoComplete="email" required />
      </label>
      <label className={ui.label}>
        Password
        <input
          className={ui.input}
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </label>
      <ErrorLine error={error} />
      <button className={ui.button} type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

export function SignOutButton() {
  const { router, pending, run } = useSubmit();
  return (
    <button
      className={`${ui.button} ${ui.secondary}`}
      type="button"
      disabled={pending}
      onClick={() =>
        void run(
          () => callApi('POST', '/auth/sign-out', {}),
          () => router.push('/sign-in'),
        )
      }
    >
      Sign out
    </button>
  );
}

export interface OrgOption {
  readonly membershipId: string;
  readonly orgId: string;
  readonly orgName: string;
}

export function OrgSwitcher({
  memberships,
  activeOrgId,
}: {
  memberships: readonly OrgOption[];
  activeOrgId: string | null;
}) {
  const { pending, error, run } = useSubmit();
  if (memberships.length === 0) return <span className={ui.muted}>No organization</span>;
  return (
    <label className={ui.row}>
      <span className={ui.muted}>Organization</span>
      <select
        className={ui.select}
        aria-label="Active organization"
        value={memberships.find((m) => m.orgId === activeOrgId)?.membershipId ?? ''}
        disabled={pending}
        onChange={(e) =>
          void run(() =>
            callApi('POST', '/v1/session/active-org', { membershipId: e.target.value }),
          )
        }
      >
        {activeOrgId === null && <option value="">Choose…</option>}
        {memberships.map((m) => (
          <option key={m.membershipId} value={m.membershipId}>
            {m.orgName}
          </option>
        ))}
      </select>
      <ErrorLine error={error} />
    </label>
  );
}

export function InviteForm({ roles }: { roles: readonly string[] }) {
  const { pending, error, run } = useSubmit();
  const [link, setLink] = useState<string | null>(null);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const role = String(new FormData(e.currentTarget).get('role') ?? '');
    setLink(null);
    void run(
      () => callApi('POST', '/v1/invitations', { role }),
      (data) => {
        const token = (data as { token?: unknown }).token;
        if (typeof token === 'string') {
          setLink(`${window.location.origin}/invite/${encodeURIComponent(token)}`);
        }
      },
    );
  };
  return (
    <form className={ui.stack} onSubmit={onSubmit}>
      <div className={ui.row}>
        <label className={ui.label}>
          Role
          <select className={ui.select} name="role" defaultValue={roles.at(-1)}>
            {roles.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <button className={ui.button} type="submit" disabled={pending}>
          Create invitation link
        </button>
      </div>
      <ErrorLine error={error} />
      {link && (
        <div className={ui.stack}>
          <p className={ui.muted}>
            Shown once. Anyone with this link can join with that role until it expires.
          </p>
          <code className={ui.code}>{link}</code>
        </div>
      )}
    </form>
  );
}

export function MemberControls({
  membershipId,
  role,
  roles,
}: {
  membershipId: string;
  role: string;
  roles: readonly string[];
}) {
  const { pending, error, run } = useSubmit();
  const path = `/v1/members/${encodeURIComponent(membershipId)}`;
  return (
    <div className={ui.row}>
      <select
        className={ui.select}
        aria-label="Role"
        value={role}
        disabled={pending}
        onChange={(e) => void run(() => callApi('PATCH', path, { role: e.target.value }))}
      >
        {roles.map((r) => (
          <option key={r}>{r}</option>
        ))}
      </select>
      <button
        className={`${ui.button} ${ui.danger}`}
        type="button"
        disabled={pending}
        onClick={() => void run(() => callApi('DELETE', path))}
      >
        Remove
      </button>
      <ErrorLine error={error} />
    </div>
  );
}

export function AcceptInvitation({ token }: { token: string }) {
  const { router, pending, error, run } = useSubmit();
  return (
    <div className={ui.stack}>
      <button
        className={ui.button}
        type="button"
        disabled={pending}
        onClick={() =>
          void run(
            () => callApi('POST', '/v1/invitations/accept', { token }),
            () => router.push('/tickets'),
          )
        }
      >
        Accept invitation
      </button>
      <ErrorLine error={error} />
    </div>
  );
}

export function NewTicketForm({ canSetPriority }: { canSetPriority: boolean }) {
  const { pending, error, run } = useSubmit();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const body: Record<string, string> = {
      title: String(data.get('title') ?? ''),
      body: String(data.get('body') ?? ''),
    };
    if (canSetPriority) body['priority'] = String(data.get('priority') ?? 'normal');
    void run(
      () => callApi('POST', '/v1/tickets', body),
      () => form.reset(),
    );
  };
  return (
    <form className={ui.stack} onSubmit={onSubmit}>
      <label className={ui.label}>
        Subject
        <input className={ui.input} name="title" maxLength={200} required />
      </label>
      <label className={ui.label}>
        Description
        <textarea className={ui.input} name="body" maxLength={20000} rows={4} />
      </label>
      {canSetPriority && (
        <label className={ui.label}>
          Priority
          <select className={ui.select} name="priority" defaultValue="normal">
            {['low', 'normal', 'high', 'urgent'].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
      )}
      <ErrorLine error={error} />
      <button className={ui.button} type="submit" disabled={pending}>
        Open ticket
      </button>
    </form>
  );
}

export interface AssigneeOption {
  readonly membershipId: string;
  readonly name: string;
}

/** Staff controls on a ticket: status, priority, assignee. Each change is re-checked by the action. */
export function TicketControls({
  id,
  status,
  priority,
  assigneeMembershipId,
  assignees,
}: {
  id: string;
  status: string;
  priority: string;
  assigneeMembershipId: string | null;
  assignees: readonly AssigneeOption[];
}) {
  const { pending, error, run } = useSubmit();
  const path = `/v1/tickets/${encodeURIComponent(id)}`;
  return (
    <div className={ui.stack}>
      <div className={ui.row}>
        <label className={ui.label}>
          Status
          <select
            className={ui.select}
            value={status}
            disabled={pending}
            onChange={(e) => void run(() => callApi('PATCH', path, { status: e.target.value }))}
          >
            {['open', 'pending', 'resolved', 'closed'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className={ui.label}>
          Priority
          <select
            className={ui.select}
            value={priority}
            disabled={pending || status === 'closed'}
            onChange={(e) => void run(() => callApi('PATCH', path, { priority: e.target.value }))}
          >
            {['low', 'normal', 'high', 'urgent'].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className={ui.label}>
          Assignee
          <select
            className={ui.select}
            value={assigneeMembershipId ?? ''}
            disabled={pending}
            onChange={(e) =>
              void run(() =>
                callApi('POST', `${path}/assign`, { membershipId: e.target.value || null }),
              )
            }
          >
            <option value="">Unassigned</option>
            {assignees.map((a) => (
              <option key={a.membershipId} value={a.membershipId}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

export function CommentForm({ id, canInternal }: { id: string; canInternal: boolean }) {
  const { pending, error, run } = useSubmit();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const body: Record<string, unknown> = { body: String(data.get('body') ?? '') };
    if (canInternal) body['internal'] = data.get('internal') === 'on';
    void run(
      () => callApi('POST', `/v1/tickets/${encodeURIComponent(id)}/comments`, body),
      () => form.reset(),
    );
  };
  return (
    <form className={ui.stack} onSubmit={onSubmit}>
      <label className={ui.label}>
        Reply
        <textarea className={ui.input} name="body" maxLength={10000} rows={3} required />
      </label>
      {canInternal && (
        <label className={ui.row}>
          <input type="checkbox" name="internal" />
          <span className={ui.muted}>Internal note (staff only)</span>
        </label>
      )}
      <ErrorLine error={error} />
      <button className={ui.button} type="submit" disabled={pending}>
        Add reply
      </button>
    </form>
  );
}
