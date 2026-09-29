/**
 * Public legal documents: privacy policy, terms of service and cookie policy.
 *
 * These render without a session (the auth gate in `App` never blocks the
 * `legal` route area) because a privacy policy and cookie information must be
 * reachable by anonymous visitors. They are intentionally plain, static
 * documents - no data is fetched and no tracking is performed to read them.
 *
 * The operator-specific values in OPERATOR are bracketed placeholders and MUST
 * be completed before these pages are published. Do not invent a legal entity.
 */
import { ArrowLeft } from 'lucide-react';
import type { LegalPage } from '@/lib/projectRoute';

const OPERATOR = {
  name: '[Operator legal name]',
  address: '[Registered address, country]',
  privacyEmail: '[privacy contact email]',
  supportEmail: '[support contact email]',
  jurisdiction: '[Governing-law country]',
  dpo: '[Data protection contact / DPO, if appointed]',
};

const LAST_UPDATED = 'September 29, 2026';

const TITLES: Record<LegalPage, string> = {
  privacy: 'Privacy Policy',
  terms: 'Terms of Service',
  cookies: 'Cookie Policy',
};

function Doc({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1 border-b pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">Last updated: {LAST_UPDATED}</p>
      </header>
      <div className="space-y-6 text-sm leading-relaxed text-foreground/90">{children}</div>
    </article>
  );
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">{heading}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function PrivacyPolicy() {
  return (
    <Doc title={TITLES.privacy}>
      <p>
        This policy explains how {OPERATOR.name} ("we", "us") processes personal data when you use this SEO
        operating platform (the "Service"), in accordance with the EU General Data Protection Regulation (GDPR) and
        applicable national data protection law.
      </p>
      <Section heading="1. Data controller">
        <p>
          The controller of your personal data is {OPERATOR.name}, {OPERATOR.address}. For any privacy matter,
          including exercising your rights, contact {OPERATOR.privacyEmail}. Data protection contact:{' '}
          {OPERATOR.dpo}.
        </p>
      </Section>
      <Section heading="2. Data we process">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Account data:</strong> your email address, authentication identifiers and, if you sign in with
            Google, the account identifier and email Google returns.
          </li>
          <li>
            <strong>Project data:</strong> the websites, keywords, content, settings and other material you or your
            team create in a project.
          </li>
          <li>
            <strong>Connected-service data:</strong> when you connect Google Search Console or Google Analytics,
            we store encrypted OAuth tokens and the property you select, and we retrieve read-only performance and
            traffic data for those properties on your instructions.
          </li>
          <li>
            <strong>Usage and technical data:</strong> records of actions that consume billable resources and basic
            log data needed to operate and secure the Service.
          </li>
        </ul>
      </Section>
      <Section heading="3. Why we process it and our legal bases">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>To provide the Service</strong> (account creation, projects, integrations) - performance of a
            contract with you (Art. 6(1)(b) GDPR).
          </li>
          <li>
            <strong>To connect and read data from Google services</strong> you authorize - your consent and your
            instructions (Art. 6(1)(a) GDPR), which you can withdraw at any time by disconnecting the integration.
          </li>
          <li>
            <strong>To secure, maintain and improve the Service</strong> - our legitimate interests (Art. 6(1)(f)
            GDPR).
          </li>
          <li>
            <strong>To comply with legal obligations</strong> - Art. 6(1)(c) GDPR.
          </li>
        </ul>
      </Section>
      <Section heading="4. Processors and sharing">
        <p>
          We do not sell personal data. We use infrastructure and service providers as processors under Article 28
          GDPR, which may include: Supabase (database and authentication), our hosting provider, and Google (Search
          Console, Analytics and identity APIs) when you connect those services or sign in with Google. Where a
          provider processes data outside the EEA, we rely on appropriate safeguards such as the European
          Commission's Standard Contractual Clauses.
        </p>
      </Section>
      <Section heading="5. Retention">
        <p>
          Account and project data is kept for as long as your account is active. When you delete your account or a
          project, the related data is deleted or anonymized within a reasonable period, except where we must keep
          records longer to meet legal obligations. Encrypted OAuth tokens are deleted when you disconnect the
          integration or delete the account.
        </p>
      </Section>
      <Section heading="6. Your rights">
        <p>
          Under the GDPR you have the right to access, rectify, erase, restrict or object to the processing of your
          personal data, the right to data portability, and the right to withdraw consent at any time (without
          affecting processing already carried out). To exercise any of these rights, contact{' '}
          {OPERATOR.privacyEmail}. You also have the right to lodge a complaint with your local supervisory
          authority.
        </p>
      </Section>
      <Section heading="7. Cookies and local storage">
        <p>
          The Service uses strictly necessary storage to keep you signed in. See our Cookie Policy for details. We
          do not use advertising or tracking cookies.
        </p>
      </Section>
      <Section heading="8. Changes">
        <p>
          We may update this policy to reflect changes to the Service or the law. The "last updated" date above
          always reflects the current version, and material changes will be communicated through the Service.
        </p>
      </Section>
    </Doc>
  );
}

