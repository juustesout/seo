/**
 * Public legal documents: privacy policy, terms of service and cookie policy.
 *
 * These render without a session (the auth gate in `App` never blocks the
 * `legal` route area) because a privacy policy and cookie information must be
 * reachable by anonymous visitors. They are intentionally plain, static
 * documents - no data is fetched and no tracking is performed to read them.
 *
 * The operator identifies itself by its application name, `OldSkoolSEO`, which
 * MUST match the name shown on the Google OAuth consent screen and on the home
 * page. The contact address is the operator's Google contact address for now;
 * replace it with a role-based address if one becomes available.
 */
import { ArrowLeft } from 'lucide-react';
import type { LegalPage } from '@/lib/projectRoute';

const OPERATOR = {
  name: 'OldSkoolSEO',
  website: 'https://www.oldskoolseo.com',
  privacyEmail: 'meneerout@gmail.com',
  supportEmail: 'meneerout@gmail.com',
};

const LAST_UPDATED = 'September 29, 2026';

const TITLES: Record<LegalPage, string> = {
  privacy: 'Privacy Policy',
  terms: 'Terms of Service',
  cookies: 'Cookie Policy',
};

/**
 * Google API Services User Data Policy - Limited Use disclosure. Google's OAuth
 * verification requires this sentence to appear verbatim on the privacy page.
 */
const GOOGLE_LIMITED_USE =
  'Our use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.';

