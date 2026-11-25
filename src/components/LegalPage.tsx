import type { ReactNode } from 'react';
import Get2ShareLockup from './Get2ShareLockup';
import { CONTACT_EMAIL, PRIVACY_PATH, REFUNDS_PATH, TERMS_PATH } from '../legal';

// share.get2.one/terms, /privacy and /refunds. Plain words, and nothing promised here that the app
// doesn't do. Loads without Firebase (see main.tsx), like the landing page.

const UPDATED = 'November 24, 2026';

const PAGES = [
  { path: TERMS_PATH, label: 'Terms' },
  { path: PRIVACY_PATH, label: 'Privacy' },
  { path: REFUNDS_PATH, label: 'Refunds' },
];

const Mail = () => (
  <a href={`mailto:${CONTACT_EMAIL}`} className="text-g2-blue-light hover:text-white underline underline-offset-2">{CONTACT_EMAIL}</a>
);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="font-expanded font-black text-[17px] leading-tight text-white">{title}</h2>
      <div className="mt-2.5 space-y-3 text-[15px] leading-relaxed text-g2-secondary">{children}</div>
    </section>
  );
}

const List = ({ children }: { children: ReactNode }) => (
  <ul className="list-disc pl-5 space-y-1.5 marker:text-g2-muted">{children}</ul>
);

const B = ({ children }: { children: ReactNode }) => <strong className="font-bold text-white">{children}</strong>;

function Terms() {
  return (
    <>
      <p className="text-[15px] leading-relaxed text-g2-secondary">
        These terms cover your use of Get2Share at share.get2.one. Get2Share is a Get2 product, run by Ron Scott in
        Oakland, California (&ldquo;Get2&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;). By using Get2Share you agree to them.
      </p>
      <Section title="Using Get2Share">
        <p>Hosts create an event. Guests join with the event&rsquo;s code or link, with no app to download, and every photo lands in one shared gallery.</p>
        <List>
          <li>You need to be at least 13 to use Get2Share, and at least 18 to host an event or buy anything.</li>
          <li>Hosts are responsible for their events: who they invite, their settings, and what they approve.</li>
        </List>
      </Section>
      <Section title="Your photos">
        <p>
          You keep ownership of the photos you take. When you add a photo to an event, you let the people in that event see it, and save and
          share it as the host&rsquo;s settings allow. You also let us store it and show it where the event shows photos (the gallery, TV screens,
          the big-screen slideshow and Share Spots) so Get2Share can work.
        </p>
        <p>You can delete your own photos. Hosts can hide or delete any photo in their event.</p>
      </Section>
      <Section title="Be good to each other">
        <List>
          <li>Only add photos you have the right to share, and respect people who don&rsquo;t want to be photographed.</li>
          <li>No sexual content involving minors, no nudity without consent, no harassment, threats or hate, and nothing illegal.</li>
          <li>Camera features (borrowing another guest&rsquo;s camera, Share Spots and group shots) only work with the other person&rsquo;s or the host&rsquo;s okay. Don&rsquo;t use them to photograph people secretly.</li>
        </List>
        <p>We may remove content, block devices or close events that break these rules.</p>
      </Section>
      <Section title="AI features">
        <p>
          Flow turns photos a host picks into a short video, and Step In turns a photo into a 3D moment. These are made with AI, so they can
          include moments or details that weren&rsquo;t really there. Flow videos are labeled as AI-generated, and the host checks each one before
          anyone else sees it. To make a Flow video, the photos the host picks are sent to the AI video service we use.
        </p>
      </Section>
      <Section title="Paid passes">
        <List>
          <li>Flow passes add AI video seconds to one event. The price and seconds are shown before you pay, and you pay once, through Stripe.</li>
          <li>Seconds belong to the event they were bought for and can&rsquo;t be moved to another event. They last as long as the event&rsquo;s album does.</li>
          <li>We may change prices. That doesn&rsquo;t change passes you&rsquo;ve already bought.</li>
          <li>Refunds are covered in our <a href={REFUNDS_PATH} className="text-g2-blue-light hover:text-white underline underline-offset-2">refund policy</a>.</li>
        </List>
      </Section>
      <Section title="How long things last">
        <p>
          An event&rsquo;s album stays open for 30 days after the event ends. After that its photos, videos and guest list are deleted, along with any
          seconds left on it. Save anything you want to keep before then.
        </p>
      </Section>
      <Section title="No guarantees">
        <p>
          We work hard to keep Get2Share running, but it&rsquo;s provided as is. We can&rsquo;t promise it will never be down, or that a photo will never be
          lost, so keep your own copies of photos that matter. As far as the law allows, we aren&rsquo;t liable for indirect losses, and our total
          liability to you is limited to what you paid us in the 12 months before the problem.
        </p>
      </Section>
      <Section title="Changes">
        <p>We may update these terms. If a change matters, we&rsquo;ll say so on Get2Share before it takes effect. You can stop using Get2Share at any time.</p>
        <p>These terms are governed by the laws of California.</p>
      </Section>
    </>
  );
}

