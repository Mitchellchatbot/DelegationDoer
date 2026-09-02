// The two client onboarding questionnaires, as data.
//
// Recreated from the Typeforms the team has been sending out:
//   Website — form.typeform.com/to/TsUodIXn (31 questions; the Website script
//             below has since been edited and no longer matches it)
//   SEO     — form.typeform.com/to/SoEDY9xp (25 questions; the SEO script below
//             has since been edited and no longer matches it either)
//
// NEITHER script is verbatim from its Typeform any more. Both were, deliberately
// — these are the words clients have already been answering, and the team knows
// what the answers to them look like. What overrode that was the team asking for
// the opposite, in September 2026 for the Website script and immediately after
// for the SEO one: correct the punctuation and grammar.
//
// The Website script also lost questions the team had stopped using — five of
// them (company personality, elevator pitch, content readiness, post-launch
// support, and the free-text location the address boxes above it already
// answered) — plus its separate logo-and-images step, whose upload now sits on
// the brand step, and its hosting-and-domain question, which moved onto the
// current-site step. The SEO script kept every question it had; only the wording
// changed there.
//
// The cost is real and was accepted rather than avoided: an answer exported from
// either Typeform and one collected here will NOT read identically any more, so
// anything that lines the two up by question text has to expect that. The rule
// that survives is the one that licensed both passes — neither script gets
// tidied without the team asking for it.
//
// What did NOT change is the storage keys. "state" and "zip" still carry the
// answers to the two relabelled questions, and "branding_materials" still
// carries the upload where it used to carry a Yes/No: a key is part of an answer
// row's primary key, so renaming one orphans every answer already stored under
// it. See CollectField.key.
//
// What was new from the start is the SHAPE. A Typeform asks its questions one at
// a time with no sense of how much is left; this groups them into steps that
// each fill one screen, so a client can see that "your business" is five boxes
// and finish it in a sitting.
//
// Structure mirrors the meta-ads dashboard's onboarding script (awfmp
// src/components/onboarding/steps.ts) so the ported walkthrough renders this
// without reshaping.

/** Where we ask people to send access, rather than passwords. Named once so a
 *  change of inbox is one edit and not a hunt through every question on both
 *  forms. */
export const AGENCY = {
  // websiteEmail and seoWebsiteEmail hold the same address today. Kept as two
  // names rather than collapsed into one because they are two teams' inboxes
  // that happen to agree: the day one of them moves, that should be one edit
  // here and not a silent rewrite of the other form's instructions as well.
  websiteEmail: "websites@scaledai.org",
  seoWebsiteEmail: "websites@scaledai.org",
  googleEmail: "marketingscaledai@gmail.com",
  // Call tracking goes to Sam directly rather than to a shared inbox: he owns
  // SEO, and a call-tracking grant is the one on this form that lands with a
  // named person rather than a team address.
  callTrackingEmail: "Sam@scaledai.org"
} as const;

/** The Typeform tells clients to watch a video before picking a plan. The video
 *  is not in the form definition we can read, so the plan step renders without
 *  it until somebody supplies the URL. Set this and the note appears. */
export const PLAN_VIDEO_URL: string | null = null;

export type FieldKind =
  | "text"
  | "long"
  | "email"
  | "phone"
  | "url"
  | "date"
  | "choice"
  | "multi"
  | "files";

/** One answer we need back. */
export type CollectField = {
  /** Stable storage key. Becomes part of the answer row's primary key, so
   *  renaming one orphans the answers already given under the old name. */
  key: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  /** The description line shown under the label. Most began as the Typeform's
   *  own; some are ours, written where the original said nothing useful — the
   *  upload box's guidance, for instance — and the rest have been corrected in
   *  place. Do not assume any of them still matches a Typeform export. */
  hint?: string;
  choices?: string[];
  /** Encrypted at rest and never shown in Slack. See lib/onboarding-vault. */
  secret?: boolean;
  /** Blocks the gate step's Continue button. Only the contact step uses this —
   *  the Typeform marks nothing else required, and a questionnaire that refuses
   *  to move on is a questionnaire people abandon. */
  required?: boolean;
};

