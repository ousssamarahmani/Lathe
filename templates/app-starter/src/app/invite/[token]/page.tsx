import type { Metadata } from 'next';
import Link from 'next/link';
import { AcceptInvitation } from '../../_components/forms';
import ui from '../../_components/ui.module.css';

export const metadata: Metadata = { title: 'Invitation', referrer: 'no-referrer' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className={ui.centered}>
      <div className={`${ui.card} ${ui.stack}`}>
        <h1>Join an organization</h1>
        <p className={ui.muted}>
          You need to be signed in. <Link href="/sign-in">Sign in</Link> first if you are not.
        </p>
        <AcceptInvitation token={token} />
      </div>
    </main>
  );
}
