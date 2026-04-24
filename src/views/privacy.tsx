import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";

// Plain-English privacy statement. Linked from the site footer and
// from every dispatched email's footer. Not a legal document — a
// statement of practice. If you subscribe or your address is stored,
// this page explains what happens to it.

export const Privacy: FC = () => (
  <Layout title="Privacy — Blurpadurp" nav={null}>
    <h2>Privacy</h2>
    <p>
      Short version: we store your email address so we can send you
      a brief. That's it. No analytics, no third-party scripts, no
      tracking pixels. No account, no password, no login. If you
      unsubscribe, we stop sending.
    </p>

    <h2>What we store</h2>
    <p>
      One row per subscriber with your email address, the timestamp
      you confirmed, and your preferences (delivery time, timezone,
      any category mutes). Nothing else. We do not store IP addresses
      alongside subscriptions, we do not fingerprint your browser, and
      we do not sell, share, or join this data against anything else.
    </p>

    <h2>How we use it</h2>
    <p>
      To send you the brief, once a week at most, only when something
      actually cleared our editorial gate. Occasionally — never more
      than twice a year — to send a transactional message about the
      subscription itself: a confirmation link, a change we need to
      tell you about, or a notice that we're shutting down.
    </p>

    <h2>What we don't do</h2>
    <p>
      We don't run analytics. No Google Analytics, no Plausible,
      no Mixpanel. No tracking pixels in emails. No third-party
      scripts on the site — the only external network call the page
      makes is to Google Fonts for the Lora typeface, which never
      sees your identity. Server logs record request paths and status
      codes without retaining IP addresses beyond what the host
      infrastructure requires for abuse prevention.
    </p>

    <h2>Unsubscribing</h2>
    <p>
      Every email has a one-click unsubscribe link in the footer. Use
      it and you're out: your row is marked unsubscribed and no
      future issue goes to you. We keep the row so we don't
      accidentally re-add you if someone else types your address into
      the form; if you want it deleted entirely, email{" "}
      <a href="mailto:hello@blurpadurp.com">hello@blurpadurp.com</a>{" "}
      and we will.
    </p>

    <h2>Data location</h2>
    <p>
      The database runs on our own server infrastructure. Email
      delivery goes through Resend, which processes your address and
      the brief content to deliver it — their privacy statement
      covers that leg. We do not send your address to any other third
      party.
    </p>

    <h2>Changes</h2>
    <p>
      If we ever need to change this — add a service, start doing
      something with data we didn't used to — we will tell you before
      it takes effect, not after. No surprise updates buried in a
      changelog.
    </p>
  </Layout>
);