/** A screenshot of the real screen, from the provider's own product.
 *
 *  These beat any description we could write, because the client is matching a
 *  picture to the window in front of them rather than translating a sentence.
 *  The rule that comes with them: a shot must be of the screen the instruction
 *  is actually about. A nearly-right picture sends people to the wrong page
 *  MORE confidently than no picture at all, so no shot is better than an
 *  approximate one. */
export type Shot = {
  /** Lives under public/onboarding/<provider>/. */
  src: string;
  alt: string;
  /** Only worth writing when the picture and the instruction could be read as
   *  disagreeing -- otherwise it is a caption restating the obvious. */
  caption?: string;
};

export type Substep = {
  text: string;
  /** Verbatim UI label to look for, rendered as a chip. */
  click?: string;
  /** How people get this one wrong. Folded into the questions panel rather than
   *  shouted next to the instruction. */
  warn?: string;
  shot?: Shot;
};

export type Step = {
  id: string;
  n: number;
  title: string;
  /** One word, for the progress rail. */
  short: string;
  /** What the finish button says. "Done" tells you nothing about what you just
   *  did; "Sent website access" is the sentence you would use yourself. */
  doneLabel: string;
  minutes: number;
  why?: string;
  whoCanDo?: string;
  substeps?: Substep[];
  collect?: CollectField[];
  verify?: string;
  troubleshoot?: { problem: string; fix: string }[];
  /** The opening screen: full-bleed, no progress chrome, and it will not let
   *  you past without an email. Everything else on this form can be chased
   *  later; an address we never collected cannot. */
  gate?: boolean;
  /** The closing screen. No questions, no finish button of its own. */
  final?: boolean;
};

export type FormKey = "website" | "seo";

export type OnboardingForm = {
  key: FormKey;
  label: string;
  /** Whose Slack channel hears about this one. */
  departmentId: string;
  /** Shown on the opening screen, under the client's name. */
  intro: string;
  steps: Step[];
};

const YES_NO_HELP = ["Yes", "No", "I Need help"];

// ===========================================================================
// WEBSITE
// ===========================================================================

