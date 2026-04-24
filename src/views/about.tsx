import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";

// Content mirrors docs/concept.md. Hand-authored rather than rendered from
// the markdown file at runtime to avoid a parser dep. If concept.md drifts
// from this page meaningfully, update both — concept.md is the source of
// truth for intent, this is the public version.

export const About: FC = () => (
  <Layout title="About — Blurpadurp" nav="about">
    <style
      dangerouslySetInnerHTML={{
        __html: `
          .meet-blurp { display: flex; flex-direction: column; gap: 14px; margin: 0 0 32px; }
          .meet-blurp img { display: block; width: 100%; height: auto; }
          .meet-blurp h2 { margin-top: 0; }
        `,
      }}
    />
    <section class="meet-blurp" aria-labelledby="meet-blurp">
      <img src="/assets/blurp-wide.png" alt="" />
      <div>
        <h2 id="meet-blurp">Meet Blurp</h2>
        <p>
          Blurp is a wizard octopus. He's been online a long time. He's fed
          up with social media and tired of the internet's nonsense, so he
          reads the feeds so you don't have to.
        </p>
      </div>
    </section>

    <h2>What Blurpadurp is</h2>
    <p>
      A filter, run by a tired wizard. One brief a week — sometimes —
      cutting the noise you'd otherwise wade through on a feed to reach
      the few stories actually worth knowing. The success metric is
      inverted: fewer minutes of your time, not more. If nothing clears
      the bar in a given week, nothing ships. Silence is a feature, not
      an outage.
    </p>

    <h2>What "worth knowing" means here</h2>
    <p>
      Two things, and most briefs get only one. There's what informed
      adults are actually discussing this week — the conversation you'd
      otherwise be locked out of without a feed. And there's what will
      still matter in twelve months — the law that passed on page four,
      the study that redirects a field, the quiet shift every loud story
      is a downstream consequence of.
    </p>
    <p>
      A story strong on both leads the issue. Strong on one earns
      inclusion. <em>Worth knowing</em> is the section built
      specifically for the second kind: consequential items the
      algorithmic feed will never surface, because surfacing them
      wouldn't pay.
    </p>

    <h2>What we refuse</h2>
    <p>
      Sports results unless they're civic-scale. Routine product
      launches, quarterly earnings, horse-race polling. Individual crime
      without a systemic angle. Weather that isn't unprecedented. Award
      ceremonies where the outcome isn't the story. Viral content
      trapped on a single platform. Celebrity lives, unless the subject
      is universally known and the occasion is a genuine milestone or a
      public-interest legal matter. And hype — the in-circle kind, the
      manufactured kind, the 72-hour-outrage kind. Those we name in
      <em>Worth a shrug</em> and move on.
    </p>

    <h2>Editorial stance</h2>
    <p>
      Strong opinions on what deserves your attention. No opinion on
      what to make of it. We'll tell you a story belongs in this week's
      brief; we'll give you enough context to form your own read; we
      will not tell you what the read should be. Closest analogues in
      tone are <em>The Economist</em>'s Espresso and Matt Levine's Money
      Stuff — wry, dry, observant, written by a sharp-eyed friend, not
      an anchor reading a teleprompter.
    </p>
    <p>
      Ten categories, no specialty beat. A reader should leave each
      issue with a wider surface area, not a deeper trench in any one
      direction. Context, not interpretation. No cherry-picked quotes,
      no motive attribution, no "this could turn into something." If it
      hasn't, it isn't in the brief.
    </p>

    <h2>How an issue is laid out</h2>
    <p>
      Four sections, always in the same order, any of them may be
      empty. <strong>This week's conversation</strong> holds the items
      you'd be expected to know about. <strong>Worth knowing</strong> is
      what matters even if no one's talking yet. <strong>Worth
      watching</strong> is threads still developing. <strong>Worth a
      shrug</strong> is the week's hype, named and dismissed in one wry
      line. A section only appears if something belongs in it — no
      empty headings, no "nothing to report in X" filler.
    </p>

    <h2>No accounts, no tracking</h2>
    <p>
      Subscribing doesn't create an account. There's nothing to log
      into. Preferences — muting a category, pausing delivery — are
      managed through signed links sent to your own email. No
      third-party scripts, no analytics, no pixels, no "you missed N
      items." You can unsubscribe from any issue.
    </p>
  </Layout>
);