function Privacy() {
  return (
    <>
      <p className="text-[15px] leading-relaxed text-g2-secondary">
        This is what Get2Share collects, why, who sees it, and how long it&rsquo;s kept. Get2Share is a Get2 product, run by Ron Scott in Oakland,
        California. We don&rsquo;t sell your information and we don&rsquo;t show ads.
      </p>
      <Section title="What we collect">
        <p><B>Guests.</B> Joining an event signs you in with a random ID, with no account or email needed. We keep:</p>
        <List>
          <li>the nickname you pick, the photos you add, and the photos you love;</li>
          <li>basic details about your device (the type of browser, and its battery level when it&rsquo;s used as a camera or Share Spot) so the camera features work;</li>
          <li>on your own device, which events you&rsquo;ve joined, so you can get back to them.</li>
        </List>
        <p><B>Hosts.</B> You sign in with Google, so we receive your name and email address. We keep your events&rsquo; details and settings, and your co-host invites.</p>
        <p>
          <B>Buying a pass.</B> Payments are handled by Stripe. We never see your card number. We receive your email address, the amount, and
          which pass and event it was for.
        </p>
        <p>
          <B>Visits.</B> We count page visits with Vercel Analytics to see how Get2Share is used. Event codes and IDs are removed before anything
          is sent, and it doesn&rsquo;t track you across other sites.
        </p>
      </Section>
      <Section title="How we use it">
        <p>
          To run your event&rsquo;s gallery, show photos to the people in it, make AI videos when a host asks for one, take payments, and fix
          problems. Nothing else.
        </p>
      </Section>
      <Section title="Who sees it">
        <List>
          <li>The people in an event see its photos and nicknames, as the host&rsquo;s settings allow. Hosts and co-hosts also see the guest list.</li>
          <li>
            Companies that run parts of Get2Share for us: Google Firebase (storage, database and sign-in), Vercel (the website and visit counts),
            Modal (processing for Flow and Step In), Higgsfield (making Flow videos, from only the photos the host picks) and Stripe (payments).
            They use your information only to provide their service to us.
          </li>
          <li>Anyone the law requires us to share it with.</li>
        </List>
      </Section>
      <Section title="How long we keep it">
        <List>
          <li>An event&rsquo;s photos, videos and guest list are deleted 30 days after the event ends, or sooner if the host deletes the event.</li>
          <li>Records of payments are kept as long as we need them for taxes and accounting.</li>
          <li>Host account details are kept until you ask us to delete them.</li>
        </List>
      </Section>
      <Section title="Your choices">
        <p>
          You can delete your own photos at any time, and a host can remove any photo in their event. To see, correct or delete the information
          we have about you, email <Mail />. We&rsquo;ll answer within 30 days.
        </p>
      </Section>
      <Section title="Children">
        <p>Get2Share isn&rsquo;t meant for children under 13. If we learn we have information from a child under 13, we&rsquo;ll delete it.</p>
      </Section>
      <Section title="Changes">
        <p>If we change how we handle your information, we&rsquo;ll update this page and its date. For a change that matters, we&rsquo;ll say so on Get2Share first.</p>
      </Section>
    </>
  );
}