function Doc({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1 border-b pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">
          Applies to {OPERATOR.name} ({OPERATOR.website}). Last updated: {LAST_UPDATED}
        </p>
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
        This Privacy Policy explains how {OPERATOR.name} ("we", "us", "our") collects, uses, stores and shares
        personal data when you use the {OPERATOR.name} SEO operating platform and website at {OPERATOR.website} (the
        "Service"), in accordance with the EU General Data Protection Regulation (GDPR) and applicable national data
        protection law.
      </p>
      <Section heading="1. Who we are (data controller)">
        <p>
          The controller of your personal data is {OPERATOR.name}. For every privacy request - including access,
          correction, export or deletion - contact {OPERATOR.privacyEmail}. General support:{' '}
          {OPERATOR.supportEmail}.
        </p>
      </Section>
      <Section heading="2. What data we collect">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Account data.</strong> Your email address, authentication identifiers and password/session
            credentials, managed through our authentication provider (Supabase). If you choose to sign in with
            Google, we receive the basic Google identity information Google returns (your Google account id and
            email address).
          </li>
          <li>
            <strong>Project data.</strong> The websites, keywords, content, documents, settings, team members and
            other material that you or your team create in a project.
          </li>
          <li>
            <strong>Connected Google account data.</strong> When you connect a Google account, we record which
            Google account was connected and store the resulting OAuth tokens (encrypted) so we can read data on
            your instruction. Depending on the Google services you connect, this includes:
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <strong>Google Search Console data</strong> (scope <code>webmasters.readonly</code>): the verified
                sites/properties you attach, and read-only search performance - search queries, clicks, impressions,
                average positions, pages and related date/paging dimensions.
              </li>
              <li>
                <strong>Google Analytics 4 data</strong> (scope <code>analytics.readonly</code>): the properties you
                select, and read-only traffic metrics such as page views, users, sessions and the events/conversions
                exposed by the Google Analytics Data API.
              </li>
            </ul>
            We request only read-only access. We never ask for Google Ads data and never write to your Google
            accounts.
          </li>
          <li>
            <strong>Knowledge/document data.</strong> Text and files you add to a project's knowledge base. Chunks
            of that text are converted into embeddings and stored in a per-project vector database (Qdrant) to power
            search and retrieval; if you upload text that contains personal data, that text is processed in the same
            way.
          </li>
          <li>
            <strong>Usage and technical data.</strong> Records of actions that consume billable resources, and basic
            server logs (such as IP address, timestamp, browser user agent, requested URL) needed to operate, secure
            and troubleshoot the Service.
          </li>
        </ul>
      </Section>
      <Section heading="3. How and why we use your data">
        <p>
          We use the data above only to provide and operate the Service you request, in particular to:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>create and secure your account and sign you in;</li>
          <li>
            retrieve the Google Search Console and Google Analytics data you connect, so you can see your SEO and
            Analytics performance combined in one dashboard alongside your keywords, content and reports;
          </li>
          <li>run the keyword research, content, knowledge-base and publishing features you use;</li>
          <li>secure the Service, prevent abuse, and measure billable usage;</li>
          <li>comply with our legal obligations.</li>
        </ul>
        <p>
          We do not use Google user data for any other purpose, and we do not use it for advertising.
        </p>
      </Section>
      <Section heading="4. Legal bases for processing">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Performance of a contract</strong> (Art. 6(1)(b) GDPR) - to provide the Service, your account
            and the features you use.
          </li>
          <li>
            <strong>Consent</strong> (Art. 6(1)(a) GDPR) - to connect a Google account and read Google Search
            Console and Google Analytics data through Google OAuth. You give this consent on Google's consent screen
            and can withdraw it at any time by disconnecting the integration or revoking access in your Google
            Account.
          </li>
          <li>
            <strong>Legitimate interests</strong> (Art. 6(1)(f) GDPR) - to secure, maintain and improve the Service.
          </li>
          <li>
            <strong>Legal obligation</strong> (Art. 6(1)(c) GDPR) - where we must keep records by law.
          </li>
        </ul>
      </Section>
      <Section heading="5. Google API Services - Limited Use disclosure">
        <p>
          {OPERATOR.name} accesses Google Search Console, Google Analytics and basic Google identity data only after
          you explicitly authorize it, and only for the read-only purposes described in this policy. Specifically:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Google user data is <strong>not sold</strong> to third parties.</li>
          <li>Google user data is <strong>not used or transferred for advertising purposes</strong>.</li>
          <li>Google user data is <strong>not used to train or improve generalized or foundation AI/ML models</strong>.</li>
          <li>
            Google user data is transferred only as necessary to provide or improve the user-facing features you
            requested, to comply with applicable law, or as part of a merger/acquisition with notice to you.
          </li>
          <li>
            No humans read your Google user data unless you give explicit permission for specific messages, it is
            necessary for security purposes (such as investigating abuse), or it is required by law.
          </li>
        </ul>
        <blockquote className="border-l-2 pl-4 italic text-foreground/80">{GOOGLE_LIMITED_USE}</blockquote>
      </Section>
      <Section heading="6. Sub-processors and sharing">
        <p>
          We do not sell personal data. We use the following service providers as processors; each is bound by a data
          processing agreement and appropriate safeguards:
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2 pr-4 align-top font-semibold">Provider</th>
                <th className="py-2 pr-4 align-top font-semibold">Data</th>
                <th className="py-2 align-top font-semibold">Purpose</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b align-top">
                <td className="py-2 pr-4">Supabase</td>
                <td className="py-2 pr-4">
                  Account email and login data, project data, encrypted Google OAuth tokens, application database and
                  file storage.
                </td>
                <td className="py-2">
                  Database, authentication and file storage. Tokens are encrypted with AES-256 at rest. Hosted in an
                  EU region where available.
                </td>
              </tr>
              <tr className="border-b align-top">
                <td className="py-2 pr-4">Vercel</td>
                <td className="py-2 pr-4">IP addresses and web request/edge logs for the web application.</td>
                <td className="py-2">
                  Hosting and delivery of the web interface. Vercel applies Standard Contractual Clauses for
                  transfers outside the EEA.
                </td>
              </tr>
              <tr className="border-b align-top">
                <td className="py-2 pr-4">Qdrant</td>
                <td className="py-2 pr-4">
                  Document chunks and their embeddings from project knowledge bases, which may contain personal data
                  you upload.
                </td>
                <td className="py-2">
                  Vector search and retrieval. Each project uses isolated collections; an EU cluster is used where
                  available.
                </td>
              </tr>
              <tr className="border-b align-top">
                <td className="py-2 pr-4">Backend hosting provider</td>
                <td className="py-2 pr-4">Application data in transit and operational logs while the API and worker run.</td>
                <td className="py-2">Running the server-side API and background jobs of the Service.</td>
              </tr>
              <tr className="border-b align-top">
                <td className="py-2 pr-4">Google</td>
                <td className="py-2 pr-4">
                  Google account identity and the read-only Search Console/Analytics data you choose to connect.
                </td>
                <td className="py-2">Only when you connect a Google service, to read the data you authorize.</td>
              </tr>
              <tr className="align-top">
                <td className="py-2 pr-4">Providers you enable (BYOK)</td>
                <td className="py-2 pr-4">
                  Content you send to an AI/embedding or publishing provider you configure with your own credentials.
                </td>
                <td className="py-2">
                  Only the features you invoke, using your own provider account and keys.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          We may also disclose data where required by law or to protect the rights, security and safety of users.
        </p>
      </Section>
      <Section heading="7. International transfers">
        <p>
          Where a provider processes personal data outside the European Economic Area, we rely on appropriate
          safeguards under Chapter V GDPR, such as the European Commission's Standard Contractual Clauses and
          supplementary measures.
        </p>
      </Section>
      <Section heading="8. Retention and deletion">
        <p>
          Account and project data is kept for as long as your account is active. When you delete your account or a
          project, the related data is deleted or anonymized within a reasonable period, except where we must keep
          records longer to meet legal obligations. Google OAuth tokens are deleted when you disconnect the Google
          integration or delete your account. Server logs are kept for a limited period for security and
          troubleshooting.
        </p>
        <p>
          You can disconnect a connected Google account at any time from the integrations page of the Service, or by
          revoking {OPERATOR.name}'s access in your Google Account's security settings (Google Account, Data and
          privacy, Third-party apps and services). On disconnection, we stop reading the connected Google data and
          delete the stored tokens.
        </p>
      </Section>
      <Section heading="9. Security">
        <p>
          We protect personal data with appropriate technical and organizational measures, including encryption in
          transit (TLS), encryption at rest for stored Google OAuth tokens (AES-256), per-project data isolation and
          row-level security. No method of transmission or storage is completely secure, but we work to protect your
          data and to notify you and the competent authority of any breach where required by law.
        </p>
      </Section>
      <Section heading="10. Your rights">
        <p>
          Under the GDPR you have the right to access, rectify, erase, restrict or object to the processing of your
          personal data, the right to data portability, and the right to withdraw consent at any time (without
          affecting processing already carried out). To exercise any of these rights, contact{' '}
          {OPERATOR.privacyEmail}. You also have the right to lodge a complaint with your local supervisory
          authority.
        </p>
      </Section>
      <Section heading="11. Cookies and local storage">
        <p>
          The Service uses strictly necessary storage to keep you signed in. We do not use advertising or tracking
          cookies. See our Cookie Policy for details.
        </p>
      </Section>
      <Section heading="12. Children">
        <p>
          The Service is a business tool and is not intended for children. We do not knowingly collect personal data
          from children.
        </p>
      </Section>
      <Section heading="13. Changes to this policy">
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
        These Terms of Service govern your access to and use of the {OPERATOR.name} SEO operating platform (the
        "Service"). By creating an account or using the Service you agree to these terms.
      </p>
      <Section heading="1. Accounts">
        <p>
          You must provide accurate information and keep your credentials secure. You are responsible for activity
          under your account and for ensuring that you have the right to connect any third-party account, website or
          property you add to the Service.
        </p>
      </Section>
      <Section heading="2. Acceptable use">
        <p>
          You agree not to misuse the Service, including by attempting to access it without authorization,
          interfering with its operation, using it to infringe the rights of others, or using it in breach of any
          applicable law or of the terms of the third-party services you connect.
        </p>
      </Section>
      <Section heading="3. Third-party services and Google APIs">
        <p>
          The Service integrates with third-party services such as Google Search Console, Google Analytics and
          publishing platforms. Your use of those services is governed by their own terms, and their availability and
          data are outside our control. We access Google data only with the read-only permissions you grant, only to
          provide the features you request, and in accordance with the Google API Services User Data Policy
          (including its Limited Use requirements) and our Privacy Policy.
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
          These terms are governed by the laws of the country in which OldSkoolSEO is established, without
          prejudice to mandatory consumer protections in your country of residence. Questions about these terms:{' '}
          {OPERATOR.supportEmail}.
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
            Back to {OPERATOR.name}
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