const WEBSITE_STEPS: Step[] = [
  {
    id: "contact",
    n: 1,
    title: "First — who are we building for?",
    short: "Contact",
    doneLabel: "Continue",
    minutes: 1,
    gate: true,
    collect: [
      { key: "first_name", label: "First name", kind: "text", required: true },
      { key: "last_name", label: "Last name", kind: "text" },
      { key: "phone", label: "Phone number", kind: "phone" },
      {
        key: "email",
        label: "Email",
        kind: "email",
        required: true,
        hint: "The inbox you actually read. It is only ever used for your own setup — never a list."
      },
      { key: "company", label: "Company", kind: "text" }
    ]
  },

  {
    id: "business",
    n: 2,
    title: "Your business",
    short: "Business",
    doneLabel: "Saved business details",
    minutes: 4,
    why:
      "Everything on the site — the pages we write, the areas we target, the hours on your contact "
      + "page — starts from these answers. Getting them down once here saves the back-and-forth later.",
    collect: [
      { key: "business_name", label: "What is your business name?", kind: "long" },
      { key: "address_line1", label: "Address line 1", kind: "text" },
      { key: "address_line2", label: "Address line 2", kind: "text" },
      { key: "city", label: "City/Town", kind: "text" },
      // The labels moved, the keys did not: "state" and "zip" are half of an
      // answer row's primary key, so renaming either would orphan the answers
      // already stored under it.
      { key: "state", label: "State/Region", kind: "text" },
      { key: "zip", label: "Post Code", kind: "text" },
      { key: "country", label: "Country", kind: "text" },
      { key: "working_hours", label: "What are your business's working days and hours?", kind: "long" },
      {
        key: "service_areas",
        label: "What locations does your business serve?",
        kind: "long",
        hint:
          "Please list them specifically if they are towns, and if you have a wider range, please "
          + "list the counties."
      }
    ]
  },

  {
    id: "current-site",
    n: 3,
    title: "Your current website and domain",
    short: "Current site",
    doneLabel: "Sent website and domain access",
    minutes: 6,
    why:
      "If you already have a site, it is carrying search rankings we do not want to throw away. "
      + "Access lets us move the content that earned those rankings across to the new build instead "
      + "of starting from zero. The domain matters even if there is no site yet: it is what we point "
      + "at the new build on launch day, and only the service it is registered with can let us do it.",
    whoCanDo:
      "Whoever manages your current website, and whoever bought the domain — often your previous web "
      + "developer or agency, but not always the same person. Not sure? Check who gets the hosting "
      + "bill, and who gets the domain renewal notice.",
    substeps: [
      {
        text:
          "Open the service (GoDaddy, Cloudflare, SiteGround, etc.) where the domain for the website "
          + "lives."
      },
      {
        // No `click` chip on this one, deliberately. The chip is a verbatim UI
        // label to go looking for, and every registrar names this control
        // something different — GoDaddy invites a delegate, Cloudflare invites a
        // member, SiteGround adds a user. A chip quoting one of them sends the
        // other two hunting for a button that is not on their screen.
        text: `Assign access to ${AGENCY.websiteEmail}.`,
        warn:
          "Add us as a user rather than sending a password. A shared login is hard to turn off "
          + "cleanly later, and impossible to trace when something changes."
      },
      {
        text:
          "Tell us below once you have sent it, or pick \"I need help with this\" and we will walk "
          + "you through it."
      }
    ],
    collect: [
      {
        key: "existing_website",
        label:
          "Do you have an existing website? If yes, what is the current URL, and what would you like "
          + "to retain or improve?",
        kind: "long"
      },
      {
        // Moved here from the technical step. It asks about the very account the
        // instructions above have just walked them into, and asking it again five
        // screens later read as us not having listened the first time.
        key: "hosting_domain",
        label: "Do you already have a hosting provider and domain name? If yes, please share the details.",
        kind: "long"
      },
      {
        key: "old_site_access",
        label: `Can you send ${AGENCY.websiteEmail} access to your old website and your domain?`,
        kind: "choice",
        choices: ["Yes", "I need help with this"],
        hint: "This is to transfer over any content we need to maintain SEO rankings."
      }
    ],
    verify:
      `The account where your domain lives lists ${AGENCY.websiteEmail} as a user, and we confirm `
      + "we can see it.",
    troubleshoot: [
      {
        problem: "Your old agency will not add us.",
        fix:
          "They do not have to. Tell us and we will pull the public content across instead — it is "
          + "slower but it gets to the same place."
      }
    ]
  },

  {
    id: "services",
    n: 4,
    title: "What you do",
    short: "Services",
    doneLabel: "Saved services",
    minutes: 3,
    why:
      "Each service you list becomes a page we can rank. Listing them specifically — rather than as "
      + "one line — is the single biggest thing you can do here to help the site bring in work.",
    collect: [
      {
        key: "services",
        label: "What services does your business offer, specifically? Please list them.",
        kind: "long"
      },
      {
        key: "priority_services",
        label:
          "Do you have any services you would like us to prioritize or make stand out more on "
          + "the website?",
        kind: "long"
      }
    ]
  },

  {
    id: "goals",
    n: 5,
    title: "Goals and customers",
    short: "Goals",
    doneLabel: "Saved goals",
    minutes: 3,
    why:
      "A site built to book appointments looks different from one built to sell online. Tell us what "
      + "a good outcome is, and the layout follows from it.",
    collect: [
      {
        key: "website_goals",
        label:
          "What are the primary goals of your website? (e.g., lead generation, e-commerce, brand "
          + "awareness, information sharing)",
        kind: "long"
      },
      {
        key: "average_customer",
        label: "Who is your average customer?",
        kind: "long",
        hint: "Demographic/age group."
      },
      {
        key: "desired_actions",
        label:
          "What specific actions do you want visitors to take on your website? (e.g., booking an "
          + "appointment, signing up, purchasing)",
        kind: "long"
      }
    ]
  },

  {
    id: "brand",
    n: 6,
    title: "Brand and design",
    short: "Brand",
    doneLabel: "Saved brand notes and files",
    minutes: 3,
    why:
      "This is the part that decides whether the first draft feels like you. Examples of sites you "
      + "like tell us more in one link than a paragraph of adjectives can. Send whatever you already "
      + "have while you are here — a logo, photos of your team or your premises, an old brochure. "
      + "Real pictures of your own business beat stock every time, even imperfect ones.",
    collect: [
      {
        // The form's one upload box, and the only field on either form whose KIND
        // has changed since it went live. It keeps the key it carried as a Yes/No
        // question on purpose: the key is half of an answer row's primary key, the
        // old "Yes"/"No" answers live in client_onboarding_answers while uploads
        // live in client_onboarding_files, so the two cannot collide — whereas
        // renaming the key would orphan every answer already given under it.
        key: "branding_materials",
        label: "Do you have branding materials such as a logo, color palette, or font guidelines?",
        kind: "files",
        hint:
          "Your logo, brand colors, fonts and any photos you have. Images, PDFs or a zip. Up to "
          + "25 MB each — send the highest quality you have. Anything else, pop it in a zip."
      },
      {
        key: "admired_sites",
        label: "Are there specific websites, designs, or brands you admire? What do you like about them?",
        kind: "long"
      },
      {
        key: "design_avoid",
        label: "Are there colors, fonts, or design elements you want us to avoid?",
        kind: "long"
      }
    ]
  },

  {
    id: "content",
    n: 7,
    title: "Content and pages",
    short: "Content",
    doneLabel: "Saved content plan",
    minutes: 4,
    why:
      "Content is the thing that most often holds a launch up. Knowing now what you have and what you "
      + "need us to write is what keeps the date you pick on the next step realistic.",
    collect: [
      {
        key: "key_pages",
        label:
          "Do you have any specific key pages or sections you envision for your website? (e.g., About "
          + "Us, Services, Portfolio, Blog)",
        kind: "long"
      },
      {
        key: "company_bio",
        label: "Please provide a company bio and story for the About Us section.",
        kind: "long",
        hint:
          "How long have you been in business? What made you start this business? What are your "
          + "vision, mission, and core values? Tell us about the founders, etc."
      },
      {
        key: "photography",
        label:
          "Do you have professional photography or stock images for your website, or would you prefer "
          + "we use stock photos when needed?",
        kind: "long"
      },
      {
        key: "features",
        label:
          "Are there any specific features or functionalities you need? (e.g., contact forms, booking "
          + "systems, payment gateways, chatbots)",
        kind: "long"
      }
    ]
  },

  {
    // The step id stays "technical" even though nothing technical is left on it
    // once the hosting-and-domain question moves to step 3. It is part of every
    // stored answer's primary key (link:step:field) and of the progress rows in
    // client_onboarding_steps, so renaming it would orphan the answers and the
    // ticks of anyone part-way through a form right now. Display text is free to
    // change; the id is not.
    id: "technical",
    n: 8,
    title: "Launch and contact details",
    short: "Launch",
    doneLabel: "Saved launch and contact details",
    minutes: 3,
    why:
      "The details that go live on the site itself, plus where your inquiries should land. Worth "
      + "double-checking the contact-form address — it is the one mistake nobody notices until a lead "
      + "goes missing.",
    collect: [
      {
        key: "launch_date",
        label: "Do you have a specific launch date or deadline for your website project?",
        kind: "date"
      },
      { key: "site_phone", label: "What phone number would you like on your website?", kind: "phone" },
      { key: "site_email", label: "What email address would you like on your website?", kind: "email" },
      {
        key: "contact_form_email",
        label: "Which email address should we use to send the messages from your website's contact form?",
        kind: "email",
        hint:
          "This is where you'll receive any inquiries or messages submitted through your site's "
          + "contact form."
      }
    ]
  },

  // There is no separate logo-and-images step any more: its one upload box is
  // the branding_materials field on the brand step above, which is where a
  // client is already thinking about how the site should look. Files uploaded
  // under the old step id survive in client_onboarding_files and still show on
  // the client card, which filters by link rather than by step.
  {
    id: "done",
    n: 9,
    title: "That's everything",
    short: "Done",
    doneLabel: "Finish",
    minutes: 0,
    final: true,
    why:
      "Everything we need to start building is in. From here it is on us: structure, design, copy, "
      + "and the pages that bring you work."
  }
];