function Refunds() {
  return (
    <>
      <p className="text-[15px] leading-relaxed text-g2-secondary">
        This covers Flow passes: the Flow Pass ($15, 100 seconds) and the Flow Pass Plus ($29, 200 seconds). Each is a one-time payment that adds
        AI video seconds to one event.
      </p>
      <Section title="Haven't used it? Full refund">
        <p>If none of a pass&rsquo;s seconds have been used, you can get a full refund within 14 days of buying it.</p>
      </Section>
      <Section title="Used seconds">
        <p>
          Making AI video costs us money as soon as it&rsquo;s made, so seconds that have been used can&rsquo;t be refunded. But you don&rsquo;t pay for
          things that didn&rsquo;t work:
        </p>
        <List>
          <li>If a video doesn&rsquo;t finish, or the AI service refuses to make it, the seconds for the clips you didn&rsquo;t get come back to your event automatically.</li>
          <li>Don&rsquo;t like one part of a video? You can redo just that clip, which uses only that clip&rsquo;s seconds.</li>
        </List>
      </Section>
      <Section title="Something went wrong">
        <p>
          If you were charged but the seconds never showed up, or you were charged twice, email us and we&rsquo;ll add the seconds or refund you in full.
        </p>
      </Section>
      <Section title="How to ask">
        <p>
          Email <Mail /> with the event&rsquo;s name and the email address you paid with. Refunds go back to the card you paid with. Your bank may
          take 5 to 10 business days to show it.
        </p>
        <p>Unused seconds are deleted with the event, 30 days after it ends, and can&rsquo;t be refunded after that.</p>
      </Section>
    </>
  );
}

export default function LegalPage({ path }: { path: string }) {
  const here = path.replace(/\/+$/, '');
  const page = here === PRIVACY_PATH ? 'privacy' : here === REFUNDS_PATH ? 'refunds' : 'terms';
  const title = page === 'privacy' ? 'Privacy policy' : page === 'refunds' ? 'Refund policy' : 'Terms of service';
  if (typeof document !== 'undefined') document.title = `${title} · Get2Share`;
  return (
    <div className="min-h-dvh bg-g2-page text-g2-text font-sans">
      <header className="border-b border-white/[0.08]">
        <div className="max-w-2xl mx-auto px-5 py-4 flex items-center justify-between gap-4">
          <a href="/" aria-label="Get2Share home"><Get2ShareLockup className="text-[21px]" /></a>
          <nav aria-label="Policies" className="flex gap-1">
            {PAGES.map((p) => (
              <a
                key={p.path}
                href={p.path}
                aria-current={p.path === here ? 'page' : undefined}
                className={`h-9 px-3 inline-flex items-center rounded-full text-[13px] font-semibold transition-colors ${
                  p.path === here ? 'bg-g2-text text-g2-page' : 'text-g2-secondary hover:text-white'
                }`}
              >
                {p.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="max-w-2xl mx-auto px-5 pt-8 pb-16">
        <h1 className="font-expanded font-black text-[28px] leading-tight text-white">{title}</h1>
        <p className="mt-1.5 font-mono text-[11px] tracking-[0.06em] uppercase text-g2-muted">Last updated {UPDATED}</p>
        <div className="mt-6">
          {page === 'privacy' ? <Privacy /> : page === 'refunds' ? <Refunds /> : <Terms />}
        </div>
        <Section title="Contact">
          <p>
            Get2Share, a Get2 product · Ron Scott · Oakland, California
            <br />
            Email: <Mail />
          </p>
        </Section>
      </main>
    </div>
  );
}
