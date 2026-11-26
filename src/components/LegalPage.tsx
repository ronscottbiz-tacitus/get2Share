import type { ReactNode } from 'react';
import Get2ShareLockup from './Get2ShareLockup';
import { CONTACT_EMAIL, PHONE, PHONE_TEL, PRIVACY_PATH, REFUNDS_PATH, SUPPORT_EMAIL, TERMS_PATH } from '../legal';

// share.get2.one/terms, /privacy and /refunds. Plain words, and nothing promised here that the app
// doesn't do. Loads without Firebase (see main.tsx), like the landing page.

const UPDATED = 'November 25, 2026';

const PAGES = [
  { path: TERMS_PATH, label: 'Terms' },
  { path: PRIVACY_PATH, label: 'Privacy' },
  { path: REFUNDS_PATH, label: 'Refunds' },
];

const Mail = ({ to = CONTACT_EMAIL }: { to?: string }) => (
  <a href={`mailto:${to}`} className="text-g2-blue-light hover:text-white underline underline-offset-2">{to}</a>
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
      <Section title="Free events and upgrades">
        <p>
          Every event starts free: photos open for a day from the start time, up to 20 guests (with room for 5 more) and 3 co-hosts, 1 Share Spot
          and 1 TV, and an album that stays open 7 days after the event ends. A host can upgrade one event at a time:
        </p>
        <List>
          <li><B>Party, $10:</B> photos open for 3 days, up to 100 guests (with room for 5 more) and 10 co-hosts, 3 Share Spots and 3 TVs, the album open 6 months, and 20 seconds of Flow.</li>
          <li><B>Big Event, $29:</B> photos open for 14 days, no limit on guests or co-hosts, 5 Share Spots and 5 TVs, the album open a year, 100 seconds of Flow, and the choice to turn off Get2Share branding.</li>
        </List>
        <p>
          A Party event can become a Big Event for the difference. When an event is full, new guests wait on a screen that lets them in as soon as
          the host upgrades. Hosts and co-hosts don&rsquo;t count as guests, and removing a guest doesn&rsquo;t free up a spot.
        </p>
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
          Flow turns photos a host picks into a short video. It&rsquo;s made with AI, so it can
          include moments or details that weren&rsquo;t really there. Flow videos are labeled as AI-generated, and the host checks each one before
          anyone else sees it. To make a Flow video, the photos the host picks are sent to the AI video service we use.
        </p>
      </Section>
      <Section title="Upgrades and passes">
        <List>
          <li>Upgrades (Party and Big Event) and Flow passes are one-time payments for one event, through Stripe. The price and what you get are shown before you pay. Nothing renews.</li>
          <li>Flow passes add AI video seconds to an event, on top of any it has.</li>
          <li>Upgrades and seconds belong to the event they were bought for and can&rsquo;t be moved to another event. Seconds last as long as the event&rsquo;s album does.</li>
          <li>We may change prices. That doesn&rsquo;t change anything you&rsquo;ve already bought.</li>
          <li>Refunds are covered in our <a href={REFUNDS_PATH} className="text-g2-blue-light hover:text-white underline underline-offset-2">refund policy</a>.</li>
        </List>
      </Section>
      <Section title="How long things last">
        <p>
          An event&rsquo;s album stays open after the event ends for 7 days if it&rsquo;s free, 6 months with Party, or a year with Big Event.
          Events made before upgrades were offered stay open at least 14 days. When the album closes, its photos, videos and guest list are
          deleted, along with any seconds left on it. The host is reminded in Get2Share a few days before. Save anything you want to keep before then.
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
          <B>Buying an upgrade or a pass.</B> Payments are handled by Stripe. We never see your card number. We receive your email address, the
          amount, and which upgrade or pass and which event it was for.
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
            Modal (processing for Flow), Higgsfield (making Flow videos, from only the photos the host picks) and Stripe (payments).
            They use your information only to provide their service to us.
          </li>
          <li>Anyone the law requires us to share it with.</li>
        </List>
      </Section>
      <Section title="How long we keep it">
        <List>
          <li>An event&rsquo;s photos, videos and guest list are deleted when its album closes (7 days after the event ends for a free event, 6 months with Party, a year with Big Event), or sooner if the host deletes the event.</li>
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
        This covers everything you can buy on Get2Share, each a one-time payment for one event: the upgrades, Party ($10) and Big Event ($29,
        or $19 from Party), and the Flow passes, the Flow Pass ($15, 100 seconds) and the Flow Pass Plus ($29, 200 seconds).
      </p>
      <Section title="Haven't used it? Full refund">
        <p>
          If none of the Flow seconds that came with a purchase have been used, you can get a full refund within 14 days of buying it. That&rsquo;s
          the same for upgrades, which come with Flow seconds, and for passes.
        </p>
        <p>
          Refunding an upgrade puts the event back on its earlier plan: its guest limit, Share Spots and TVs, and how long its album stays open go
          back too. If the album would already have closed on that plan, it closes when the refund goes through.
        </p>
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
          If you were charged but the upgrade or the seconds never showed up, or you were charged twice, email <Mail to={SUPPORT_EMAIL} /> and
          we&rsquo;ll fix it or refund you in full.
        </p>
      </Section>
      <Section title="How to ask">
        <p>
          Email <Mail to={SUPPORT_EMAIL} /> with the event&rsquo;s name and the email address you paid with. Refunds go back to the card you paid with. Your bank may
          take 5 to 10 business days to show it.
        </p>
        <p>Unused seconds are deleted with the event when its album closes, and can&rsquo;t be refunded after that.</p>
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
            Questions: <Mail />
            <br />
            Refunds and billing: <Mail to={SUPPORT_EMAIL} />
            <br />
            Phone: <a href={PHONE_TEL} className="text-g2-blue-light hover:text-white underline underline-offset-2">{PHONE}</a>
          </p>
        </Section>
      </main>
    </div>
  );
}