function TermsOfService() {
  return (
    <Doc title={TITLES.terms}>
      <p>
        These Terms of Service govern your access to and use of the SEO operating platform (the "Service") provided
        by {OPERATOR.name}. By creating an account or using the Service you agree to these terms.
      </p>
      <Section heading="1. Accounts">
        <p>
          You must provide accurate information and keep your credentials secure. You are responsible for activity
          under your account and for ensuring that you have the right to connect any third-party account, website
          or property you add to the Service.
        </p>
      </Section>
      <Section heading="2. Acceptable use">
        <p>
          You agree not to misuse the Service, including by attempting to access it without authorization,
          interfering with its operation, using it to infringe the rights of others, or using it in breach of any
          applicable law or of the terms of the third-party services you connect.
        </p>
      </Section>
      <Section heading="3. Third-party services">
        <p>
          The Service integrates with third-party services such as Google Search Console, Google Analytics and
          publishing platforms. Your use of those services is governed by their own terms, and their availability
          and data are outside our control. We only access the data you authorize, and only to provide the Service.
        </p>
      </Section>
      <Section heading="4. Your content and intellectual property">
        <p>
          You retain ownership of the content and data you submit. You grant us the limited rights needed to host,
          process and display that content to operate the Service for you. We retain all rights in the Service
          itself, including its software and design.
        </p>
      </Section>
      <Section heading="5. Availability and changes">
        <p>
          The Service is provided on an "as is" and "as available" basis. We may modify, suspend or discontinue
          features, and we aim to give reasonable notice of material changes that adversely affect you.
        </p>
      </Section>
      <Section heading="6. Disclaimer and limitation of liability">
        <p>
          To the maximum extent permitted by law, we disclaim implied warranties and are not liable for indirect,
          incidental or consequential damages, or for loss of profits, data or goodwill. Nothing in these terms
          limits liability that cannot be limited by law.
        </p>
      </Section>
      <Section heading="7. Termination">
        <p>
          You may stop using the Service and delete your account at any time. We may suspend or terminate access if
          you materially breach these terms or use the Service unlawfully.
        </p>
      </Section>
      <Section heading="8. Governing law">
        <p>
          These terms are governed by the laws of {OPERATOR.jurisdiction}, without prejudice to mandatory consumer
          protections in your country of residence. Questions about these terms: {OPERATOR.supportEmail}.
        </p>
      </Section>
    </Doc>
  );
}

function CookiePolicy() {
  return (
    <Doc title={TITLES.cookies}>
      <p>
        This policy explains how {OPERATOR.name} uses cookies and similar technologies (such as browser local
        storage) on the Service, in line with the EU ePrivacy Directive and the GDPR.
      </p>
      <Section heading="1. What we use and why">
        <p>
          The Service currently uses only <strong>strictly necessary</strong> storage required to operate and secure
          your session. These are exempt from prior consent because the Service cannot function without them.
        </p>
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2 pr-4 font-semibold">Name</th>
              <th className="py-2 pr-4 font-semibold">Type</th>
              <th className="py-2 font-semibold">Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b align-top">
              <td className="py-2 pr-4">sb-*-auth-token</td>
              <td className="py-2 pr-4">Local storage</td>
              <td className="py-2">Stores your Supabase authentication session so you stay signed in.</td>
            </tr>
          </tbody>
        </table>
      </Section>
      <Section heading="2. No advertising or tracking cookies">
        <p>
          We do not set advertising, profiling or third-party analytics cookies. The read-only SEO data you see is
          fetched server-side from services you connect; it is not collected by browser cookies.
        </p>
      </Section>
      <Section heading="3. Managing storage">
        <p>
          You can clear cookies and local storage through your browser settings. Clearing the authentication storage
          will sign you out. Because only strictly necessary storage is used, there is no consent banner to manage.
        </p>
      </Section>
      <Section heading="4. More information">
        <p>
          For how we handle personal data more generally, see our Privacy Policy. Questions: {OPERATOR.privacyEmail}.
        </p>
      </Section>
    </Doc>
  );
}

export function LegalPage({ view }: { view: LegalPage }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-3xl items-center px-6 py-4">
          <a
            href="/"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Back to app
          </a>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
        {view === 'privacy' && <PrivacyPolicy />}
        {view === 'terms' && <TermsOfService />}
        {view === 'cookies' && <CookiePolicy />}
      </main>
      <LegalFooter />
    </div>
  );
}

/** Shared footer linking the public legal documents; used on public and account pages. */
export function LegalFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-6 py-5 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{OPERATOR.name}</span>
        <span className="hidden sm:inline">·</span>
        <a className="hover:text-foreground" href="/privacy">
          Privacy Policy
        </a>
        <a className="hover:text-foreground" href="/terms">
          Terms of Service
        </a>
        <a className="hover:text-foreground" href="/cookies">
          Cookie Policy
        </a>
      </div>
    </footer>
  );
}