// ===========================================================================
// SEO
// ===========================================================================

const SEO_STEPS: Step[] = [
  {
    id: "contact",
    n: 1,
    title: "First — who are we working with?",
    short: "Contact",
    doneLabel: "Continue",
    minutes: 1,
    gate: true,
    why:
      "This detailed form will help us gather all the necessary information to optimize your online "
      + "presence effectively.",
    collect: [
      { key: "first_name", label: "First name", kind: "text", required: true },
      { key: "last_name", label: "Last name", kind: "text" },
      { key: "phone", label: "Phone number", kind: "phone" },
      {
        key: "email",
        label: "Email",
        kind: "email",
        required: true,
        hint: "The inbox you actually read. It is only ever used for your own setup — never a list."
      },
      { key: "company", label: "Company", kind: "text" }
    ]
  },

  {
    id: "website-access",
    n: 2,
    title: "Your website and domain",
    short: "Website",
    doneLabel: "Sent website access",
    minutes: 5,
    why:
      "SEO work happens on your own site and your own domain — we publish pages, fix technical "
      + "issues, and set records. Being added as a user is what lets us do that without booking a call "
      + "every time.",
    whoCanDo: "Whoever manages your website or its hosting — often your web developer.",
    substeps: [
      {
        text: `Add ${AGENCY.seoWebsiteEmail} as a user in your website's admin panel.`,
        click: "Add user",
        warn:
          "Adding us as a user is better than sending a password: it can be switched off in one "
          + "click, and every change is traceable to us rather than to your login."
      },
      { text: "Do the same wherever your domain is registered, so we can set records when needed." },
      {
        text:
          "If either of those is not something you can do, pick \"I Need help\" and we will take it "
          + "from there."
      }
    ],
    collect: [
      { key: "website_url", label: "Website URL", kind: "url" },
      {
        key: "backend_access",
        label: "Do you have access to your website's backend/admin panel?",
        kind: "choice",
        choices: YES_NO_HELP,
        hint: `If yes, please provide login credentials or add ${AGENCY.seoWebsiteEmail} as a user.`
      },
      {
        key: "backend_credentials",
        label: "Website admin login details (optional)",
        kind: "long",
        secret: true,
        hint:
          "Only if you cannot add us as a user. Encrypted the moment you send it, never shown in "
          + "chat, and readable by one of our leads only."
      },
      {
        key: "domain_access",
        label: "Do you have access to your website's domain?",
        kind: "choice",
        choices: YES_NO_HELP,
        hint: `If yes, please provide login credentials or add ${AGENCY.seoWebsiteEmail} as a user.`
      },
      {
        key: "domain_credentials",
        label: "Domain registrar login details (optional)",
        kind: "long",
        secret: true,
        hint: "Same as above — encrypted, never posted anywhere, and only if you cannot add us as a user."
      }
    ],
    verify: `Your website admin and your registrar both list ${AGENCY.seoWebsiteEmail} as a user.`
  },

  {
    // The step id stays "google-accounts" even though the step is no longer only
    // about Google. It is part of every stored answer's primary key
    // (link:step:field) and of the progress rows in client_onboarding_steps, so
    // renaming it would orphan the answers and the ticks of anyone part-way
    // through a form right now. Display text is free to change; the id is not.
    id: "google-accounts",
    n: 3,
    title: "Your Google accounts and call tracking",
    short: "Accounts",
    doneLabel: "Sent account access",
    minutes: 6,
    why:
      "Search Console shows what you already rank for, Analytics shows what visitors do next, and your "
      + "Business Profile is most of local search. Call tracking matters for the same reason: if your "
      + "leads arrive by phone, those calls are conversions we would otherwise be blind to, and we would "
      + "end up optimizing for form fills while the phone is where the work actually comes from.",
    whoCanDo:
      "Whoever set these up — often the person who built the site, whoever manages your Google "
      + "account, or whoever pays the phone bill.",
    substeps: [
      {
        text: `In your three Google accounts, add ${AGENCY.googleEmail} as a user.`,
        click: "Add user",
        warn:
          "If you are not sure whether an account exists, pick \"I Need help\" rather than \"No\" — a "
          + "duplicate Business Profile is a genuine problem to unpick, and we would rather check first."
      },
      {
        // A different address from the three above, so it gets its own
        // instruction rather than being folded into "add us to all four" -- the
        // one way this step can go wrong is somebody adding the Google address
        // to their call tracking and telling us they are done.
        text: `If you use call tracking, add ${AGENCY.callTrackingEmail} as a user there — note that this is a different address from the Google one above.`,
        click: "Add user"
      },
      { text: "Answer the four questions below so we know which ones to expect." }
    ],
    collect: [
      {
        key: "search_console",
        label: "Do you have a Google Search Console account set up?",
        kind: "choice",
        choices: YES_NO_HELP,
        hint: `If yes, please add ${AGENCY.googleEmail} as a user.`
      },
      {
        key: "analytics",
        label: "Do you have a Google Analytics account set up?",
        kind: "choice",
        choices: YES_NO_HELP,
        hint: `If yes, please add ${AGENCY.googleEmail} as a user.`
      },
      {
        key: "business_profile",
        label: "Do you have a Google Business Profile set up?",
        kind: "choice",
        choices: YES_NO_HELP,
        hint: `If yes, please add ${AGENCY.googleEmail} as a user.`
      },
      {
        key: "call_tracking",
        label: "Do you have call tracking set up?",
        kind: "choice",
        choices: YES_NO_HELP,
        hint: `If yes, please add ${AGENCY.callTrackingEmail} as a user in your call-tracking account (e.g., CallTrackingMetrics).`
      }
    ],
    verify: "Each account lists us as a user, and we confirm we can see your data."
  },

  {
    id: "audience",
    n: 4,
    title: "Who you are trying to reach",
    short: "Audience",
    doneLabel: "Saved audience",
    minutes: 3,
    why:
      "Who we write for decides the words we write. The same service page reads very differently for a "
      + "35-year-old looking for themselves and a parent looking for their child.",
    collect: [
      {
        key: "audience_age",
        label: "Who is your target audience and consumer (age)?",
        kind: "multi",
        choices: ["Under 18", "18–24", "25–34", "35–44", "45–54", "55–64", "65+"],
        hint: "(Please select all options that apply.)"
      },
      {
        key: "audience_gender",
        label: "Who is your target audience and consumer (gender)?",
        kind: "multi",
        choices: ["Male", "Female", "Non-binary"],
        hint: "(Please select all options that apply.)"
      },
      {
        key: "audience_type",
        label: "Who is your target audience and consumer (type)?",
        kind: "multi",
        choices: [
          "People with mental health concerns",
          "People struggling with addiction",
          "Both",
          "Not Sure",
          "Other (Please write in the next Optional Question in detail)"
        ],
        hint: "(Please select all options that apply.)"
      },
      {
        key: "audience_notes",
        label: "Anything else about your target audience and consumer?",
        kind: "long",
        hint: "(Optional — in case you'd like to add anything to the previous question.)"
      }
    ]
  },

  {
    id: "programs",
    n: 5,
    title: "Programs you offer",
    short: "Programs",
    doneLabel: "Saved programs",
    minutes: 4,
    why:
      "Every program you tick becomes something we can build a page around and rank for. Ticking one "
      + "you do not actually run is worse than leaving it blank — it brings in inquiries from people "
      + "you cannot help.",
    collect: [
      {
        key: "programs_addiction",
        label: "What programs do you offer (Addiction Treatment Programs)?",
        kind: "multi",
        hint: "(Please select all options that apply.)",
        choices: [
          "Medical Detox Program",
          "Inpatient Rehab Program",
          "Residential Treatment Program",
          "Partial Hospitalization Program (PHP)",
          "Intensive Outpatient Program (IOP)",
          "Outpatient Program (OP)",
          "Day Treatment Program",
          "Dual Diagnosis Program (co-occurring disorders)",
          "Medication-Assisted Treatment (MAT) Program",
          "Relapse Prevention Program",
          "Aftercare / Continuing Care Program",
          "Sober Living / Transitional Housing",
          "Alumni / Recovery Support Program",
          "Intervention Program",
          "Virtual / Telehealth Addiction Treatment"
        ]
      },
      {
        key: "programs_mental_health",
        label: "What programs do you offer (Mental Health Programs)?",
        kind: "multi",
        hint: "(Please select all options that apply.)",
        choices: [
          "Inpatient (hospital-based care)",
          "Residential treatment",
          "Partial Hospitalization Program (PHP)",
          "Intensive Outpatient Program (IOP)",
          "Outpatient therapy",
          "Crisis stabilization",
          "Dual diagnosis (mental health + addiction)",
          "Psychiatry services (evaluation + medication)",
          "Therapy programs (individual / group / family)",
          "Aftercare / ongoing support",
          "Virtual / online programs"
        ]
      }
    ]
  },

  {
    id: "services",
    n: 6,
    title: "Services you offer",
    short: "Services",
    doneLabel: "Saved services",
    minutes: 5,
    why:
      "The same logic as the programs step, one level down. These lists are long on purpose — each "
      + "line is a search someone is typing right now.",
    collect: [
      {
        key: "services_substance",
        label: "What services do you offer (Substance-Specific Treatment)?",
        kind: "multi",
        hint: "(Please select all options that apply.)",
        choices: [
          "Alcohol addiction treatment",
          "Opioid addiction (heroin, fentanyl, prescription opioids)",
          "Benzodiazepine addiction (Xanax, Valium, etc.)",
          "Prescription drug addiction (painkillers, sleep meds)",
          "Stimulant addiction (Adderall, cocaine, meth)",
          "Marijuana / cannabis addiction",
          "Hallucinogens (LSD, psilocybin, PCP)",
          "Club drugs (MDMA, ketamine, GHB)",
          "Inhalants (nitrous oxide, solvents)",
          "Nicotine / tobacco / vaping addiction",
          "Polysubstance use"
        ]
      },
      {
        key: "services_clinical_addiction",
        label: "What services do you offer (Clinical Services — Addiction)?",
        kind: "multi",
        hint: "(Please select all options that apply.)",
        choices: [
          "Medical detox",
          "Withdrawal management",
          "Medication-Assisted Treatment (MAT) (Suboxone, Methadone, Vivitrol)",
          "Addiction counseling (individual)",
          "Group therapy",
          "Family therapy",
          "Relapse prevention programs",
          "Dual diagnosis treatment",
          "Case management / care coordination",
          "Drug testing / monitoring",
          "Intervention services"
        ]
      },
      {
        key: "services_clinical_mental_health",
        label: "What services do you offer (Clinical Services — Mental Health)?",
        kind: "multi",
        hint: "(Please select all options that apply.)",
        choices: [
          "Psychiatric evaluation",
          "Medication management",
          "Mental health assessments",
          "Individual therapy",
          "Group therapy",
          "Family / couples therapy",
          "Crisis intervention / stabilization",
          "Depression treatment",
          "Anxiety treatment",
          "PTSD / trauma treatment",
          "Bipolar disorder treatment",
          "ADHD treatment",
          "Cognitive Behavioral Therapy (CBT)",
          "Dialectical Behavior Therapy (DBT)",
          "EMDR (trauma therapy)",
          "Trauma-informed therapy",
          "Mindfulness / meditation",
          "Life skills training"
        ]
      },
      {
        key: "services_other",
        label: "What other services do you offer?",
        kind: "long",
        hint: "(If there are any that weren't mentioned in the lists above, please add them here.)"
      }
    ]
  },

  {
    id: "targeting",
    n: 7,
    title: "Where to focus first",
    short: "Targeting",
    doneLabel: "Saved priorities",
    minutes: 4,
    why:
      "We cannot target everywhere at once and get anywhere. Naming the one location and service that "
      + "matters most is what turns a plan into a first month of work.",
    collect: [
      {
        key: "target_areas",
        label: "What areas do you serve or target?",
        kind: "long",
        hint:
          "(Please be as specific as possible about demographics, locations, behaviors, etc.\n"
          + "Whatever you mention here is what we will target.)"
      },
      {
        key: "priority_location_service",
        label: "What location and service would you like us to prioritize first?",
        kind: "long",
        hint:
          "(Please be as specific as possible about demographics, locations, behaviors, etc.\n"
          + "Whatever you mention here is what we will target.)"
      },
      {
        key: "content_priorities",
        label:
          "Are there any specific topics, services, or areas you would like us to prioritize in your "
          + "content?",
        kind: "long"
      },
      {
        key: "content_exclusions",
        label: "Are there any topics, services, or areas you would prefer we do NOT create content around?",
        kind: "long"
      }
    ]
  },

  {
    id: "goals",
    n: 8,
    title: "Competitors and goals",
    short: "Goals",
    doneLabel: "Saved goals",
    minutes: 3,
    why:
      "Your competitors show us what is already ranking and what it would take to get past it. Your "
      + "goals tell us which of those fights is worth picking.",
    collect: [
      { key: "competitors", label: "Who are your top 3 competitors?", kind: "long" },
      {
        key: "business_goals",
        label: "What are your top 3 business goals for the next 12 months?",
        kind: "long"
      },
      { key: "other_info", label: "What other information should we know?", kind: "long" }
    ]
  },

  {
    id: "plan",
    n: 9,
    title: "Your plan",
    short: "Plan",
    doneLabel: "Confirmed plan",
    minutes: 2,
    collect: [
      {
        key: "plan_level",
        label: "Please confirm your plan level.",
        kind: "choice",
        choices: ["Starter Plan", "Growth Plan", "Gold Plan", "Platinum Plan"],
        hint: PLAN_VIDEO_URL ? "Please watch this video before choosing your plan." : undefined
      }
    ]
  },

  {
    id: "done",
    n: 10,
    title: "That's everything",
    short: "Done",
    doneLabel: "Finish",
    minutes: 0,
    final: true,
    why:
      "Everything we need to start is in. We audit what you have, pick the first pages to build, and "
      + "come back to you with the plan for month one."
  }
];

