import type { Metadata } from 'next';
import { APP_TITLE } from '../_components/app-title';
import { SignInForm } from '../_components/forms';
import ui from '../_components/ui.module.css';

export const metadata: Metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <main className={ui.centered}>
      <div className={`${ui.card} ${ui.stack}`}>
        <h1>{APP_TITLE}</h1>
        <p className={ui.muted}>Sign in with the account your organization gave you.</p>
        <SignInForm />
      </div>
    </main>
  );
}
