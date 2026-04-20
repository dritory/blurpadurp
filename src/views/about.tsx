import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";

// Content mirrors docs/concept.md. Hand-authored rather than rendered from
// the markdown file at runtime to avoid a parser dep. If concept.md drifts
// from this page meaningfully, update both — concept.md is the source of
// truth for intent, this is the public version.

export const About: FC = () => (
  <Layout title="About — Blurpadurp" nav="about">
    <h2>What this is</h2>
    <p>
      An automated, anti-algorithm curated brief. Delivers only the
      highest-signal items from across news, science, culture, and internet
      zeitgeist. Success metric is the <em>opposite</em> of engagement:
      fewer minutes of the reader's time per week is a better product.
    </p>

    <h2>Mission</h2>
    <p>
      <strong>Let readers quit social media for keeping up.</strong>
    </p>
    <p>
      Most people use social feeds to answer one question: <em>"What's
      everyone talking about?"</em> Blurpadurp replaces that function. A
      reader who follows Blurpadurp should be able to hold their own in any
      interesting conversation — at lunch, at a dinner party, at the coffee
      machine — without opening TikTok, X, or Reddit.
    </p>
    <p>
      The gate is <strong>current conversational relevance</strong>, not
      long-term historical weight. We publish what informed adults will
      actually be discussing over the next one to two weeks.
    </p>

    <h2>Editorial principles</h2>
    <ul>
      <li>
        <strong>Consequential only.</strong> No cherry-picked quotes, no
        motive attribution, no "this could turn into something." Enforced
        mechanically by a confidence gate.
      </li>
      <li>
        <strong>Context, not interpretation.</strong> Opinionated on{" "}
        <em>what belongs in the brief</em>, neutral on{" "}
        <em>what to think of it</em>. We give readers enough context to
        connect dots themselves; we do not tell them the conclusion.
      </li>
      <li>
        <strong>Ride for the generalists.</strong> Ten categories, no
        specialization. A reader should leave each issue with a wider
        surface area, not a deeper trench.
      </li>
      <li>
        <strong>Silence is a feature.</strong> If nothing clears the bar,
        nothing publishes. No filler, no "slow news" recap.
      </li>
    </ul>

    <h2>What we refuse</h2>
    <ul>
      <li>Sports results (unless civic-scale — Olympics, World Cup finals).</li>
      <li>Routine product launches, earnings beats, and horse-race polling.</li>
      <li>Individual crime without a systemic angle.</li>
      <li>Weather without unprecedented scale.</li>
      <li>Award ceremonies (unless the outcome is the story).</li>
      <li>Viral content trapped on a single platform.</li>
      <li>
        Celebrity personal lives (unless universally-known subject at a
        life milestone, or a public-interest legal matter).
      </li>
      <li>
        In-circle hype, manufactured hype, and controversy-flashes —
        named and dismissed in the <em>Worth a shrug</em> section rather
        than covered.
      </li>
    </ul>

    <h2>How each issue is organised</h2>
    <p>
      Every brief uses the same four sections. Any section may be empty;
      missing sections are simply omitted.
    </p>
    <ul>
      <li>
        <strong>This week's conversation.</strong> The items a reader will
        be asked about.
      </li>
      <li>
        <strong>Worth knowing.</strong> What matters even if nobody's
        talking about it yet.
      </li>
      <li>
        <strong>Worth watching.</strong> Emerging or uncertain threads.
      </li>
      <li>
        <strong>Worth a shrug.</strong> The anti-FOMO section — hype the
        algorithm pushed this week that we refused, named and dismissed.
      </li>
    </ul>

    <h2>No accounts. No tracking.</h2>
    <p>
      Subscription is the identity — no passwords, no login anywhere.
      Preferences are managed through signed links in your own email. No
      analytics, no pixels, no third-party scripts.
    </p>
  </Layout>
);