// ===========================================================================

export const FORMS: Record<FormKey, OnboardingForm> = {
  website: {
    key: "website",
    label: "Custom Website Onboarding",
    departmentId: "dep_web",
    intro:
      "A few questions about your business so we can build you a site that brings in work. It saves as "
      + "you go, so you can stop and come back to it.",
    steps: WEBSITE_STEPS
  },
  seo: {
    key: "seo",
    label: "SEO Onboarding",
    departmentId: "dep_seo",
    intro:
      "A few questions about your business, your services, and where you want to grow. It saves as you "
      + "go, so you can stop and come back to it.",
    steps: SEO_STEPS
  }
};

export const FORM_KEYS: FormKey[] = ["website", "seo"];

export function isFormKey(v: unknown): v is FormKey {
  return v === "website" || v === "seo";
}

export function getForm(key: FormKey): OnboardingForm {
  return FORMS[key];
}

export function getStep(key: FormKey, stepId: string): Step | null {
  return FORMS[key].steps.find((s) => s.id === stepId) ?? null;
}

export function getField(key: FormKey, stepId: string, fieldKey: string): CollectField | null {
  return getStep(key, stepId)?.collect?.find((f) => f.key === fieldKey) ?? null;
}

/** Steps that count towards the "n of N done" line on the rail — the closing
 *  celebration is not work the client has to do, so counting it would leave the
 *  rail permanently one short of full.
 *
 *  N differs per form (the Website script is eight working steps, the SEO one
 *  nine) and moves whenever a questionnaire does, which is why every caller —
 *  the rail, the Slack notices, the client card — asks this rather than writing
 *  a number down. */
