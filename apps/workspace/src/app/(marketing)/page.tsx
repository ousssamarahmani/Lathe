import type { Metadata } from 'next';
import { Badge, Card, TopNav } from '../../components/ui';
import {
  ARCHITECTURE,
  CAPABILITIES,
  FOOTER_LINKS,
  GET_STARTED_URL,
  HERO,
  KIRO,
  NAV,
  REPO_URL,
  STATUS_LABEL,
  WORKFLOW,
  evidenceUrl,
  type Claim,
  type ClaimStatus,
} from './content';
import styles from './page.module.css';

export const metadata: Metadata = {
  title: { absolute: 'Lathe: your mini software factory' },
  description: HERO.lead,
};

function StatusBadge({ status }: { status: ClaimStatus }) {
  return (
    <span className={styles.status} data-status={status}>
      <Badge tone={status === 'built' ? 'accent' : 'neutral'}>{STATUS_LABEL[status]}</Badge>
    </span>
  );
}

function Evidence({ items }: { items: readonly string[] }) {
  return (
    <p className={styles.evidence}>
      Evidence:{' '}
      {items.map((e, i) => (
        <span key={e}>
          {i > 0 && ', '}
          <a href={evidenceUrl(e)}>
            {e.startsWith('https://') ? e.replace(`${REPO_URL}/`, '') : e}
          </a>
        </span>
      ))}
    </p>
  );
}

function ClaimCard({ claim }: { claim: Claim }) {
  return (
    <Card title={claim.title} level={3} actions={<StatusBadge status={claim.status} />}>
      <p className={styles.text}>{claim.text}</p>
      <Evidence items={claim.evidence} />
    </Card>
  );
}

const LinkButton = ({
  href,
  primary,
  children,
}: {
  href: string;
  primary?: boolean;
  children: string;
}) => (
  <a href={href} className={primary ? styles.ctaPrimary : styles.ctaSecondary}>
    {children}
  </a>
);

/**
 * Public landing page (task P9-01). Static: no Engine call, no sign-in.
 * Every statement comes from `content.ts`, which lists its evidence.
 */
export default function LandingPage() {
  return (
    <>
      <a href="#main" className={styles.skip}>
        Skip to content
      </a>
      <TopNav
        label="Main"
        brand={
          <a href="/" className={styles.brand}>
            Lathe
          </a>
        }
        items={NAV}
        actions={
          <LinkButton href={GET_STARTED_URL} primary>
            Get started
          </LinkButton>
        }
      />

      <main id="main" className={styles.main}>
        <section className={styles.hero} aria-labelledby="hero-title">
          <h1 id="hero-title" className={styles.heroTitle}>
            {HERO.title}
          </h1>
          <p className={styles.lead}>{HERO.lead}</p>
          <div className={styles.ctas}>
            <LinkButton href={GET_STARTED_URL} primary>
              Get started
            </LinkButton>
            <LinkButton href={REPO_URL}>View on GitHub</LinkButton>
          </div>
          <p className={styles.notice} role="note">
            {HERO.notice}
          </p>
        </section>

        <section id="how-it-works" className={styles.section} aria-labelledby="how-title">
          <div className={styles.sectionHead}>
            <h2 id="how-title">How it works</h2>
            <StatusBadge status={WORKFLOW.status} />
          </div>
          <p className={styles.text}>{WORKFLOW.intro}</p>
          <ol className={styles.steps}>
            {WORKFLOW.steps.map((s, i) => (
              <li key={s.name} className={styles.step}>
                <span className={styles.stepNumber} aria-hidden="true">
                  {i + 1}
                </span>
                <span className={styles.stepName}>{s.name}</span>
                <span className={styles.stepText}>{s.text}</span>
              </li>
            ))}
          </ol>
          <Evidence items={WORKFLOW.evidence} />
        </section>

        <section id="product" className={styles.section} aria-labelledby="product-title">
          <h2 id="product-title">What exists today</h2>
          <div className={styles.grid}>
            {CAPABILITIES.map((c) => (
              <ClaimCard key={c.id} claim={c} />
            ))}
          </div>
        </section>

        <section id="architecture" className={styles.section} aria-labelledby="arch-title">
          <h2 id="arch-title">Architecture</h2>
          <p className={styles.text}>
            A TypeScript modular monolith. Agents and verifiers run in separate, short-lived
            containers. <a href={`${REPO_URL}/blob/main/ARCHITECTURE.md`}>Read the architecture</a>.
          </p>
          <div className={styles.grid}>
            {ARCHITECTURE.map((c) => (
              <ClaimCard key={c.id} claim={c} />
            ))}
          </div>
        </section>

        <section id="kiro" className={styles.section} aria-labelledby="kiro-title">
          <h2 id="kiro-title">Kiro and Kiroween 2026</h2>
          <div className={styles.grid}>
            {KIRO.map((c) => (
              <ClaimCard key={c.id} claim={c} />
            ))}
          </div>
        </section>

        <section className={styles.final} aria-labelledby="final-title">
          <h2 id="final-title">Follow the build</h2>
          <p className={styles.text}>The code, the decisions and the evidence are in the open.</p>
          <LinkButton href={GET_STARTED_URL} primary>
            Get started
          </LinkButton>
        </section>
      </main>

      <footer className={styles.footer}>
        <nav aria-label="Footer">
          <ul className={styles.footerList}>
            {FOOTER_LINKS.map((l) => (
              <li key={l.href}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
          </ul>
        </nav>
      </footer>
    </>
  );
}
