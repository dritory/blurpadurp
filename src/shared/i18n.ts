// Locale layer for the public site chrome.
//
// Scope, deliberately: this translates the SITE — nav, footer, page
// furniture, the about/privacy prose, the subscribe and preferences
// forms, the transactional emails. It does NOT translate the brief
// itself. Issue bodies are what the composer wrote, in English, and
// they stay that way until there's a decision about how Norwegian prose
// gets produced (a second composer pass against an nb-NO prompt is the
// obvious route, and it roughly doubles composer cost per issue). Every
// Norwegian page that can show a brief says so rather than letting the
// reader discover it — see `briefLanguageNote`.
//
// URL shape: English is unprefixed because it's the canonical site;
// Norwegian lives under /no. That keeps every existing URL, inbound
// link, and R2 key exactly where it was — adding a locale must not
// invalidate the archive.

export const LOCALES = ["en", "nb"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** URL prefix per locale. Empty for the default locale. */
export const LOCALE_PREFIX: Record<Locale, string> = {
  en: "",
  nb: "/no",
};

/** Value for <html lang> and hreflang. */
export const HTML_LANG: Record<Locale, string> = {
  en: "en",
  nb: "nb",
};

/** Intl locale used for date formatting. */
export const DATE_LOCALE: Record<Locale, string> = {
  en: "en-US",
  nb: "nb-NO",
};

/** Endonym, for the language switcher. Always in its own language. */
export const LOCALE_NAME: Record<Locale, string> = {
  en: "English",
  nb: "Norsk",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Prefix an app-absolute path for a locale. `localizePath("nb", "/archive")`
 * → "/no/archive"; the default locale is returned unchanged.
 *
 * The root is special-cased to "/no" rather than "/no/" so there is
 * exactly one URL per page — a trailing-slash variant would be a second
 * URL serving identical bytes, which is a duplicate-content problem and
 * a second R2 key to keep warm.
 */
export function localizePath(locale: Locale, path: string): string {
  const prefix = LOCALE_PREFIX[locale];
  if (prefix === "") return path;
  if (path === "/") return prefix;
  return `${prefix}${path}`;
}

/**
 * Split a request path into its locale and the remaining app path.
 * Unknown prefixes fall through to the default locale with the path
 * untouched, so /nothing-to-do-with-locales is not mistaken for one.
 */
export function splitLocale(pathname: string): {
  locale: Locale;
  path: string;
} {
  for (const locale of LOCALES) {
    const prefix = LOCALE_PREFIX[locale];
    if (prefix === "") continue;
    if (pathname === prefix) return { locale, path: "/" };
    if (pathname.startsWith(`${prefix}/`)) {
      return { locale, path: pathname.slice(prefix.length) };
    }
  }
  return { locale: DEFAULT_LOCALE, path: pathname };
}

/** The other locales, for rendering alternate links and the switcher. */
export function otherLocales(locale: Locale): Locale[] {
  return LOCALES.filter((l) => l !== locale);
}

// A prose block on the long-form pages (about, privacy). `html` is
// hand-authored constant markup — it carries inline <em>/<strong>/<a>
// that a translation needs to place differently than English does, so
// it renders unescaped. Never interpolate anything user-supplied here.
export interface ProseBlock {
  heading: string | null;
  html: string;
}

export interface Strings {
  siteDescription: string;
  tagline: string;
  skipToContent: string;
  brandHomeLabel: string;
  navLabel: string;
  nav: {
    latest: string;
    archive: string;
    subscribe: string;
    about: string;
  };
  footer: {
    silence: string;
    privacy: string;
    rss: string;
    source: string;
    coffee: string;
  };
  languageSwitchLabel: string;
  /** Shown on Norwegian pages that render a brief. Empty on English. */
  briefLanguageNote: string;
  home: {
    empty: string;
    quietTitle: string;
    quietBody: string;
    lastBrief: string;
    olderIssuesHtml: string; // contains the archive link
  };
  archive: {
    title: string;
    pageTitle: string;
    empty: string;
  };
  issue: {
    /** Prefix for the fallback label, e.g. "Issue #12" / "Utgave nr. 12". */
    labelPrefix: string;
    eventDriven: string;
  };
  subscribe: {
    pageTitle: string;
    heading: string;
    intro: string;
    emailLabel: string;
    emailPlaceholder: string;
    button: string;
    fine: string;
  };
  flash: {
    alreadyConfirmed: string;
    checkInbox: string;
    invalidEmail: string;
    rateLimited: string;
  };
  about: {
    pageTitle: string;
    meetHeading: string;
    meetBody: string;
    blocks: ProseBlock[];
  };
  privacy: {
    pageTitle: string;
    blocks: ProseBlock[];
  };
  manage: {
    pageTitle: string;
    heading: string;
    signedInHtml: string; // "{email}" is replaced with the address
    deliveryTime: string;
    deliveryTimeHint: string;
    timezone: string;
    timezoneHintHtml: string;
    urgentLabel: string;
    muteHeading: string;
    muteHintHtml: string;
    save: string;
    unsubscribeLabel: string;
    savedFlash: string;
    badTimeFlash: string;
    badTzFlash: string;
  };
  token: {
    invalidTitle: string;
    invalidConfirm: string;
    invalidGeneric: string;
    invalidManage: string;
    confirmedTitle: string;
    confirmedBody: string; // "{email}" replaced
    alreadyConfirmed: string;
    unsubscribedTitle: string;
    unsubscribedBody: string;
    backToLatest: string;
  };
  errors: {
    notFoundTitle: string;
    notFoundHeading: string;
    notFoundBody: string;
    notFoundAlt: string;
    serverTitle: string;
    serverHeading: string;
    serverBody: string;
    serverAlt: string;
    latestLink: string;
    archiveLink: string;
  };
  email: {
    confirmSubject: string;
    confirmMeta: string;
    confirmBody: string;
    confirmCta: string;
    confirmPasteHint: string;
    confirmExpiry: string; // {host}
    confirmNoAccount: string;
    briefSubjectFallback: string; // {date}
    briefWhyHtml: string; // {link} — an <a> to the site
    briefWhyText: string;
    unsubscribe: string;
    preferences: string;
    readOnWeb: string;
    privacy: string;
  };
}

const EN: Strings = {
  siteDescription:
    "Reads the internet so you don't have to. One brief a week, or nothing.",
  tagline: "Reads the internet so you don't have to.",
  skipToContent: "Skip to content",
  brandHomeLabel: "Blurpadurp — home",
  navLabel: "Primary",
  nav: {
    latest: "Latest",
    archive: "Archive",
    subscribe: "Subscribe",
    about: "About",
  },
  footer: {
    silence: "Silence is a feature. If nothing clears the bar, nothing publishes.",
    privacy: "Privacy",
    rss: "RSS",
    source: "Source",
    coffee: "Coffee",
  },
  languageSwitchLabel: "Language",
  briefLanguageNote: "",
  home: {
    empty: "No issues yet. Blurp hasn't found anything worth sending.",
    quietTitle: "Quiet week.",
    quietBody: "Blurp didn't find anything worth sending.",
    lastBrief: "Last brief",
    olderIssuesHtml: 'Older issues are in the <a href="{archive}">archive</a>.',
  },
  archive: {
    title: "Archive",
    pageTitle: "Archive — Blurpadurp",
    empty: "No issues yet. Blurp hasn't found anything worth sending.",
  },
  issue: {
    labelPrefix: "Issue #",
    eventDriven: "event-driven",
  },
  subscribe: {
    pageTitle: "Subscribe — Blurpadurp",
    heading: "Subscribe",
    intro:
      "One brief a week. No account, no tracking, no password. Unsubscribe from any issue.",
    emailLabel: "Email address",
    emailPlaceholder: "you@example.com",
    button: "Subscribe",
    fine:
      "We confirm the address later, when dispatch is live. You can unsubscribe from any issue.",
  },
  flash: {
    alreadyConfirmed:
      "Already confirmed. You'll hear from Blurp when there's something worth reading.",
    checkInbox:
      "Check your inbox for a confirmation link. You're not on the list until you click it.",
    invalidEmail: "That email didn't parse. Try again.",
    rateLimited: "Too many attempts. Give it a minute and try again.",
  },
  about: {
    pageTitle: "About — Blurpadurp",
    meetHeading: "Meet Blurp",
    meetBody:
      "Blurp is a wizard octopus. He's been online a long time. He's fed up with social media and tired of the internet's nonsense, so he reads the feeds so you don't have to.",
    blocks: [
      {
        heading: "What Blurpadurp is",
        html: "A filter, run by a tired wizard. One brief a week — sometimes — cutting the noise you'd otherwise wade through on a feed to reach the few stories actually worth knowing. The success metric is inverted: fewer minutes of your time, not more. If nothing clears the bar in a given week, nothing ships. Silence is a feature, not an outage.",
      },
      {
        heading: 'What "worth knowing" means here',
        html: "Two things, and most briefs get only one. There's what informed adults are actually discussing this week — the conversation you'd otherwise be locked out of without a feed. And there's what will still matter in twelve months — the law that passed on page four, the study that redirects a field, the quiet shift every loud story is a downstream consequence of.",
      },
      {
        heading: null,
        html: "A story strong on both leads the issue. Strong on one earns inclusion. <em>Worth knowing</em> is the section built specifically for the second kind: consequential items the algorithmic feed will never surface, because surfacing them wouldn't pay.",
      },
      {
        heading: "What we refuse",
        html: "Sports results unless they're civic-scale. Routine product launches, quarterly earnings, horse-race polling. Individual crime without a systemic angle. Weather that isn't unprecedented. Award ceremonies where the outcome isn't the story. Viral content trapped on a single platform. Celebrity lives, unless the subject is universally known and the occasion is a genuine milestone or a public-interest legal matter. And hype — the in-circle kind, the manufactured kind, the 72-hour-outrage kind. Those we name in <em>Worth a shrug</em> and move on.",
      },
      {
        heading: "Editorial stance",
        html: "Strong opinions on what deserves your attention. No opinion on what to make of it. We'll tell you a story belongs in this week's brief; we'll give you enough context to form your own read; we will not tell you what the read should be. Closest analogues in tone are <em>The Economist</em>'s Espresso and Matt Levine's Money Stuff — wry, dry, observant, written by a sharp-eyed friend, not an anchor reading a teleprompter.",
      },
      {
        heading: null,
        html: "Ten categories, no specialty beat. A reader should leave each issue with a wider surface area, not a deeper trench in any one direction. Context, not interpretation. No cherry-picked quotes, no motive attribution, no \"this could turn into something.\" If it hasn't, it isn't in the brief.",
      },
      {
        heading: "How an issue is laid out",
        html: "Four sections, always in the same order, any of them may be empty. <strong>This week's conversation</strong> holds the items you'd be expected to know about. <strong>Worth knowing</strong> is what matters even if no one's talking yet. <strong>Worth watching</strong> is threads still developing. <strong>Worth a shrug</strong> is the week's hype, named and dismissed in one wry line. A section only appears if something belongs in it — no empty headings, no \"nothing to report in X\" filler.",
      },
      {
        heading: "No accounts, no tracking",
        html: 'Subscribing doesn\'t create an account. There\'s nothing to log into. Preferences — muting a category, pausing delivery — are managed through signed links sent to your own email. No third-party scripts, no analytics, no pixels, no "you missed N items." You can unsubscribe from any issue.',
      },
    ],
  },
  privacy: {
    pageTitle: "Privacy — Blurpadurp",
    blocks: [
      {
        heading: "Privacy",
        html: "Short version: we store your email address so we can send you a brief. That's it. No analytics, no third-party scripts, no tracking pixels. No account, no password, no login. If you unsubscribe, we stop sending.",
      },
      {
        heading: "What we store",
        html: "One row per subscriber with your email address, the timestamp you confirmed, and your preferences (delivery time, timezone, any category mutes). Nothing else. We do not store IP addresses alongside subscriptions, we do not fingerprint your browser, and we do not sell, share, or join this data against anything else.",
      },
      {
        heading: "How we use it",
        html: "To send you the brief, once a week at most, only when something actually cleared our editorial gate. Occasionally — never more than twice a year — to send a transactional message about the subscription itself: a confirmation link, a change we need to tell you about, or a notice that we're shutting down.",
      },
      {
        heading: "What we don't do",
        html: "We don't run analytics. No Google Analytics, no Plausible, no Mixpanel. No tracking pixels in emails. No third-party scripts on the site — the only external network call the page makes is to Google Fonts for the Lora typeface, which never sees your identity. Server logs record request paths and status codes without retaining IP addresses beyond what the host infrastructure requires for abuse prevention.",
      },
      {
        heading: "Unsubscribing",
        html: 'Every email has a one-click unsubscribe link in the footer. Use it and you\'re out: your row is marked unsubscribed and no future issue goes to you. We keep the row so we don\'t accidentally re-add you if someone else types your address into the form; if you want it deleted entirely, email <a href="mailto:hello@blurpadurp.com">hello@blurpadurp.com</a> and we will.',
      },
      {
        heading: "Data location",
        html: "The database runs on our own server infrastructure. Email delivery goes through Resend, which processes your address and the brief content to deliver it — their privacy statement covers that leg. We do not send your address to any other third party.",
      },
      {
        heading: "Changes",
        html: "If we ever need to change this — add a service, start doing something with data we didn't used to — we will tell you before it takes effect, not after. No surprise updates buried in a changelog.",
      },
    ],
  },
  manage: {
    pageTitle: "Preferences — Blurpadurp",
    heading: "Preferences",
    signedInHtml:
      "Signed in as <strong>{email}</strong> via a one-shot link. No password, no login — the link is your authorization.",
    deliveryTime: "Delivery time",
    deliveryTimeHint: "Local time to dispatch. Issues arrive within ±30 min.",
    timezone: "Timezone",
    timezoneHintHtml:
      'IANA timezone name (America/New_York, Asia/Tokyo, UTC …). List: <a href="https://en.wikipedia.org/wiki/List_of_tz_database_time_zones" rel="noopener noreferrer" target="_blank">tz database</a>.',
    urgentLabel:
      "Send event-driven issues immediately, ignoring the delivery window above.",
    muteHeading: "Mute categories",
    muteHintHtml:
      "An issue is skipped for you only if <em>every</em> story in it falls under a muted category.",
    save: "Save preferences",
    unsubscribeLabel:
      "I want to unsubscribe from Blurpadurp. (Check this box and save to stop receiving issues. One-click unsubscribe is also available in the footer of every email.)",
    savedFlash: "Preferences saved.",
    badTimeFlash: "That delivery time didn't parse. Use HH:MM.",
    badTzFlash: "That timezone isn't one we recognise.",
  },
  token: {
    invalidTitle: "Link invalid",
    invalidConfirm:
      "That link is invalid or expired. Subscribe again from the homepage.",
    invalidGeneric: "That link is invalid or expired.",
    invalidManage:
      "That preferences link is invalid or expired. The next issue you receive will have a fresh one in the footer.",
    confirmedTitle: "Confirmed",
    confirmedBody:
      "Confirmed — {email}. You'll hear from Blurp when there's something worth reading.",
    alreadyConfirmed: "Already confirmed. Nothing to do.",
    unsubscribedTitle: "Unsubscribed",
    unsubscribedBody:
      "Unsubscribed. No more issues will be sent to this address.",
    backToLatest: "← Back to the latest issue",
  },
  errors: {
    notFoundTitle: "Not found — Blurpadurp",
    notFoundHeading: "Not found",
    notFoundBody:
      "No page at this URL. The brief publishes when it publishes — individual URLs don't go missing, so this is probably a typo.",
    notFoundAlt: "Blurp looking for something that isn't there",
    serverTitle: "Something broke — Blurpadurp",
    serverHeading: "Something broke on our end",
    serverBody:
      "Nothing you can do from here. The operator sees this too and will fix it. Try again in a bit.",
    serverAlt: "Blurp looking overwhelmed",
    latestLink: "← Latest issue",
    archiveLink: "Archive",
  },
  email: {
    confirmSubject: "Confirm your Blurpadurp subscription",
    confirmMeta: "One tap and you're done.",
    confirmBody:
      "Confirm your email so Blurp can send you the brief when there's something worth reading. If you didn't subscribe, ignore this — nothing happens without a click.",
    confirmCta: "Confirm subscription",
    confirmPasteHint: "Or paste this into your browser:",
    confirmExpiry:
      "Link expires in 14 days. Subscribe again from {host} if it does.",
    confirmNoAccount: "No account, no password, no tracking.",
    briefSubjectFallback: "Blurpadurp — {date}",
    briefWhyHtml:
      "You're receiving this because you subscribed at {link}. One brief a week.",
    briefWhyText: "You subscribed at {host}. One brief a week.",
    unsubscribe: "Unsubscribe",
    preferences: "Preferences",
    readOnWeb: "Read on web",
    privacy: "Privacy",
  },
};

// Norwegian bokmål. Written to read as Norwegian rather than as
// translated English: the register the brief aims for (wry, dry,
// observant) survives a literal translation badly, so a few lines are
// re-said rather than word-mapped.
const NB: Strings = {
  siteDescription:
    "Leser internett så du slipper. Ett sammendrag i uka, eller ingenting.",
  tagline: "Leser internett så du slipper.",
  skipToContent: "Hopp til innholdet",
  brandHomeLabel: "Blurpadurp — forsiden",
  navLabel: "Hovedmeny",
  nav: {
    latest: "Siste",
    archive: "Arkiv",
    subscribe: "Abonner",
    about: "Om",
  },
  footer: {
    silence:
      "Stillhet er en funksjon. Er det ingenting som holder mål, kommer det ingenting.",
    privacy: "Personvern",
    rss: "RSS",
    source: "Kildekode",
    coffee: "Kaffe",
  },
  languageSwitchLabel: "Språk",
  briefLanguageNote:
    "Sammendragene skrives på engelsk. Resten av nettstedet er på norsk.",
  home: {
    empty: "Ingen utgaver ennå. Blurp har ikke funnet noe verdt å sende.",
    quietTitle: "Stille uke.",
    quietBody: "Blurp fant ingenting verdt å sende.",
    lastBrief: "Forrige utgave",
    olderIssuesHtml: 'Eldre utgaver ligger i <a href="{archive}">arkivet</a>.',
  },
  archive: {
    title: "Arkiv",
    pageTitle: "Arkiv — Blurpadurp",
    empty: "Ingen utgaver ennå. Blurp har ikke funnet noe verdt å sende.",
  },
  issue: {
    labelPrefix: "Utgave nr. ",
    eventDriven: "hastesak",
  },
  subscribe: {
    pageTitle: "Abonner — Blurpadurp",
    heading: "Abonner",
    intro:
      "Ett sammendrag i uka. Ingen konto, ingen sporing, ingen passord. Du kan melde deg av fra hvilken som helst utgave.",
    emailLabel: "E-postadresse",
    emailPlaceholder: "deg@eksempel.no",
    button: "Abonner",
    fine:
      "Vi bekrefter adressen senere, når utsending er i drift. Du kan melde deg av fra hvilken som helst utgave.",
  },
  flash: {
    alreadyConfirmed:
      "Allerede bekreftet. Du hører fra Blurp når det er noe verdt å lese.",
    checkInbox:
      "Se etter en bekreftelseslenke i innboksen. Du står ikke på lista før du har trykket på den.",
    invalidEmail: "Den e-postadressen lot seg ikke lese. Prøv igjen.",
    rateLimited: "For mange forsøk. Vent et minutt og prøv igjen.",
  },
  about: {
    pageTitle: "Om — Blurpadurp",
    meetHeading: "Møt Blurp",
    meetBody:
      "Blurp er en trollmannsblekksprut. Han har vært på nett lenge. Han er lut lei sosiale medier og trøtt av internettets tøys, så han leser strømmene så du slipper.",
    blocks: [
      {
        heading: "Hva Blurpadurp er",
        html: "Et filter, drevet av en sliten trollmann. Ett sammendrag i uka — noen ganger — som skjærer bort støyen du ellers måtte vasse gjennom i en feed for å nå de få sakene som faktisk er verdt å vite om. Suksessmålet er snudd: færre minutter av tida di, ikke flere. Er det ingenting som holder mål en gitt uke, sendes ingenting. Stillhet er en funksjon, ikke et driftsavbrudd.",
      },
      {
        heading: 'Hva "verdt å vite" betyr her',
        html: "To ting, og de fleste sammendrag får bare den ene. Det er det opplyste voksne faktisk snakker om denne uka — samtalen du ellers ville stått utenfor uten en feed. Og det er det som fortsatt betyr noe om tolv måneder — loven som gikk gjennom på side fire, studien som legger om et fagfelt, den stille forskyvningen enhver høylytt sak er en følge av.",
      },
      {
        heading: null,
        html: "En sak som er sterk på begge, leder utgaven. Sterk på én kvalifiserer til å være med. <em>Worth knowing</em> er seksjonen bygget for den andre typen: konsekvenstunge saker den algoritmiske feeden aldri løfter fram, fordi det ikke ville lønne seg.",
      },
      {
        heading: "Hva vi sier nei til",
        html: "Sportsresultater, med mindre de har samfunnsformat. Rutinemessige produktlanseringer, kvartalstall, meningsmålinger som hesteveddeløp. Enkeltkriminalitet uten systemisk side. Vær som ikke er uten sidestykke. Prisutdelinger der utfallet ikke er poenget. Viralt innhold som aldri forlater én plattform. Kjendisliv, med mindre personen er allment kjent og anledningen er en reell milepæl eller en rettssak av offentlig interesse. Og hype — den innadvendte, den fabrikkerte, den som varer i 72 timer. Den navngir vi i <em>Worth a shrug</em>, og så går vi videre.",
      },
      {
        heading: "Redaksjonell holdning",
        html: "Sterke meninger om hva som fortjener oppmerksomheten din. Ingen mening om hva du skal mene om det. Vi sier at en sak hører hjemme i ukas sammendrag, vi gir deg nok kontekst til å danne din egen lesning, og vi forteller deg ikke hva lesningen bør være. Nærmeste slektninger i tone er Espresso fra <em>The Economist</em> og Matt Levines Money Stuff — tørt, tørrvittig, observant, skrevet av en skarpøyd venn og ikke av en nyhetsanker som leser fra en teleprompter.",
      },
      {
        heading: null,
        html: "Ti kategorier, ingen spesialfelt. En leser skal gå fra hver utgave med bredere flate, ikke en dypere grøft i én retning. Kontekst, ikke tolkning. Ingen plukkede sitater, ingen motivtillegging, ingen «dette kan bli til noe». Har det ikke blitt det, står det ikke her.",
      },
      {
        heading: "Slik er en utgave satt opp",
        html: "Fire seksjoner, alltid i samme rekkefølge, og hvilken som helst av dem kan være tom. <strong>This week's conversation</strong> rommer det du forventes å vite om. <strong>Worth knowing</strong> er det som betyr noe selv om ingen snakker om det ennå. <strong>Worth watching</strong> er tråder som fortsatt utvikler seg. <strong>Worth a shrug</strong> er ukas hype, navngitt og avfeid på én tørr linje. En seksjon dukker bare opp hvis noe hører hjemme i den — ingen tomme overskrifter, ingen «ingenting å melde om X».",
      },
      {
        heading: "Ingen konto, ingen sporing",
        html: "Å abonnere oppretter ikke en konto. Det finnes ingenting å logge inn på. Innstillinger — dempe en kategori, sette leveringen på pause — styres gjennom signerte lenker sendt til din egen e-post. Ingen tredjepartsskript, ingen analyse, ingen sporingspiksler, ingen «du gikk glipp av N saker». Du kan melde deg av fra hvilken som helst utgave.",
      },
    ],
  },
  privacy: {
    pageTitle: "Personvern — Blurpadurp",
    blocks: [
      {
        heading: "Personvern",
        html: "Kortversjonen: vi lagrer e-postadressen din så vi kan sende deg et sammendrag. Det er alt. Ingen analyse, ingen tredjepartsskript, ingen sporingspiksler. Ingen konto, ingen passord, ingen innlogging. Melder du deg av, slutter vi å sende.",
      },
      {
        heading: "Hva vi lagrer",
        html: "Én rad per abonnent med e-postadressen din, tidspunktet du bekreftet, og innstillingene dine (leveringstidspunkt, tidssone, eventuelle dempede kategorier). Ingenting annet. Vi lagrer ikke IP-adresser sammen med abonnementer, vi lager ikke fingeravtrykk av nettleseren din, og vi selger, deler eller kobler ikke disse dataene mot noe annet.",
      },
      {
        heading: "Hva vi bruker det til",
        html: "Til å sende deg sammendraget, høyst én gang i uka, og bare når noe faktisk kom gjennom den redaksjonelle terskelen. Av og til — aldri mer enn to ganger i året — til en praktisk melding om selve abonnementet: en bekreftelseslenke, en endring vi må fortelle om, eller beskjed om at vi legger ned.",
      },
      {
        heading: "Hva vi ikke gjør",
        html: "Vi kjører ikke analyseverktøy. Ingen Google Analytics, ingen Plausible, ingen Mixpanel. Ingen sporingspiksler i e-post. Ingen tredjepartsskript på nettstedet — det eneste eksterne nettverkskallet siden gjør, er til Google Fonts for skrifttypen Lora, og det kallet får aldri vite hvem du er. Tjenerlogger registrerer forespørselsstier og statuskoder uten å beholde IP-adresser lenger enn driftsleverandøren krever for å hindre misbruk.",
      },
      {
        heading: "Å melde seg av",
        html: 'Hver e-post har en avmeldingslenke i bunnteksten som virker med ett klikk. Bruker du den, er du ute: raden din merkes som avmeldt, og ingen framtidige utgaver går til deg. Vi beholder raden så vi ikke ved et uhell legger deg inn igjen om noen andre skriver adressen din i skjemaet. Vil du ha den slettet helt, send en e-post til <a href="mailto:hello@blurpadurp.com">hello@blurpadurp.com</a>, så gjør vi det.',
      },
      {
        heading: "Hvor dataene ligger",
        html: "Databasen kjører på vår egen serverinfrastruktur. E-post leveres gjennom Resend, som behandler adressen din og innholdet i sammendraget for å få det fram — deres personvernerklæring dekker den delen. Vi sender ikke adressen din til noen annen tredjepart.",
      },
      {
        heading: "Endringer",
        html: "Skulle vi noen gang måtte endre dette — legge til en tjeneste, begynne å gjøre noe med data vi ikke gjorde før — sier vi fra før det trer i kraft, ikke etterpå. Ingen overraskelser begravd i en endringslogg.",
      },
    ],
  },
  manage: {
    pageTitle: "Innstillinger — Blurpadurp",
    heading: "Innstillinger",
    signedInHtml:
      "Innlogget som <strong>{email}</strong> via en engangslenke. Ingen passord, ingen innlogging — lenka er autorisasjonen din.",
    deliveryTime: "Leveringstidspunkt",
    deliveryTimeHint:
      "Lokal tid for utsending. Utgaver kommer innenfor ±30 minutter.",
    timezone: "Tidssone",
    timezoneHintHtml:
      'IANA-navn på tidssonen (Europe/Oslo, America/New_York, UTC …). Liste: <a href="https://en.wikipedia.org/wiki/List_of_tz_database_time_zones" rel="noopener noreferrer" target="_blank">tz-databasen</a>.',
    urgentLabel:
      "Send hastesaker med én gang, uten å vente på leveringsvinduet over.",
    muteHeading: "Demp kategorier",
    muteHintHtml:
      "En utgave hoppes bare over for deg hvis <em>alle</em> sakene i den hører til en dempet kategori.",
    save: "Lagre innstillinger",
    unsubscribeLabel:
      "Jeg vil melde meg av Blurpadurp. (Kryss av her og lagre for å slutte å motta utgaver. Avmelding med ett klikk ligger også i bunnteksten på hver e-post.)",
    savedFlash: "Innstillingene er lagret.",
    badTimeFlash: "Det leveringstidspunktet lot seg ikke lese. Bruk TT:MM.",
    badTzFlash: "Den tidssonen kjenner vi ikke igjen.",
  },
  token: {
    invalidTitle: "Ugyldig lenke",
    invalidConfirm:
      "Lenka er ugyldig eller utløpt. Abonner på nytt fra forsiden.",
    invalidGeneric: "Lenka er ugyldig eller utløpt.",
    invalidManage:
      "Innstillingslenka er ugyldig eller utløpt. Neste utgave du mottar har en fersk en i bunnteksten.",
    confirmedTitle: "Bekreftet",
    confirmedBody:
      "Bekreftet — {email}. Du hører fra Blurp når det er noe verdt å lese.",
    alreadyConfirmed: "Allerede bekreftet. Ingenting å gjøre.",
    unsubscribedTitle: "Avmeldt",
    unsubscribedBody:
      "Avmeldt. Ingen flere utgaver sendes til denne adressen.",
    backToLatest: "← Tilbake til siste utgave",
  },
  errors: {
    notFoundTitle: "Ikke funnet — Blurpadurp",
    notFoundHeading: "Ikke funnet",
    notFoundBody:
      "Ingen side på denne adressen. Sammendraget kommer når det kommer — enkeltadresser forsvinner ikke, så dette er nok en skrivefeil.",
    notFoundAlt: "Blurp leter etter noe som ikke er der",
    serverTitle: "Noe røk — Blurpadurp",
    serverHeading: "Noe røk hos oss",
    serverBody:
      "Ingenting du kan gjøre herfra. Den som drifter dette ser det også, og fikser det. Prøv igjen om litt.",
    serverAlt: "Blurp ser overveldet ut",
    latestLink: "← Siste utgave",
    archiveLink: "Arkiv",
  },
  email: {
    confirmSubject: "Bekreft abonnementet ditt på Blurpadurp",
    confirmMeta: "Ett trykk, så er du i mål.",
    confirmBody:
      "Bekreft e-postadressen din, så kan Blurp sende deg sammendraget når det er noe verdt å lese. Abonnerte du ikke, se bort fra denne — ingenting skjer uten et klikk.",
    confirmCta: "Bekreft abonnement",
    confirmPasteHint: "Eller lim dette inn i nettleseren:",
    confirmExpiry:
      "Lenka utløper om 14 dager. Abonner på nytt fra {host} hvis den gjør det.",
    confirmNoAccount: "Ingen konto, ingen passord, ingen sporing.",
    briefSubjectFallback: "Blurpadurp — {date}",
    briefWhyHtml:
      "Du får denne fordi du abonnerte på {link}. Ett sammendrag i uka.",
    briefWhyText: "Du abonnerte på {host}. Ett sammendrag i uka.",
    unsubscribe: "Meld deg av",
    preferences: "Innstillinger",
    readOnWeb: "Les på nett",
    privacy: "Personvern",
  },
};

const STRINGS: Record<Locale, Strings> = { en: EN, nb: NB };

export function t(locale: Locale): Strings {
  return STRINGS[locale] ?? EN;
}

/** Replace {name} placeholders. Values are inserted verbatim — only
 *  call with values that are already safe for the target context. */
export function fill(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? values[key]! : whole,
  );
}