export function workingSteps(key: FormKey): Step[] {
  return FORMS[key].steps.filter((s) => !s.final);
}

// ---------------------------------------------------------------------------
// Which answers backfill the client record when a form is completed.
// ---------------------------------------------------------------------------
// Field keys are unique within a form, so a flat key is enough. Careful: that
// holds for the DEFINITION, not necessarily for the rows already stored. A field
// moved between steps leaves its old row behind under the old step id —
// hosting_domain went from "technical" to "current-site", and a link answered
// before that move carries both — so one link can hold two rows for one key.
// None of the keys mapped below have ever moved; the day one does, this lookup
// has to become step-aware.
// Only ever written into columns that are still empty — see applyAnswersToClient.
// There is deliberately no entry for the client's NAME. A head typed that to
// mint the link, it is the label the account carries everywhere, and the form's
// name question is free text — see applyAnswersToClient for why overwriting it
// is the wrong trade.
export const CLIENT_FIELD_MAP: Record<
  FormKey,
  {
    website?: string;
    contactFirstName?: string;
    contactLastName?: string;
    contactEmail?: string;
    businessInformation?: string;
  }
> = {
  website: {
    contactFirstName: "first_name",
    contactLastName: "last_name",
    contactEmail: "email",
    businessInformation: "company_bio"
  },
  seo: {
    website: "website_url",
    contactFirstName: "first_name",
    contactLastName: "last_name",
    contactEmail: "email",
    businessInformation: "other_info"
  }
};
