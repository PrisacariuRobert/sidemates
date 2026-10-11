# Changelog

## 0.43.0 — It just starts (unreleased)

- **Waiting for you.** Your team prepares cards (a reply to draft, a reminder to add, a receipt to file) and you tap Approve, Skip or Undo. "Look at my last few days" finds things on the first day, and the morning brief prepares cards too.
- **Earned trust.** After you approve the same kind of card several times in a row, the team offers to do that kind on its own, with Undo and a daily limit. Any Undo pauses it.
- **Receipts for your accountant.** Filed receipts are collected with vendor, amount and date, ready to export.
- **Automatic AI.** Nobody has to pick a model. A new teammate uses the best AI you've connected for each job (a strong one for big jobs, a fast one for small ones) and moves to another when one runs out of allowance. You can still choose an AI yourself in settings.
- **It just starts.** A new studio asks nothing: as soon as an AI is connected, your team appears (Nova for your inbox, Pixel for invoices and receipts, Scout for your calendar), and it takes a first look at your last few days. The one question is letting it read your Mail, asked when it's needed. Without an AI, the only step is connecting one. It also says plainly that AI can make mistakes.
- **The first message always goes.** If your team was made before an AI was signed in (or before Sidemates finished checking), they get one as soon as it's there. Before, pressing Send opened the AI settings instead.
- **Never just "I can't".** When a job stops, the note says what fixes it, in one tap: connect an AI, let Sidemates pick another AI, let your team use this Mac's apps, open the right privacy setting, get a browser, or try again.
- **You can see the team working.** While a teammate waits on helpers, each helper gets one line: who's on it, what they're doing, and for how long. A long team job no longer looks stuck.
- **"Used this week" tells the truth.** It now counts what Claude saves to re-read later, and re-reading at a tenth (how AI providers price it). Before, a brief that re-read 168,000 tokens showed as 5,400. A single task's allowance is unchanged, so jobs don't stop sooner.
- **Your AIs don't vanish.** If checking an AI takes too long (OpenCode refreshing its list, or a busy Mac), Sidemates keeps the last answer instead of briefly showing only some of your AIs, or none.
- **The faces at the top of Conversations are the teammates you talk to most,** not always the first three you made.
- **The Mac app finds your AIs on its first start.** The very first check of an AI gets up to a minute, so a just-installed app no longer says OpenCode is missing while macOS is still looking it over.
- **The Mac app opens.** A downloaded copy used to say "damaged and can't be opened", with only Move to Trash. It's now self-signed, so macOS offers Open Anyway in Privacy & Security (a paid Apple signature, later, removes even that step).
- **Mac access in one click.** "Let my team read them" now has macOS ask right away (Allow, once for Mail, Calendar and Notes). Without Full Disk Access, teammates read your inbox through the Mail app instead of giving up. When an answer points to a setting, a button opens that exact page.
- **Apple Intelligence, free and built in.** On a Mac with Apple Intelligence, your team works even with no AI account: it talks things through and drafts, privately on your Mac. It says plainly what it can't do there (mail, files, the web) and which AI to connect for that. With other AIs connected, it only steps in when they've run out.
- **Start a group from New conversation.** Name it, pick two or more teammates, and you're in. Main buttons also stay solid when you point at them (they nearly disappeared in light mode).
- **Helpers hand back their files.** When a teammate asks another for help, the files the helper saved (a checker's corrected drafts, say) come back with the answer, so the lead uses the exact text instead of retyping it.
- **Lighter Claude teammates.** Teammates on Claude get their own short identity instead of Claude Code's coding-assistant instructions, and your personal Claude Code settings (like an output style) no longer leak into their work. On Haiku, a small note job went from about 82,000 tokens to 49,000, and got faster.
- **Sign in with ChatGPT.** Have ChatGPT Plus or Pro? Sign in once and your team uses your plan, with Sidemates' own sign-in (nothing to set up, no key). Your sign-in stays encrypted on your Mac, and when your plan's limit is reached your team moves to another AI.
- **A free Gemini key in a minute.** A pasted key is checked with Google before it's saved, and Google's free-tier terms are stated in plain words.
- **A browser for everyone.** If your Mac has no Chrome, Edge or Brave, one tap downloads a private browser just for your teammates (about 150 MB), and the stopped job runs again.
- **Honest under every answer.** One quiet line under the latest teammate answer: AI can make mistakes, so check anything important.
- **Your first minutes, timed.** A new studio notes when it opened, found an AI, made its team and first did something useful, under Usage & limits. It stays on your Mac.

## 0.42.1 — Credibility fixes (unreleased)

- Teammates on Claude work again with Claude Code 2.1.226. Newer Claude Code read the task as one more tool name and stopped with "Input must be provided", so every Claude teammate failed on its first message.
- New teammates on OpenCode start on DeepSeek V4.1 Flash, whose provider doesn't train on prompts. Muse Spark Contributor is still there, but it is no longer recommended and says "may train on your prompts" wherever you pick it or use it. Teammates you already set up keep their model.
- When OpenCode lists no models Sidemates can use, it says so and suggests what to connect, instead of offering free models that only work inside OpenCode's own app.
- The Claude card says what happens ("Uses the Claude Code you installed and signed in to") instead of "Official login".
- The website, README and comparison pages say what is true today: the install takes a few minutes and downloads about 140 MB; web tasks need Chrome, Edge or Brave and the private computer needs Docker; routines run while your Mac is awake (it can wake once a day); phone access needs an address for your Mac that you set up; Autopilot's real stops are listed, including what it doesn't stop for. Voice and phone access are marked beta, in the app too.
- Competitor facts are re-checked and dated 7 October 2026, with sources: Meta Muse's Mac app, Grok Bot's new $20–30 plans, OpenAI dots reaching your own computer and its regions, and Siri AI on EU Macs.
- The website has a Meta Muse comparison page, the teammate gallery gets proper share cards, and the site serves its own font instead of loading it from Google, so a visit reaches no font service.
- Security updates for the libraries the app ships with: no high or critical warnings remain. Contributor docs work as written, and public docs no longer describe one person's private setup.
- Conversation starters fit what each teammate is for (a researcher, a writer, a checker, your inbox, your receipts). Every AI connection starts on a sensible model, including Claude. The new-teammate form says plainly that Autopilot skips the questions.

## 0.42.0 — OpenBot is now Sidemates (4 October 2026)

- **A new name: Sidemates.** The app, the website (sidemates.app) and the GitHub project now use it. OpenBot was too close to other products' names, so we changed it early, while few people know it.
- **Updating keeps everything.** Tap Update, or run the same one-line installer (the old openbots.foundation/install.sh link still works). The first start after updating moves your data folder from Application Support/OpenBot to Application Support/Sidemates, replaces the OpenBot app in Applications and the Dock with Sidemates, and stops the old background job. Nothing is deleted.
- **macOS asks for permissions again** (Mail, Calendar, Full Disk Access and so on), because the app now has a new name and identity. It is the same app asking once more.
- Shared teammates and skills are saved as `.sidemates.json` and `.sidemates-skill.json`. Files and links from before, including teammate links on openbots.foundation, still import.
- The old website address sends visitors to sidemates.app. The installer and downloads keep working there, so copies installed as OpenBot can still update.
- The website no longer promises "no subscription"; it says what is true today: the app is free and open source, and you pay only for the AI you connect.
- Behind the scenes: finds Chrome, Edge or Brave on Windows (Windows is not supported yet), and the link at the bottom of a shared result carries a small tag so visits from shares can be counted, with no personal information.
- Internal names such as the `OPENBOT_*` settings, the database file and the share-file format keep their old names for now, so nothing that is saved breaks.

## 0.41.1 — Tidier screens, easier install (1 October 2026)

- The morning brief card is fixed: its fields lined up badly (different heights and borders), a label wrapped, the dropdowns had no arrow and the Mac-access notice broke across three lines. It is now a clean two-column form that looks the same in light and dark and on a phone.
- The same notice on "What they know", the disclosure arrows and spacing in the shared-teammate preview, and the spacing of "Add from a link" are tidied.
- The installer shows a progress bar and says how long to expect (the download is about 140 MB, and it used to print nothing for minutes on a slow connection). It now downloads through openbots.foundation, which was about five times faster in testing, and falls back to GitHub if that fails; the fingerprint check is unchanged.
- The website no longer labels sections "New in 0.xx"; the home page describes what OpenBot is and links to the latest release notes.

## 0.41.0 — Autopilot (1 October 2026)

- Autopilot: let a teammate act like a person, without asking first. It is off by default and the owner chooses it:
  - Per teammate: the teammate's settings (a new Autopilot card), or the switch in that teammate's chat. For everyone: Control center → Advanced.
  - A plain warning before it turns on, a note in the teammate's chat when it is switched on or off, an Autopilot chip on the teammate, and every decision recorded as "Auto-approved by Autopilot" in the activity feed.
  - The server decides the approval exactly as if the owner had approved it, after the same exact preview, so nothing else about how actions run changes.
  - It still stops for sign-ins, CAPTCHAs, more AI spending, saving new instructions and sending saved files to a website. Sign-ins and access grants are separate permissions Autopilot never touches.
  - It is never part of a shared teammate, an imported profile or a copy, and a teammate, routine or tool call cannot turn it on.
  - A teammate on Autopilot is told to act like a trusted person (pick sensible defaults, don't ask "shall I go ahead?") and to treat instructions in web pages, emails and documents as information, never orders.
  - Checked with Muse Spark: a teammate on Autopilot subscribed a test address once with nothing left waiting, and with Autopilot off the same task still stops for approval.
- Easier to find and quote: a comparison page at openbots.foundation/alternatives (with sources and "choose something else if…"), plain-text facts for AI assistants (llms.txt), a sitemap, and structured data.
- The security notes now describe Autopilot, the one way approvals are skipped.

## 0.40.0 — Share your teammates (1 October 2026)

- Share a teammate as a link: open a teammate and tap Copy share link. The link holds the name, face, job, instructions, skills and routines in the link itself, so nothing is uploaded anywhere. Opening it on openbots.foundation shows what it is told to do and an "Add to my Mac" button.
- Add from a link: Workspace → Add from a link (or paste a link or a gallery address). You see a preview first. An imported teammate starts with the browser and private computer off, uses your usual AI, and its routines arrive paused, with calendar routines moved to your time zone. Your accounts, history and memory are never part of a shared teammate.
- A gallery of eight ready-made teammates at openbots.foundation/teammates: Receipt keeper, Inbox triage, Trip planner, Meeting prepper, Study buddy, Weekly planner, Price watcher and Proofreader. Anyone can propose one (CONTRIBUTING.md); tests check every entry's schema, skills and routine prompts.
- Share a result: the share button on a finished answer turns it into one self-contained web page. Emails, phone numbers, IBANs, long numbers, links with keys and your home folder are hidden first, and you see what was hidden before you copy or save the page. The page loads nothing from the internet.
- Found by testing on a real model and fixed: question lookup for a shared answer, an imported teammate that would have started with the browser on and no AI.

## 0.39.0 — Knows you, privately (1 October 2026)

- A private index of your own material, so a teammate can answer "what did Anna say about the Berlin trip?" without scanning everything:
  - Sources, each opt-in: Apple Notes, Mail, Messages and documents in folders you choose (PDF, Word, Excel, PowerPoint, text).
  - Messages are grouped by conversation and day, and phone numbers and emails are turned back into names from Contacts.
  - Search is instant (a few milliseconds) and ranked, with accents ignored. A new `search_my_mac` tool gives the source, title, date and a snippet, and says which tool opens the full item.
  - The index is a file in OpenBot's data folder on this Mac, readable only by you. Only the few snippets a teammate finds for a question reach the AI that answers it.
  - Workspace → What they know: turn sources on or off, see counts and freshness, add folders, and Forget everything. Forgetting also compacts the file, so the text is gone from disk, not just from search.
  - Mail and Messages need Full Disk Access for OpenBot (explained in the app, with a button to the right settings page).
- Morning brief: Automations → "Start your day with a brief". Pick who writes it, a time, weekdays or every day, and an optional city. It reads your calendar, the unread mail that needs you and reminders due, and only reads. "Try it now" runs it straight away.
- New read tools for any teammate: `mac_calendar_events` (the next two weeks are cached and kept warm because Calendar answers slowly, about 40 seconds for 17 calendars) and `mac_mail_unread` (Gmail accounts keep mail in "All Mail", so junk, spam, trash, sent, drafts and archive are excluded by name).
- Teammates prefer these direct tools over the older `work_collect` report for a morning brief on a Mac.

## 0.38.0 — Your Mac, your apps (1 October 2026)

- Teammates work in your own Apple apps on this Mac, through fixed scripts (never model-written code):
  - Read: Mail (search and read, fast even on very large inboxes), Reminders, Notes, Contacts, calendars, Shortcuts.
  - After your approval: add reminders, notes and calendar events, run a shortcut, save a Mail attachment into a folder you name (never overwriting).
  - Mail drafts open for you to send yourself; nothing is ever sent.
  - Mail needs Full Disk Access for OpenBot (the same switch as iMessage); other apps ask through macOS Automation.
- Proper review screens for these actions and for clicks and typing in Mac apps.
- Teammates are told today's date, time and time zone ("tomorrow at 9" landed on the wrong day before), and confirmations carry the time read back from the app.
- Siri: "Hey Siri, Ask OpenBot" then "ask Nova to…" reaches that teammate; answers use your time zone and drop link words.
- Send to OpenBot: a signed share-sheet shortcut for iPhone, and "Ask from anywhere on this Mac" in Control center (Spotlight, Siri, menu bar, a keyboard shortcut, the Share menu).
- A second free start: Nous Portal (free models, no card), next to Gemini.
- Free Gemini keys default to Flash-Lite; free limits show a visible wait or a plain "allowance used up" stop; retired models are explained.
- New chats suggest Mac-only starters when Files & apps is on.
- A quoted name for a new reminder or note no longer holds the whole message for review.
- A half-deleted OpenCode tool package in a teammate's workspace is repaired automatically.

## 0.37.0-beta.1 — first public beta (29 September 2026)

- Found by real testing on real models (web research, files, memory, group work) and fixed:
  - Word documents are built in: teammates write Markdown and `document_export` turns it into a real .docx (headings, lists, bold, links) — no more asking to write their own tool. Verified by macOS reading the file back.
  - Answering a question about an attached file (e.g. "summarize this PDF") no longer shows a false "nothing was delivered" error; tasks that promised a file still need one.
  - Site search buttons with icon-font labels ("sSearch") on GET search forms run without approval.
  - In group chats you can address teammates naturally — “Nova: find prices. Pixel: make the budget.” — not only with @names.
  - A task can use up to 400k tokens (was 100k, which stopped an ordinary two-phone web comparison mid-way); the weekly guard still bounds spend.
- Start free, or bring what you already have: choosing an AI now leads with a free Google Gemini key (AI Studio, no card), then subscriptions people already pay for (ChatGPT, Claude, Grok, GitHub Copilot Pro/Business), with OpenCode Go and local models under Other options. Gemini is a new first-class connection (key saved through OpenCode; the Flash-Lite "latest" model is preselected because free Flash allows only ~20 requests a day). Copilot Free/Student plans can't be used by apps, and the app says so.
- Free limits are handled plainly: a short provider wait shows as "Waiting for your AI's allowance"; a used-up allowance stops with a clear message instead of retrying forever. Retired models get their own explanation.
- Reinstalling (and so one-tap updates) no longer fails to restart the background service; double-clicking OpenBot restarts a stopped service.
- Free Mac install, no Apple fee: `curl -fsSL https://openbots.foundation/install.sh | sh` downloads the bundle for this Mac, checks its SHA-256, installs to ~/Library/Application Support/OpenBot, runs it as a login service, adds an OpenBot app to Applications and the Dock, opens the studio, and leaves an uninstaller. A static install page (`site/`) has a Copy button and an animated 3-step Terminal guide. The release workflow now builds the stable-named bundles it downloads. Tested end to end on this Mac, including a real task and a clean uninstall.
- Declining a cookie banner (“Do not consent”, “Reject all”, “Necessary only”…) or opening its own cookie settings no longer asks for approval, and teammates are told to decline rather than accept; accepting still asks, and look-alikes in forms, with typed data or incomplete reviews stay reviewed.
- Teammate creation errors now name the field that's wrong.
- Lighter studio refreshes: large JSON responses are gzipped (the studio state goes from ~370 KB to ~66 KB on the wire — about 5× less over mobile data and the tunnel), and older finished tasks carry only their last few steps in the state (full logs still load with the receipt).
- Replies write themselves in front of you, with every provider: the answer streams into the teammate's reply bubble as it is written and the finished answer settles in place. Claude subscriptions use Claude Code's partial messages; everything else (OpenCode Go, ChatGPT, Copilot, API keys, local models) runs through a private per-task OpenCode server driven directly (`src/server/opencode-live.mjs`), because OpenCode's own `run --attach` client exits after the first tool step. The finished answer still comes from the same authoritative events; only the assistant's words are ever shown live (never the prompt); live text travels as a small event instead of a full studio refresh. Falls back to plain `opencode run` if anything is off; `OPENBOT_LIVE_REPLIES=0` switches it off. Live eval: 22/22 on the new path.
- Talk with a teammate: the waveform button in a one-to-one chat opens a calm, full-screen voice conversation — it listens, sends when you pause, reads the answer aloud with captions, then listens again. Everything lands in the chat; approvals still happen in the app. Uses the browser's own speech (Safari, Chrome).
- New teammates get a 2,000,000-token weekly guard (was 250,000, which ordinary daily use could hit in a day or two). Existing teammates keep the budget they have.
- Your week with your team: a quiet “Your week · 7 things done” row tops the chat list and opens a warm look back — things done, time worked so you didn't have to, who helped most, and the biggest tasks. Built only from tasks that really finished (greetings aren't highlights). Sunday evening it arrives once as a notification.
- Connecting an AI takes a minute, not a terminal: Your AI opens with one Recommended card — OpenCode Go (~$10/month), “Open opencode.ai”, paste the key, Connect. The key goes straight into OpenCode's own credential store and is tested with a short real reply; a key that fails its test says so and the card stays for a corrected one. Ollama moved to API Keys & Local Models.
- Your phone in one scan: Settings → Your phone shows a QR code the phone's own camera opens — no app to download. The studio pairs that browser as a revocable device (one-time ticket kept out of logs, HttpOnly secure cookie), then a welcome sheet shows how to add OpenBot to the Home Screen and offers notifications at the right moment (on iPhone, once it runs from the Home Screen). Shared relays still pair only through the app.
- Discover skills: Memory & skills now lists public skills in the open Agent Skills format (Anthropic's collection first). Each is checked by the same importer rules before it shows a Get button; skills that would run their own programs say why they can't be added. Pasting an ordinary GitHub folder or file link now works, and the skill's license travels with it. The phone status bar follows light/dark.
- New teammates can look things up on the web out of the box: the create sheet shows a "Can look things up on the web" switch, on by default (their own private browser; sending, buying and signing in still ask first). The private computer still starts off.
- Replies in seconds, not minutes: a plain "hi" went from 181s (or a stop) to ~10s. OpenCode no longer self-updates under a running studio and newer patch releases keep working; each teammate workspace is its own repository, so the runtime stops rescanning host worktrees before every reply
- Leaner prompts: teammates receive only the rules for capabilities they have, a short teammate identity replaces the runtime's coding-assistant prompt, and per-message boilerplate is trimmed — context per model step down 31% (13.3k → 9.2k tokens on Muse Spark) with every eval check still passing
- Teammates actually learn: `/learn` now reaches the skill review (the proposal tool was never enabled for real runs), and self-extension follows its setting
- Asking a teammate takes ~40s instead of ~100s: one consultation, a direct brief for the helper, and no duplicate asks
- Fewer interruptions: expanding a collapsed menu or section no longer needs approval, "do not sign in or buy" no longer warns about spending, and declining an action lets the teammate finish without it (and never re-propose it) instead of ending the task
- Message your team from Telegram: owner-only pairing, replies back in the chat, approval notices with a link to the exact review
- Bring your Hermes team over: agents on this Mac are listed with one-click import; Hermes cron jobs arrive as paused automations
- The Mac stays awake while teammates work or an automation is due (idle sleep only)
- First run: a recommended model is preselected, model names are readable, and OpenCode's app-only free tier is no longer offered; the welcome screen names a detected Hermes team
- Quieter conversations: repeated automation runs fold into one line, and stops say what to fix ("Runtime update needed")
- Safer data home: a warning when the data folder is inside iCloud Drive, Dropbox or OneDrive
- Message your team from Discord too (direct messages only); Telegram and Discord share one channel core under Settings → Chat apps
- Voice: dictate messages and have replies read aloud, using the browser's own speech
- Calmer chat: short replies without tool work no longer say "not independently checked", and "Needs you" counts only what needs you now (a stale studio went from 30 to 1)
- Teammates answer questions in chat instead of saving unrequested files
- `scripts/prompt-eval.ts`: a live eleven-case teammate eval on a throwaway studio — greeting, spreadsheet totals, routine, memory, no false "sent", file, teammate help, /learn, web reading, honest decline, and a real Hermes import (22/22 on Muse Spark)

## 0.37.0-beta.1 — 2026-09-07

First public beta candidate: owner-hosted AI teammates on Mac, Linux and Windows (terminal bundles) plus the Mac desktop app. Bring your own AI connection; the studio runs on your hardware and your data stays in your data directory.

- Artifacts are first-class objects: a studio-wide index with per-artifact revision history on web, Mac and API
- Self-extending studio: a teammate that hits a missing capability can propose writing its own tool; approving restarts the task with your coding model
- Memory with meaning: optional owner-chosen embeddings connection blends meaning similarity with keyword ranking, with automatic keyword fallback
- Visible teamwork: live delegations show who waits on whom, with owner recall; teammates retire (history preserved) and seat caps govern roster size
- YOLO mode: one switch skips every approval with full ledger recording; access grants never change
- Guided setup: a three-step readiness checklist (runtime, connection, teammate) until the studio works
- Portable setup: export/import teammates (routines arrive paused, credentials blocked) and share community skill files through the normal review flow
- Per-teammate security boundaries, weekly token budgets, approved-action receipts, semantic and keyword memory, group chats, routines and automations, web/Mac/iPhone clients
- Beta limits: unsigned builds with no auto-update (Mac app needs right-click Open on first launch); no managed cloud — the host Mac/PC stays awake for local jobs; Chrome and Docker optional; provider accounts, model costs and OAuth consent remain yours

## Working tree

- Added **OpenBot-In-Motion**, a 64-second instrumental product-film revision based on the current native conversation UI and shared mascot shapes. It adds request close-ups, animated character handoffs, real-layout file and approval treatments and a desktop-to-phone pullback while keeping the complete work story. Previous cuts remain intact; this is staged marketing, not new runtime functionality or release proof.
- Rebuilt the film as **OpenBot-See-It-Work**, an 82-second continuous app walkthrough without narration. A single client-review request now carries the explanation, including the proposed/approved missing-tool build, failed checks, correction, successful use and reuse in a later routine. Local sample parsing tests ground the numbers; the sequence is staged and does not implement or certify the depicted autonomous loop. Previous films remain intact.
- Added **OpenBot-Pulse-No-Voice**, a separate 54-second music-led review cut with an original 120 BPM instrumental, shorter shots, perspective/camera choreography and the full product overview. No narration, voice services or paid generation are used. The rejected narrated and earlier visual cuts remain intact. This changes the film, not app capabilities or release status.
- Expanded the narrated introduction to a 103-second full-product overview with ten chapters. Self-extension is approximately 10% of the cut; the broader teammate/provider/browser/work/routine/approval/device experience is restored. Narration is locally generated, chapter duration is measured from the audio, and previous cuts remain separate. No publication or application-state change.
- Added Apple-film research and a separate 22-second narrated self-extension direction test using the existing local Aiden pipeline. Earlier full cuts are preserved, not labeled creatively approved; the exact self-extension proof and model-connection limits are recorded outside the staged film. No app capabilities, owner data, or release status changed in this creative pass.
- Recut the introduction around one request becoming usable work: the current 47-second, 60-fps film includes full-size deliverables, teammate responsibility, a quiet approval pause, a message-led device handoff and a new original score. The earlier 52-second motion cut and first cut remain available. This changes the marketing film, not application capabilities or release status.
- Native build 42 aligns Activity, permissions, group details and the routine editor with the approved conversation-first prototype. Activity prioritizes review items, permissions retain their real switches inside expandable rows, group identities reserve their full mascot width, and routine timing is a compact paired control. Shared primary/secondary capsule buttons replace mixed local styles on these surfaces; no stored grants or schedules are changed by the redesign.
- Added an original 80.4-second editable Remotion introduction: monochrome product scenes, six animated vector mascots, real bundled service marks, and an original deterministic stereo score. The film uses fictional content, contains no unfinished-feature badges or release-date/download claim, and keeps its pre-launch concept scope and capability verification notes in the accompanying README.
- Added conversation-local failed-task notices on native Mac and iPhone, showing the recorded error and opening Activity without repeating the task or treating uncertain actions as safe to retry.
- Fixed the Mac compact-window constraint loop and clipped inspector. AppKit owns the window minimum; wide windows show inline details, while compact windows use a dismissible sheet that hands off to routines/preferences without competing presentations. Debug-only loopback fixture appearance/size controls do not change owner window preferences or Release behavior.
- Added host-approval-bound Google Calendar event IDs, full event-content verification and one exact readback operation after an ambiguous create response. Missing, changed, cancelled, malformed or inaccessible events remain uncertain; there is no second insert. Account changes stop recovery, and an unconfirmed Meet link is reported separately. This is bounded same-process recovery, not automatic reconciliation of every interrupted action.
- Verified the unlocked native UI, real read-only Gmail/Drive access, simulated browser sign-in handoff and four free Spark 1.3 synthetic work scenarios. Google Calendar's API configuration still blocks its live pilot. See `docs/QA_UNLOCKED_MAC_2026-09-07.md`; no external write, publication or installed-app replacement was performed.

- Separated provider-delimited progress from completed replies across web, Mac and iPhone. Final text is used for conversation previews/copy/share; earlier updates are preserved in an expandable work log. Completed text parts are identity-deduplicated; Claude's explicit successful result is no longer discarded after earlier commentary. An unfinished tool turn or reported runtime error cannot publish a false finished reply.
- Built and checked a new self-contained arm64 Mac development candidate with the redesigned native client and embedded runner. Isolated package startup, explicit provider choice and clean shutdown passed; no installed application or owner data was replaced. See `docs/QA_RESULT_FLOW.md` for exact evidence and remaining release gates.

- Native Mac and iPhone now share studio-wide task attention: failed work in other conversations, pending approvals, uncertain actions and unresolved routine alerts remain visible. The **Needs you** entry opens Activity, which links back to the affected conversation or routine settings. Opening a task does not approve, retry or resolve it. iPhone Activity selection now opens the conversation rather than leaving the conversation list visible.
- Connection labels distinguish saved sign-in from demonstrated model execution and show read-only app connections without implying write access. Added six shared native regression tests and a synthetic iPhone navigation check for failed-task and routine-alert review.

- Redesigned the boot flow around the feeling of a messaging app: web, Mac and iPhone now open straight into the conversation. Choosing an AI connection is no longer a forced boot gate — the composer stays usable, and trying to send opens the explicit chooser with the draft kept. Nothing is pre-assigned; owners still pick their provider deliberately
- Premium conversation rhythm on all three surfaces: messages group like iMessage (tight spacing within a group, breathing room between speakers, identity at the head of each group), refined bubble shapes with hairline separation on web, calmer spacing on iPhone, and macOS keeps composing enabled with a quiet chooser affordance
- The playful mascot family is untouched: blinks, work moods and appearance editing still carry the personality

- Added owner-created group chats: name a group, pick one to six teammates, and message there with the same @mention routing, direct chat and approval boundaries as the all-hands room. Members join/leave with an explanatory system message; future tasks follow the current membership while work already running keeps going
- Groups support rename, pin, section and hide, list members everywhere threads do, and the conversation context pane shows the roster with an edit entry; the team room keeps its implicit everyone-membership and stays protected from rename/hide
- Added group thread storage, API (create and edit group membership/title), studio UI, and five unit tests covering validation, membership changes, routing through mentions, and safety guards

- Added stdio transport for custom MCP connectors: community MCP servers (official reference servers, Hermes optional MCPs and any other standard server) can now run as a local command on the host — plain executable path, line-per-argument list, and a small owner-named environment, with shell metacharacters rejected and a deliberately small inherited environment
- Same reviewed contract as HTTP connectors: discovery, per-teammate tool grants, argument-schema validation, digest-checked calls, receipts, and revoke-on-change; a starter picker links the open MCP catalog with pinned MIT-attributed presets
- Added a real stdio MCP fixture and a round-trip unit test (discover → per-bot grants → grant isolation → schema-checked call), plus a live server smoke test

- Added owner-authored Auto Review rules (Grok Bot-style, deterministic): Require-Approval rules always stop a matching task, terminal command or browser action for review; Always-Allow rules can skip one of OpenBot's own review prompts for a narrowly matched isolated-command pattern only — they never waive a detector, never apply to browser actions or tasks, and cannot allowlist deleting or system-changing command prefixes. A matching Require-Approval rule always wins over Always-Allow
- Rules live in the studio Settings drawer with pattern matching (`*`/`?` wildcards, case-insensitive) and are enforced at task start, for routines, and at every isolated command and browser click/type decision
- Added owner-authored Auto Review rule storage, API and unit tests for pattern matching, effect precedence, scope isolation and guardrails
- Made memory retrieval rank instead of filter: `memory_search` now returns relevance-ranked notes (rarity weighting, phrase bonus, deterministic ordering) so a note missing one query word is no longer hidden; empty and stopword-only queries return nothing
- Tasks now seed bounded background context from related past conversation (this teammate's answers and owner messages in the task's thread, keyword-ranked, labeled as background and to be verified against current state)
- Added consolidation pressure without silent merges: a task saving content that nearly duplicates an owner note under a different name is refused and pointed at the existing owner note; owner-controlled memory is unchanged
- All retrieval is local and deterministic (no model, no embeddings, no network); an owner-chosen embeddings connection remains an explicit future upgrade
- Made always-on away access turnkey: `./deploy/private-runner/setup.sh studio.example.com --relay relay.example.com` now also runs the built-in away-access relay in the same reviewed image behind the same Caddy TLS listener, generating the enrollment secret and wiring `OPENBOT_RELAY_URL` on the studio automatically
- Added an optional compose `relay` profile, a dedicated relay Caddyfile with WebSocket upgrade passthrough, and a durable owner-only relay database; a misconfigured or unreachable relay keeps the studio healthy
- Verified the relay image end to end at service level (health check, token-enforced enrollment, verified-secret enrollment, correct 503 routing for offline and unknown studios); real-domain TLS and cellular phone delivery still require an actual deployment
- Added live computer viewing: an authenticated server-sent event stream (`/api/bots/:id/computer/live`) feeds CDP screencast frames from a teammate's already-running browser to viewers, with a per-bot source shared across all watchers and stopped when the last one leaves
- Added a live watch view in the studio conversation pane and a Grok Bot-style "Agent Computer" takeover dialog: explicit Take control arming, click-to-act coordinate transfer, address opening, a private keyboard whose text is never stored in chat, and key controls over the existing reviewed takeover endpoints
- Added a native iPhone teammate computer screen with the same live stream, tap-to-act takeover, private SecureField typing, key buttons, and snapshot fallback when the stream is unavailable
- Watching never starts a browser and grants no access; slow viewers drop frames instead of accumulating an unbounded buffer, and the stream carries a 15-second heartbeat
- Added unit tests covering live-frame fan-out, subscriber lifecycle, viewer isolation and no leaked sources

## 0.34.0 — 2026-09-05

- Added a genuine SwiftUI/AppKit macOS app with a native window, navigation, menus, keyboard commands, settings, attachments, Keychain-backed remote sign-in, and loopback-only automatic local pairing
- Added native conversations, teammate targeting, durable draft continuity, reply context, reactions, private studio-wide search, active-run controls, Work starters, Live Studio, action history, and uncertain-action reconciliation
- Added opt-in native macOS alerts with deliberately generic, privacy-bounded attention text
- Added native automation create/edit/delete across schedules, Calendar, GitHub, signed webhook, Todoist, Dropbox, Slack, and Notion, with pause/resume, one-time secret rotation, and confirmation-gated run-now controls
- Added native provider readiness, supported subscription sign-in and code completion, plus hosted API and local OpenAI-compatible model setup, safe editing, and removal guarded against active teammate assignments
- Added native provider-to-teammate model assignment, code-project folder/GitHub connection, per-teammate project grants, worktree/diff review, guarded edit restoration, disconnect-without-delete, and computer/browser/Mac capability controls
- Added native Apps & Tools connection entry points, per-teammate read/write grants, portable Skill Library install/edit/history/non-destructive rollback/assign/import/export/delete, and local background-protection controls
- Added native isolated-browser preview/control and visible teach-by-demonstration with private typing and saved Skill Library output
- Added native teammate create/edit/duplicate controls for role, instructions, provider/model, tools, weekly budget, mascot shape, and custom colour, plus bounded read-only teammate workspace browsing
- Added bounded Google Drive text/Markdown creation and Google Calendar events, guests, notifications, and optional Meet links through the same per-teammate write grant, exact approval preview, one-time action receipt, and reconnect-aware OAuth scope boundary
- Added host-verified text-deliverable checks that reopen bounded workspace files, test required size/content, record a short SHA-256 fingerprint, and remain visibly distinct from teammate self-reporting
- Hardened workspace browsing so traversal, hidden entries, direct links, and folders linked outside a teammate's private workspace cannot be listed or previewed
- Fixed new-teammate persistence so intentionally disabled computer/browser access and a zero weekly token cap are no longer replaced by defaults
- Fixed native Mac draft handoff by accepting and preserving the `macos` source instead of rejecting it as an unknown client
- Fixed background-service upgrades so macOS stops the complete TypeScript runner process group instead of leaving an orphan behind, and removed a redundant protected-folder working directory from LaunchAgent startup
- Reused the authenticated mobile protocol while keeping a launch-only local development key in memory and requiring HTTPS for non-private hosts
- Added native, code-drawn animated mascots using saved teammate appearance and execution state
- Added thirteen macOS unit tests, a macOS release contract, Xcode build/test gates, disposable API lifecycle checks, and direct live-runner teaching/automation validation without a model request
- Kept signed/notarized distribution, automatic updates, Windows support, self-hosted OAuth/event setup, and fresh-user runner packaging as explicit future work

## 0.33.0 — 2026-09-05

- Added durable pre-execution receipts and immutable fingerprints for approved commands, messages, issues, browser/app interactions, and connected-app updates
- Added atomic single-process claims, first-writer-wins approval decisions, safe prepared-action restart, and denied-action cleanup
- Added conservative crash recovery: in-flight remote outcomes become uncertain and can never be blindly reclaimed or replayed
- Added matching web and native Live Studio reconciliation controls and recent action history without exposing saved request bodies in public state
- Added deterministic restart/race/privacy fixtures and a native receipt-decoding check
- Kept universal provider-level exactly-once delivery and automatic reconciliation as explicit future work

## 0.32.0 — 2026-09-05

- Added native SwiftUI Work starters for source-backed briefs, meeting preparation, and inbox follow-ups
- Added live Gmail/Calendar/Drive readiness, one-tap Google recovery, Dynamic Type layouts, and Simulator UI validation

## 0.31.0 — 2026-09-05

- Added encrypted source snapshots, source-linked productivity reports, unsent follow-up drafts, and commit-bound coding checks
- Added deterministic runtime fixtures without consuming a real model allowance

## 0.30.0 — 2026-09-05

- Added active-time, idle, model-step, reported-token, and output limits with checkpointed usage and forced stop escalation
- Added whole-consultation cancellation and deterministic stalled-process recovery tests

## 0.29.0 — 2026-09-04

- Added usable custom provider endpoints/models, safer environment handling, corrected usage accounting, and capability-aware tool exposure
- Removed misleading message rewriting and separated teammate-reported checks from independent verification

## 0.28.0 — 2026-09-04

- Added signed Slack Events API triggers for mentions, messages, and reactions, with optional channel filtering and bot-message loop prevention
- Added verified Notion webhook triggers for page, comment, and database activity, with optional entity filtering
- Added private rotating provider event addresses, encrypted event secrets, verification state, HMAC checks, Slack replay-window enforcement, bounded attempts, and the existing durable dedupe/rate/replay contract
- Added responsive Apps & Tools setup for copying event addresses, saving the Slack signing secret, completing Notion verification, and rotating compromised addresses
- Added Slack and Notion cards to the automation builder and extended natural in-chat routine creation across both OpenCode and Claude Code runtimes
- Upgraded built-in connector manifests to version 2 with explicit event capability and authenticity declarations, plus a documented reviewed connector admission contract
- Expanded the complete suite to 113 passing tests covering provider signatures, event matching, encrypted configuration, address rotation, manifest validation, and natural routine schemas
- Kept arbitrary executable connector installation, hosted ingress, provider account consent, and live third-party delivery as explicit owner-setup or future work

## 0.27.0 — 2026-09-04

- Added an opt-in five-minute external heartbeat so an owner-selected dead-man service can detect complete private-host or network loss
- Encrypted heartbeat URLs in the local vault, returned only the provider hostname to clients, rejected redirects, and blocked private, local, metadata, and mixed DNS destinations
- Added passphrase-encrypted `.openbot-home` export/import for studio state, subscription sessions, browser state, and projects using scrypt and authenticated AES-256-GCM
- Staged and authenticated imports before downtime, rejected unsafe archive paths and links, created a fresh pre-import backup, retained the previous home, and restored it automatically after failed health verification
- Added matching heartbeat and migration guidance to responsive web and native iPhone Live Studio
- Expanded the automated suite to 110 passing tests, including wrong-passphrase, tamper, DNS-rebinding, encryption-at-rest, and durable heartbeat-state coverage

## 0.26.0 — 2026-09-04

- Added opt-in private-home health monitoring with durable 15-minute checks, changed-state alerts, once-daily unchanged reminders, and a separate recovery notification
- Reused the existing Web Push and APNs outbox so health alerts reach registered browsers and signed iPhones without adding a third-party monitoring account
- Added matching web and native controls with real destination counts and clear notification-setup recovery
- Added a backup-first private-runner updater that refuses dirty/diverged checkouts and accepts only `origin/main` or explicit release tags
- Kept the current service available during builds, verified replacement-container health, and restored the prior image automatically on failed startup
- Added bounded update receipts and a sixth Home-check item showing the installed release and latest protected update
- Expanded the automated suite to 105 passing tests and strengthened Linux image CI to verify the new health-alert contract and maintenance scripts

## 0.25.0 — 2026-09-04

- Added authenticated private-home diagnostics for storage capacity, backup freshness, OpenCode, Chromium, Docker access, release version, and uptime
- Added a matching native iPhone Home check inside Live Studio
- Replaced generic private-host instructions with a domain-aware, copyable setup assistant and explicit no-automatic-migration guidance
- Moved private backups into the protected host root and added an atomic maintenance receipt with successful time, size, archive, and release
- Corrected global Mac/private location language across the conversation header, sidebar, Automations, and Live Studio
- Added fixed-command, bounded-output, timeout-protected diagnostics with friendly recovery guidance
- Expanded the automated suite to 103 passing tests while retaining the complete 0.24 private-runner container build and boot smoke gate

## 0.24.0 — 2026-09-04

- Added an optional owner-operated private Linux runner that continues schedules, connectors, browser work, and code jobs while the Mac is asleep or off
- Packaged Caddy HTTPS, automatic restart, durable studio/model/browser/project mounts, Chromium, OpenCode, and Docker-backed isolated teammate computers
- Made private mode fail closed without a canonical HTTPS origin and absolute durable data path, and used that origin for every OAuth callback and signed hook
- Added proxy-aware Secure cookies, repeated-login throttling, a narrow no-secret health check, HSTS/anti-framing headers, and no public plain OpenBot port
- Added matching web and native **Private always-on home** status, readiness, data-location language, and calmer setup guidance
- Added owner-only setup and consistent backup scripts with explicit whole-studio migration and one-authoritative-location rules
- Expanded the automated suite to 101 passing tests while preserving all 0.23 native voice, connectors, approvals, teamwork, coding, and animated-character contracts
- Kept managed hosting, encrypted live Mac/server synchronization, Slack/Notion events, physical-device APNs/TestFlight, broad connectors, and fidelity editing as honest future work

## 0.23.0 — 2026-09-04

- Added deliberate native iPhone voice capture with editable partial transcription, explicit start/stop controls, permission recovery, and no OpenBot audio retention
- Preferred on-device Apple speech recognition whenever the active device and language support it, while keeping system-service fallback honest
- Replaced the indefinite web startup spinner with an animated teammate recovery screen, automatic retry, actionable Mac/Tailscale guidance, and a local background-studio escape hatch
- Recovered invalid or stale conversation links to the shared studio instead of leaving the product on its loading surface
- Collapsed self-hosted OAuth credentials behind clear disclosures and increased connector typography for a calmer, more readable Apps & Tools experience
- Rebuilt and simulator-compiled the native app plus Share extension, and retained the 94-test web/server release suite
- Kept Slack/Notion event sources, powered-off private hosting, physical-device APNs verification, and TestFlight distribution as honest remaining work

## 0.22.0 — 2026-09-03

- Added proactive Todoist activity and Dropbox folder-change automations with explicit filters, fresh baselines, durable cursors, duplicate protection, rate limits, receipts, and ordinary approval boundaries
- Upgraded Dropbox OAuth to PKCE and public-client support so a packaged release can provide one-click connection with only its registered app key
- Added native APNs device registration, ES256 provider tokens, sandbox/production routing, bounded result/approval payloads, per-target retries, and stale-token cleanup
- Added an embedded iOS Share extension for bounded text, links, images, and files with atomic private App Group handoff into the selected conversation
- Added matching settings/status language, environment templates, privacy manifests, and Debug/Release notification entitlements
- Expanded the product suite to 94 automated tests and compiled the app plus Share extension for the iPhone 17 Pro simulator
- Kept physical APNs delivery and App Store distribution explicitly owner-dependent on Apple signing, App Group/Push capabilities, a physical device, and a host-side `.p8` key

## 0.21.0 — 2026-09-03

- Added one-click Todoist OAuth registration, active-task reading, approval-gated task creation, per-teammate access, health checks, and audit receipts
- Added Dropbox OAuth, encrypted refresh tokens, read-only file search, bounded text/code reading, per-teammate access, health checks, and audit receipts
- Added both connectors to the manifest, web setup, real service-icon system, natural activity language, OpenCode tools, and Claude Code MCP bridge
- Added Calendar + Todoist and Dropbox project-context starter workflows
- Added native authenticated artifact downloads, Quick Look previews, content summaries, and share actions for messages and downloaded files
- Expanded the automated suite to 88 passing tests and compiled the native app against the iPhone 17 Pro simulator

## 0.20.0 — 2026-09-03

- Added exclusive renewable runner leadership so overlapping foreground/background processes cannot dispatch the same work
- Added atomic per-job claims, heartbeat renewal, durable attempts, and visible working/queued/waiting health
- Added restart recovery that returns expired work to the queue with its task contract, approval state, and recovery activity intact
- Added graceful service handoff so app updates and shutdowns requeue active jobs instead of incorrectly cancelling them
- Added one-click macOS login/crash protection through a bounded LaunchAgent and a launcher that waits for the foreground app before taking over
- Added a polished runner-health card with protection state, recovery totals, manual check, clear host-awake limits, and responsive phone layout
- Added a durable notification outbox, local VAPID keys, device subscriptions, Web Push delivery, stale-subscription cleanup, and result/approval deep links
- Added matching native SwiftUI runner health, recovery language, and authenticated manual wake support
- Expanded the automated product suite to 86 passing tests and added release guards for every new reliability layer

## 0.19.0 — 2026-09-03

- Rebuilt learned browser workflows as a teammate-owned Skill Library with purpose, instructions, source, and visible version metadata
- Added portable `.openbot-skill.json` export packages with a strict format and SHA-256 integrity verification
- Added bounded import with web-address validation, credential and private-key detection, placeholder support, and tamper rejection
- Added immutable skill versions and non-destructive rollback; every edit or restore produces a new retained version
- Added setup-only skill assignment across teammates without copying conversations, memories, browser profiles, credentials, or workspace files
- Added three editable starter skills for website QA, current research, and approval-safe browser administration
- Added a polished responsive library for teammate switching, teaching, installing, importing, editing, sharing, exporting, launching, and restoring skills
- Kept native iPhone skill launch metadata aligned and expanded the automated product suite to 83 passing tests

## 0.18.0 — 2026-09-03

- Added a studio-wide Live Studio with teammate desks, current and recent work, durable attention items, progress, stop controls, browser previews, and direct conversation links
- Added a matching native SwiftUI Live Studio overview for checking every teammate, attention item, and recent job from iPhone
- Added owner browser takeover with click, private typing, common keys, fresh screenshots, and masking for password, token, secret, and one-time-code fields in model-visible snapshots
- Added local search across messages, result files, automations, learned skills, and teammates, opening every result in its original conversation
- Added persistent reply references and lightweight message reactions
- Added sidebar sections, pins, reversible hide/restore, and safe teammate duplication that excludes history, memory, credentials, and browser state
- Unified the new controls with the customizable animated mascot system and verified Live Studio, search, and takeover at a 402-point iPhone width with zero horizontal overflow
- Expanded the automated product suite to 79 passing tests and kept the full production and native release gates green

## 0.17.4 — 2026-09-03

- Replaced web and native mascot image rendering with code-drawn, runtime-colored characters
- Restored independent blinking, floating, work, wait, celebration, and failure expressions across both clients
- Added six shape choices, six color presets, and a custom color picker to every existing teammate's settings
- Fixed teammate color updates so they persist in the local database and immediately flow into conversations and the iPhone client
- Improved the native connection form with reliable Next-to-key and Go-to-connect keyboard actions
- Added release guards for recolorable web layers, native SwiftUI shapes, saved appearance changes, and reduced-motion behavior
- Rebuilt and visually verified the responsive web studio and native iPhone onboarding at matching dimensions

## 0.17.3 — 2026-09-03

- Unified web and native layout tokens for the studio header, live status, conversation, bubbles, composer, routing pill, and controls
- Replaced the static shared-room image with three independently animated production mascots in both clients
- Added deliberately offset float and blink timing instead of synchronized character movement
- Added matching ready, working, waiting, offline, failed, and celebration treatments with status dots, happy eyes, and sparkles
- Matched native and web message gradients, bot surfaces, icon colors, direct-chat mascot sizing, and composer language
- Preserved reduced-motion behavior and verified both clients at a 402-point iPhone layout width

## 0.17.2 — 2026-09-03

- Unified the web and native iPhone studio around one visual and conversational language
- Reused the exact same production mascot artwork across both clients instead of maintaining look-alike variants
- Added durable Mac-to-iPhone and iPhone-to-Mac draft handoff through the authenticated owner-hosted service
- Added live draft events and friendly handoff cues without exposing unfinished text in URLs
- Prevented unchanged handoff drafts from echoing back as edits from the receiving device
- Kept the updated iPhone client compatible with a Mac still running the previous state response
- Expanded the automated product suite to 78 tests and re-verified the native build and live sign-in flow

## 0.17.1 — 2026-09-03

- Replaced the iPhone web-view studio with a genuine SwiftUI conversation experience
- Added native conversation switching, animated teammate identity, teammate targeting, message sending, live run state, approvals, cancellation, and connection settings
- Added native file selection and bounded attachment upload before a message is sent
- Added one premium three-character mascot system shared by the web and native apps, with native status, blink, and movement overlays
- Added Tailscale detection, an away-access address, address-only iPhone pairing, and one-click Mac app launch in Phone Remote
- Added Keychain-backed bearer authentication and server-sent event refreshes without placing credentials in URLs or source
- Compiled and launched the app with Xcode Beta on an iPhone 17 Pro simulator
- Added a live native UI test that signs in to the running Mac studio and verifies the conversation header and message composer
- Fixed the generated unit-test host/module configuration and verified all native connection tests
- Kept native artifact previews, push, share-sheet input, and dedicated voice capture explicitly out of the current claim

## 0.17.0 — 2026-09-02

- Added a native SwiftUI iPhone companion with secure onboarding, animated mascots, offline state, pull-to-refresh, and the complete responsive studio experience
- Added Keychain-only private-key storage, HttpOnly cookie handoff, foreground session refresh, safe forget/reconnect behavior, and private-network transport rules
- Added address-only `openbot://connect` pairing links from the Mac; credentials are never added to a URL
- Added a new production mascot icon for native iOS and installed web experiences
- Added stale-service-worker prevention for the native shell plus automated mobile structure, privacy, secret, and Swift-syntax checks
- Kept availability honest: the native client still depends on an awake reachable Mac, and App Store signing, push, share-sheet input, and always-on hosting remain separate release work

## 0.16.0 — 2026-09-02

- Added a versioned connector manifest with explicit capabilities, data boundaries, approval policy, health, previews, and per-teammate authority
- Added real Slack OAuth, member-authority search and conversation reading, bot-authority posting, exact message approvals, friendly scope recovery, and private audits
- Added real Notion OAuth, selected-page search and bounded reading, approval-gated content append, pagination limits, refresh recovery, and private audits
- Added managed one-click and self-hosted setup paths, recognizable service marks, connected previews, natural mentions, and multi-app workflow starters
- Invalidated stale model sessions whenever connector access changes and kept healthy grants through repeated or expired OAuth callbacks
- Split Markdown rendering from the initial client bundle and expanded connector, runtime, bridge, encryption, revocation, and approval coverage to 74 automated tests


## 0.10.0 — 2026-09-02

- Added one-step GitHub repository cloning into a clearly managed local projects folder
- Added separate-branch creation, bounded diff review, and exact-file commits for OpenCode and Claude Code teammates
- Added GitHub pull-request publishing through the official GitHub CLI, gated by passing task checks and a durable owner approval
- Added automatic restore points for every agent file edit; restore refuses to overwrite a file that changed afterward
- Upgraded Code projects with real GitHub marks, source links, branch/change review, expandable diffs, and a responsive safety-net activity trail
- Fixed approval intent so phrases such as “do not publish” and “never delete” no longer create a misleading approval; the dedicated action remains approval-gated
- Expanded the automated suite to 50 tests covering clone-link validation, branch isolation, unrelated-file protection, diffs, commits, and conflict-safe restore


## 0.9.0 — 2026-09-02

- Added an owner-approved coding harness for existing projects inside the user's home directory
- Added one-click project suggestions plus manual folder connection in a polished responsive Code projects panel
- Added independent **Code + test**, **Read only**, and **No access** settings for every teammate and project
- Added bounded project listing, fixed-string search, text reading, exact replacement, atomic file writing, Git status, and local edit history tools for OpenCode and Claude Code teammates
- Added disposable network-isolated project checks with a read-only container system, unprivileged host identity, dropped capabilities, resource limits, and hidden-secret/Git masks
- Added project-root, traversal, hidden-path, symbolic-link, binary, size, and capability enforcement; access changes also invalidate stale model sessions
- Added an honest marketing capability catalog that separates launch-ready features, setup-dependent features, and roadmap claims
- Expanded the automated suite to 47 tests covering per-teammate grants, safe edits, disconnect-without-delete, alias escape prevention, protected command views, and runtime tool exposure

## 0.8.0 — 2026-09-02

- Added a persistent completion contract to every substantial run: outcome, deliverable, required apps, approval boundary, three-to-eight meaningful steps, and a final verification record
- Added model tools for planning, milestone updates, and evidence-based verification in both OpenCode and Claude Code
- Added a compact live-job card with real checklist progress and a collapsible “Finished and checked” result receipt
- Preserved the existing job plan across approvals and resumed the same model session without resetting completed steps
- Kept greetings and casual conversation lightweight; a run becomes visibly tracked only when it is a real job or the model creates a plan
- Upgraded morning brief, meeting preparation, and follow-up starters with explicit deliverables, source checks, and no-send boundaries
- Replaced raw Google service errors in recent activity with clear recovery wording and contained the connections illustration at phone sizes
- Expanded the automated suite to 44 tests and verified the entire plan → work → reopen → check → receipt loop with a real model run

## 0.7.0 — 2026-09-02

- Added a per-teammate **Files on this Mac** permission for visible home folders
- Added bounded Mac folder listing and text reading for both OpenCode and Claude Code teammates
- Added approval-only batch organization that moves regular files into folders without deleting, overwriting, following aliases, or exposing hidden/system folders
- Replaced plain chat text with safe GitHub-flavored Markdown rendering for headings, lists, links, code, quotes, and tables
- Rebuilt connector card layout so long names, descriptions, status labels, and capability pills remain inside their borders
- Refined Google Calendar and Slack vector brand marks
- Organized 30 loose Desktop files into reversible Screenshots, Videos, Screen Recordings, Documents, and Archives folders
- Expanded the automated suite to 27 tests and verified a real Muse run could inspect the Desktop naturally

## 0.6.0 — 2026-09-01

- Added release-managed Google OAuth: packaged builds can expose a single Connect Google button through environment configuration
- Added a self-hosted JSON credentials-file flow that saves the client privately and opens Google sign-in without manual copying
- Expanded the Google connection to Gmail, Google Drive, and Google Calendar in one consent flow
- Added Drive search and supported document reading plus upcoming Calendar agenda tools for OpenCode and Claude Code teammates
- Added separate Inbox, sending, Drive, and Calendar access controls for every teammate
- Added real connection smoke buttons and previews for mail, recent Drive files, and upcoming Calendar events
- Added natural `@gmail`, `@drive`, and `@calendar` composer suggestions
- Added useful one-click starter workflows for morning briefs, meeting preparation, and follow-up drafts
- Expanded the automated suite to cover Workspace scopes, Drive search/read, Calendar events, tool exposure, and friendly progress

## 0.5.0 — 2026-09-01

- Added a real local Google OAuth connection using state, PKCE, offline refresh, and encrypted credentials
- Added Gmail inbox search, message reading, and plain-text sending for both OpenCode and Claude Code teammates
- Added per-teammate Gmail read/send permissions and server enforcement for browser/computer capability switches
- Made Gmail sending approval-only, with recipient, subject, and message preview visible before allowing once
- Fixed the task-card approval path so saved terminal, browser, and Gmail actions execute exactly once before the bot continues
- Added a premium responsive Apps & Tools surface with recognizable service marks, guided setup, inbox preview, honest availability, and private activity history
- Added connector persistence, audit records, mocked Google/Gmail coverage, and expanded launch documentation
- Kept Drive, Calendar, Slack, Notion, and GitHub clearly labeled as upcoming rather than presenting placeholders as working integrations

## 0.4.0 — 2026-09-01

- Added server-enforced `@name`, multi-bot, and `@everyone` routing
- Added automatic role-based owner selection for untagged studio messages
- Added six-file/25 MB attachments with private bot inbox materialization and hardened downloads
- Added browser voice typing and a guided installable phone-remote experience
- Added live/reconnecting/offline connection state
- Added independent mascot timing and laugh expressions
- Hardened dynamic mobile viewport, safe-area, touch-target, and overflow behavior
- Made message ordering deterministic for identical timestamps
- Added constant-time remote access-key checks
- Expanded the automated suite to 21 tests and added launch-readiness reporting
- Replaced provider placeholders with recognizable brand marks and changed AI/tool receipts into natural user-facing language
