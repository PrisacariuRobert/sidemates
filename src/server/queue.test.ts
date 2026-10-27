import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenBotDatabase } from "./testing/database.js";
import { demoQueueExecutor } from "./demo-mac.js";
import { QUEUE_AUTO_PER_DAY, QUEUE_CARDS_PER_DAY, QUEUE_OFFER_AFTER, QueueError, WorkQueue, patternLabel, proposalFromFlatArgs, queuePattern, queueProposalInput, senderKey, type QueueExecutor } from "./queue.js";

/** A Mac that records what it was asked to do. */
function fakeMac(options: { failOn?: string } = {}) {
  const calls: string[] = [];
  const state = { failOn: options.failOn };
  const maybeFail = (name: string) => { if (state.failOn === name) throw new Error(`${name} failed. Nothing was changed.`); };
  const executor: QueueExecutor = {
    async createReminder(input) { maybeFail("createReminder"); calls.push(`createReminder:${input.title}`); return { id: "rem-1", list: "Reminders", title: input.title, due: input.due ?? null }; },
    async deleteReminder(id) { maybeFail("deleteReminder"); calls.push(`deleteReminder:${id}`); },
    async createEvent(input) { maybeFail("createEvent"); calls.push(`createEvent:${input.title}`); return { id: "evt-1", calendar: "Home", title: input.title }; },
    async deleteEvent(id, calendar) { maybeFail("deleteEvent"); calls.push(`deleteEvent:${id}:${calendar}`); },
    async saveMailDraft(input) { maybeFail("saveMailDraft"); calls.push(`saveMailDraft:${input.subject}`); return { saved: true as const, subject: input.subject, at: "2026-10-05T08:00:00.000Z" }; },
    async deleteMailDraft(ref) { maybeFail("deleteMailDraft"); calls.push(`deleteMailDraft:${ref.subject}`); },
    async saveMailAttachment(input) { maybeFail("saveMailAttachment"); calls.push(`saveMailAttachment:${input.attachment}`); return { saved: `/Users/test/${input.folder}/${input.attachment}`, bytes: 1234 }; },
    async trashFile(filePath) { maybeFail("trashFile"); calls.push(`trashFile:${filePath}`); },
  };
  return { executor, calls, state };
}

function setup(options: { failOn?: string; now?: () => Date; cardsPerDay?: number } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "sidemates-queue-test-"));
  const db = new OpenBotDatabase(root);
  const mac = fakeMac(options);
  const queue = new WorkQueue(db, () => mac.executor, options.now, { cardsPerDay: options.cardsPerDay });
  return { db, queue, mac, done: () => rmSync(root, { recursive: true, force: true }) };
}
/** Trust tests make many cards in one test day; a day's real limit of eight is covered on its own. */
const trustSetup = () => setup({ cardsPerDay: 1000 });

const reminder = (sourceKey: string) => ({ kind: "reminder", title: "Pay the electricity bill", why: "The bill in your mail is due Friday.", sourceKey, action: { title: "Pay the electricity bill", due: "2026-10-09T09:00:00+03:00" } });
const eventCard = (sourceKey: string) => ({ kind: "calendar_event", title: "School concert", why: "The school asked families to come.", sourceKey, action: { title: "School concert", start: "2026-10-14T18:00:00+03:00", end: "2026-10-14T19:30:00+03:00" } });
const draftCard = (sourceKey: string) => ({ kind: "reply_draft", title: "Reply to Anna", why: "Anna asked on Tuesday and nobody answered.", sourceKey, action: { to: ["anna@example.com"], subject: "Re: Berlin trip", body: "Hi Anna, Friday works for me." } });
const fileCard = (sourceKey: string) => ({ kind: "file_attachment", title: "File the invoice", why: "Acme sent an invoice PDF.", sourceKey, action: { id: "12345", attachment: "invoice-1042.pdf", folder: "Documents/Receipts/2026-10" } });

test("proposing a card runs nothing and shows what approving will do", () => {
  const { queue, mac, done } = setup();
  try {
    const result = queue.propose(reminder("mail:1"), { botId: "nova", runId: "run-1" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.item.status, "ready");
    assert.match(result.item.preview, /Pay the electricity bill/);
    assert.deepEqual(mac.calls, [], "a proposal must never touch the Mac");
    assert.equal(queue.list().ready.length, 1);
  } finally { done(); }
});

test("invalid cards are refused with a plain reason and nothing is stored", () => {
  const { queue, done } = setup();
  try {
    const noRecipient = queue.propose({ ...draftCard("mail:2"), action: { to: [], subject: "x", body: "y" } }, { botId: null, runId: null });
    assert.equal(noRecipient.ok, false);
    const endsBeforeStart = queue.propose({ ...eventCard("mail:3"), action: { title: "x", start: "2026-10-14T19:00:00+03:00", end: "2026-10-14T18:00:00+03:00" } }, { botId: null, runId: null });
    assert.equal(endsBeforeStart.ok, false);
    const unknownKind = queue.propose({ ...reminder("mail:4"), kind: "send_email" }, { botId: null, runId: null });
    assert.equal(unknownKind.ok, false);
    const escapesHome = queue.propose({ ...fileCard("mail:5"), action: { id: "1", attachment: "a.pdf", folder: "../outside" } }, { botId: null, runId: null });
    assert.equal(escapesHome.ok, false);
    assert.equal(queue.list().ready.length, 0);
  } finally { done(); }
});

test("the same source never makes two cards, and a skipped card does not come back", async () => {
  const { queue, done } = setup();
  try {
    const first = queue.propose(reminder("mail:7"), { botId: null, runId: null });
    assert.equal(first.ok, true);
    const again = queue.propose(reminder("mail:7"), { botId: null, runId: null });
    assert.equal(again.ok && again.item.id, false);
    assert.equal(again.ok, false);
    if (!first.ok) return;
    queue.skip(first.item.id);
    const afterSkip = queue.propose(reminder("mail:7"), { botId: null, runId: null });
    assert.equal(afterSkip.ok, false, "a person who said no is not asked again");
  } finally { done(); }
});

test("a day holds at most eight cards", () => {
  const { queue, done } = setup();
  try {
    for (let i = 0; i < QUEUE_CARDS_PER_DAY; i++) assert.equal(queue.propose(reminder(`mail:cap-${i}`), { botId: null, runId: null }).ok, true);
    const ninth = queue.propose(reminder("mail:cap-extra"), { botId: null, runId: null });
    assert.equal(ninth.ok, false);
    if (!ninth.ok) assert.equal(ninth.reason, "full");
  } finally { done(); }
});

test("approving runs the saved action exactly once and keeps what Undo needs", async () => {
  const { queue, mac, done } = setup();
  try {
    const proposed = queue.propose(reminder("mail:10"), { botId: null, runId: null });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const approved = await queue.approve(proposed.item.id);
    assert.equal(approved.status, "done");
    assert.equal(approved.decidedBy, "person");
    assert.deepEqual(approved.result, { id: "rem-1", list: "Reminders", title: "Pay the electricity bill", due: "2026-10-09T09:00:00+03:00" });
    await assert.rejects(queue.approve(proposed.item.id), (error: unknown) => error instanceof QueueError && error.code === "already_handled");
    assert.deepEqual(mac.calls, ["createReminder:Pay the electricity bill"], "two taps must not make two reminders");
  } finally { done(); }
});

test("two approvals at the same moment still run once", async () => {
  const { queue, mac, done } = setup();
  try {
    const proposed = queue.propose(eventCard("mail:11"), { botId: null, runId: null });
    if (!proposed.ok) throw new Error("setup");
    const results = await Promise.allSettled([queue.approve(proposed.item.id), queue.approve(proposed.item.id)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.deepEqual(mac.calls, ["createEvent:School concert"]);
  } finally { done(); }
});

test("a failed action is marked failed with a plain message and is never half-done", async () => {
  const { queue, db, done } = setup({ failOn: "createReminder" });
  try {
    const proposed = queue.propose(reminder("mail:12"), { botId: null, runId: null });
    if (!proposed.ok) throw new Error("setup");
    await assert.rejects(queue.approve(proposed.item.id), /createReminder failed/);
    const card = db.queueItemGet(proposed.item.id)!;
    assert.equal(card.status, "failed");
    assert.match(card.error ?? "", /Nothing was changed/);
  } finally { done(); }
});

test("undo reverses each kind of change with the right inverse", async () => {
  const { queue, mac, done } = setup();
  try {
    const cards = [reminder("mail:20"), eventCard("mail:21"), draftCard("mail:22"), fileCard("mail:23")]
      .map((card) => queue.propose(card, { botId: null, runId: null }));
    for (const card of cards) { assert.equal(card.ok, true); if (card.ok) { await queue.approve(card.item.id); await queue.undo(card.item.id); } }
    assert.deepEqual(mac.calls, [
      "createReminder:Pay the electricity bill", "deleteReminder:rem-1",
      "createEvent:School concert", "deleteEvent:evt-1:Home",
      "saveMailDraft:Re: Berlin trip", "deleteMailDraft:Re: Berlin trip",
      "saveMailAttachment:invoice-1042.pdf", "trashFile:/Users/test/Documents/Receipts/2026-10/invoice-1042.pdf",
    ]);
    assert.deepEqual(queue.list().recent.map((c) => c.status).sort(), ["undone", "undone", "undone", "undone"]);
  } finally { done(); }
});

test("a reply is only ever saved as a draft: nothing in the queue can send", () => {
  const { queue, done } = setup();
  try {
    const sendIt = queue.propose({ ...draftCard("mail:30"), action: { to: ["anna@example.com"], subject: "x", body: "y", send: true } }, { botId: null, runId: null });
    assert.equal(sendIt.ok, false, "unknown fields such as send are rejected");
  } finally { done(); }
});

test("when undo fails the card stays done so it can be tried again", async () => {
  const { queue, db, done } = setup({ failOn: "deleteReminder" });
  try {
    const proposed = queue.propose(reminder("mail:40"), { botId: null, runId: null });
    if (!proposed.ok) throw new Error("setup");
    await queue.approve(proposed.item.id);
    await assert.rejects(queue.undo(proposed.item.id), /deleteReminder failed/);
    assert.equal(db.queueItemGet(proposed.item.id)!.status, "done");
  } finally { done(); }
});

test("undo is offered for seven days, then the person is told to change it in the app", async () => {
  // The approval is stamped with the real time, so the fake clock must start from it.
  const start = Date.now();
  let now = new Date(start);
  const { queue, done } = setup({ now: () => now });
  try {
    const proposed = queue.propose(reminder("mail:50"), { botId: null, runId: null });
    if (!proposed.ok) throw new Error("setup");
    await queue.approve(proposed.item.id);
    now = new Date(start + 15 * 86_400_000);
    await assert.rejects(queue.undo(proposed.item.id), (error: unknown) => error instanceof QueueError && error.code === "too_old");
  } finally { done(); }
});

test("cards nobody decided expire after a week and stop being offered", () => {
  let now = new Date("2026-10-05T09:00:00Z");
  const { queue, done } = setup({ now: () => now });
  try {
    queue.propose(reminder("mail:60"), { botId: null, runId: null });
    assert.equal(queue.list().ready.length, 1);
    now = new Date("2026-10-13T09:00:00Z");
    assert.equal(queue.list().ready.length, 0);
  } finally { done(); }
});

test("the queue survives a restart", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sidemates-queue-restart-"));
  try {
    const first = new OpenBotDatabase(root);
    new WorkQueue(first, () => fakeMac().executor).propose(reminder("mail:70"), { botId: null, runId: null });
    const reopened = new OpenBotDatabase(root);
    assert.equal(new WorkQueue(reopened, () => fakeMac().executor).list().ready.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("flat teammate fields become a valid card and stray fields are not forwarded", () => {
  const flat = proposalFromFlatArgs({ kind: "reply_draft", title: "Reply to Anna", why: "She asked.", sourceKey: "mail:5", to: ["anna@example.com"], subject: "Re: Trip", body: "Yes.", due: "2026-10-09T09:00:00+03:00", send: true });
  const parsed = queueProposalInput.safeParse(flat);
  assert.equal(parsed.success, true, "a stray due or send field is ignored, not rejected");
  assert.deepEqual((flat as { action: object }).action, { to: ["anna@example.com"], subject: "Re: Trip", body: "Yes." });
  const reminderFlat = proposalFromFlatArgs({ kind: "reminder", title: "Pay the bill", why: "Due Friday.", sourceKey: "mail:6", due: "2026-10-09T09:00:00+03:00", list: "" });
  assert.deepEqual((reminderFlat as { action: object }).action, { title: "Pay the bill", due: "2026-10-09T09:00:00+03:00" });
  const nested = { kind: "reminder", title: "x", why: "y", sourceKey: "mail:7", action: { title: "x" } };
  assert.equal(proposalFromFlatArgs(nested), nested);
});

// ---- Earned trust -------------------------------------------------------

const ACME = "Acme Billing <billing@acme.com>";
/** An invoice card from one sender, one per number, so each is its own source. */
const invoice = (n: number, from = ACME) => ({ proposal: { ...fileCard(`mail:${n}`), action: { id: String(n), attachment: `invoice-${n}.pdf`, folder: "Documents/Receipts/2026-10" } }, ctx: { botId: "nova", runId: `run-${n}`, sender: from } });
/** Propose and approve as a person, `count` times. */
async function approveInvoices({ queue }: { queue: WorkQueue }, from: number, count: number, sender = ACME) {
  for (let n = from; n < from + count; n++) {
    const { proposal, ctx } = invoice(n, sender);
    const made = queue.propose(proposal, ctx);
    assert.ok(made.ok);
    if (made.ok) await queue.approve(made.item.id);
  }
}

test("a pattern is the sender's company plus the place, and the month does not split it", () => {
  const parsed = queueProposalInput.parse(fileCard("mail:1"));
  assert.equal(queuePattern(parsed, ACME), "file_attachment|acme.com|Documents/Receipts/YYYY-MM");
  const nextMonth = queueProposalInput.parse({ ...fileCard("mail:2"), action: { id: "2", attachment: "b.pdf", folder: "Documents/Receipts/2026-11/" } });
  assert.equal(queuePattern(nextMonth, "Acme <ar@ACME.com>"), queuePattern(parsed, ACME), "another month, same company: same pattern");
  const elsewhere = queueProposalInput.parse({ ...fileCard("mail:3"), action: { id: "3", attachment: "b.pdf", folder: "Documents/Taxes" } });
  assert.notEqual(queuePattern(elsewhere, ACME), queuePattern(parsed, ACME), "another folder is another pattern");
  assert.equal(senderKey("Anna <anna@gmail.com>"), "anna@gmail.com", "a personal mailbox is the whole address, never 'anyone at gmail.com'");
  assert.equal(queuePattern(queueProposalInput.parse(draftCard("mail:4")), "anna@example.com"), null, "replies can never be automatic");
  assert.equal(queuePattern(parsed, null), null, "no known sender, no pattern");
  assert.match(patternLabel("file_attachment|acme.com|Documents/Receipts/YYYY-MM"), /Files from acme\.com saved to ~\/Documents\/Receipts\/<year>-<month>/);
});

test("five approvals in a row of one pattern make an offer; four do not", async () => {
  const env = trustSetup(); const { queue, done } = env;
  try {
    await approveInvoices(env, 1, QUEUE_OFFER_AFTER - 1);
    assert.deepEqual(queue.offers(), []);
    await approveInvoices(env, 100, 1);
    const offers = queue.offers();
    assert.equal(offers.length, 1);
    assert.equal(offers[0]!.approvals, QUEUE_OFFER_AFTER);
    assert.match(offers[0]!.label, /acme\.com/);
    assert.equal(queue.list().offers.length, 1, "the screen gets the offer with the list");
  } finally { done(); }
});

test("a skip or an Undo breaks the streak, and another sender's cards do not count", async () => {
  const env = trustSetup(); const { queue, done } = env;
  try {
    await approveInvoices(env, 1, 3);
    const skipMe = invoice(50); const skipped = queue.propose(skipMe.proposal, skipMe.ctx);
    assert.ok(skipped.ok); if (skipped.ok) queue.skip(skipped.item.id);
    await approveInvoices(env, 60, 2);
    assert.deepEqual(queue.offers(), [], "3 approvals, a skip, then 2: the streak is 2");
    await approveInvoices(env, 70, 3, "Other <ap@other.org>");
    assert.deepEqual(queue.offers(), [], "another company is a different pattern");
    // an Undo in the middle of a run also resets it
    const undoMe = invoice(80); const made = queue.propose(undoMe.proposal, undoMe.ctx);
    assert.ok(made.ok);
    if (made.ok) { await queue.approve(made.item.id); await queue.undo(made.item.id); }
    await approveInvoices(env, 90, 4);
    assert.deepEqual(queue.offers(), [], "an undone approval counts against the streak");
    await approveInvoices(env, 95, 1);
    assert.equal(queue.offers().length, 1, "five clean approvals after it make the offer");
  } finally { done(); }
});

test("accepting an offer makes a rule; the next matching card runs by itself and can be undone", async () => {
  const env = trustSetup(); const { queue, mac, done } = env;
  try {
    await approveInvoices(env, 1, QUEUE_OFFER_AFTER);
    const offer = queue.offers()[0]!;
    const rule = queue.acceptOffer(offer.pattern);
    assert.equal(rule.status, "active");
    assert.deepEqual(queue.offers(), [], "an answered offer is not offered again");
    mac.calls.length = 0;
    const next = invoice(200); const made = queue.propose(next.proposal, next.ctx);
    assert.ok(made.ok); if (!made.ok) return;
    assert.equal(made.item.status, "ready", "proposing alone still runs nothing");
    assert.deepEqual(mac.calls, []);
    const ran = await queue.runRules(made.item);
    assert.equal(ran.status, "done");
    assert.equal(ran.decidedBy, `rule:${rule.id}`);
    assert.deepEqual(mac.calls, ["saveMailAttachment:invoice-200.pdf"]);
    assert.equal(queue.list().automaticThisWeek, 1);
    assert.equal(queue.rules()[0]!.uses, 1);
    // Undo works on automatic work and switches the rule off
    await queue.undo(ran.id);
    assert.deepEqual(mac.calls.slice(-1), ["trashFile:/Users/test/Documents/Receipts/2026-10/invoice-200.pdf"]);
    const paused = queue.rules()[0]!;
    assert.equal(paused.status, "paused");
    assert.match(paused.pausedReason ?? "", /undid/);
    // a paused rule runs nothing: the next card waits for a person again
    const after = invoice(201); const waiting = queue.propose(after.proposal, after.ctx);
    assert.ok(waiting.ok); if (!waiting.ok) return;
    assert.equal((await queue.runRules(waiting.item)).status, "ready");
    // turning it back on is the person's call
    queue.resumeRule(rule.id);
    assert.equal((await queue.runRules(waiting.item)).status, "done");
  } finally { done(); }
});

test("a rule never covers a different sender, folder, or kind, and replies are never automatic", async () => {
  const env = trustSetup(); const { queue, done } = env;
  try {
    await approveInvoices(env, 1, QUEUE_OFFER_AFTER);
    queue.acceptOffer(queue.offers()[0]!.pattern);
    const other = invoice(300, "Other <ap@other.org>"); const otherCard = queue.propose(other.proposal, other.ctx);
    assert.ok(otherCard.ok); if (otherCard.ok) assert.equal((await queue.runRules(otherCard.item)).status, "ready", "another sender still needs a person");
    const elsewhere = queue.propose({ ...fileCard("mail:301"), action: { id: "301", attachment: "x.pdf", folder: "Documents/Taxes" } }, { botId: null, runId: null, sender: ACME });
    assert.ok(elsewhere.ok); if (elsewhere.ok) assert.equal((await queue.runRules(elsewhere.item)).status, "ready", "another folder still needs a person");
    const aReminder = queue.propose(reminder("mail:302"), { botId: null, runId: null, sender: ACME });
    assert.ok(aReminder.ok); if (aReminder.ok) assert.equal((await queue.runRules(aReminder.item)).status, "ready", "another kind still needs a person");
    const reply = queue.propose(draftCard("mail:303"), { botId: null, runId: null, sender: "anna@example.com" });
    assert.ok(reply.ok); if (reply.ok) { assert.equal(reply.item.pattern, null); assert.equal((await queue.runRules(reply.item)).status, "ready"); }
  } finally { done(); }
});

test("'Not now' and removing a rule are remembered, so the same offer does not nag", async () => {
  const env = trustSetup(); const { queue, done } = env;
  try {
    await approveInvoices(env, 1, QUEUE_OFFER_AFTER);
    const pattern = queue.offers()[0]!.pattern;
    queue.declineOffer(pattern);
    assert.deepEqual(queue.offers(), []);
    assert.deepEqual(queue.rules(), [], "a declined offer is not a rule");
    await approveInvoices(env, 40, QUEUE_OFFER_AFTER);
    assert.deepEqual(queue.offers(), [], "more approvals do not bring it back");
    assert.throws(() => queue.acceptOffer(pattern), (error) => error instanceof QueueError && error.code === "already_handled");

    const second = trustSetup();
    try {
      await approveInvoices(second, 1, QUEUE_OFFER_AFTER);
      const rule = second.queue.acceptOffer(second.queue.offers()[0]!.pattern);
      second.queue.removeRule(rule.id);
      assert.deepEqual(second.queue.rules(), []);
      assert.deepEqual(second.queue.offers(), [], "a removed rule does not come straight back as an offer");
      assert.throws(() => second.queue.removeRule(rule.id), (error) => error instanceof QueueError && error.code === "not_found");
    } finally { second.done(); }
  } finally { done(); }
});

test("an offer can only be accepted for a pattern that is being offered", () => {
  const { queue, done } = trustSetup();
  try {
    assert.throws(() => queue.acceptOffer("file_attachment|made-up.com|anywhere"), (error) => error instanceof QueueError && error.code === "not_found");
    assert.throws(() => queue.declineOffer("file_attachment|made-up.com|anywhere"), (error) => error instanceof QueueError && error.code === "not_found");
    assert.throws(() => queue.pauseRule("qr-missing"), (error) => error instanceof QueueError && error.code === "not_found");
  } finally { done(); }
});

test("when a rule's action fails, the card says so, the rule pauses, and nothing is hidden", async () => {
  const env = trustSetup(); const { queue, mac, done } = env;
  try {
    await approveInvoices(env, 1, QUEUE_OFFER_AFTER);
    const rule = queue.acceptOffer(queue.offers()[0]!.pattern);
    mac.state.failOn = "saveMailAttachment";
    const { proposal, ctx } = invoice(500);
    const made = queue.propose(proposal, ctx);
    assert.ok(made.ok); if (!made.ok) return;
    const result = await queue.runRules(made.item);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /Nothing was changed/);
    const after = queue.rules().find((entry) => entry.id === rule.id)!;
    assert.equal(after.status, "paused");
    assert.match(after.pausedReason ?? "", /couldn't finish/);
    assert.equal(after.uses, 0, "a failure is not counted as work done");
  } finally { done(); }
});

test("doing things alone has a daily limit, and trusted cards do not use up the day's eight", async () => {
  const env = setup(); const { queue, done } = env;
  try {
    await approveInvoices(env, 1, QUEUE_OFFER_AFTER);
    queue.acceptOffer(queue.offers()[0]!.pattern);
    let alone = 0, waiting = 0;
    for (let n = 1000; n < 1000 + QUEUE_AUTO_PER_DAY + 3; n++) {
      const { proposal, ctx } = invoice(n);
      const made = queue.propose(proposal, ctx);
      assert.ok(made.ok, "a trusted pattern is not stopped by the day's eight cards");
      if (!made.ok) return;
      if ((await queue.runRules(made.item)).status === "done") alone++; else waiting++;
    }
    assert.equal(alone, QUEUE_AUTO_PER_DAY, "exactly the daily limit happens on its own");
    assert.equal(waiting, 3, "the rest wait for a person like any other card");
    assert.equal(queue.list().ready.length, 3);
  } finally { done(); }
});

// ---- Receipts for the accountant ---------------------------------------

test("flat teammate fields carry receipt details, but only for a filed file", () => {
  const card = proposalFromFlatArgs({ kind: "file_attachment", title: "File it", why: "Acme invoice", sourceKey: "mail:1", id: "1", attachment: "a.pdf", folder: "Documents/Receipts/2026-10", vendor: "Acme", amount: "84.20", currency: "EUR", invoiceDate: "2026-10-01", reference: "1042", notes: "ignored" });
  assert.deepEqual((card as { receipt: unknown }).receipt, { vendor: "Acme", amount: "84.20", currency: "EUR", invoiceDate: "2026-10-01", reference: "1042" });
  assert.equal(queueProposalInput.safeParse(card).success, true);
  const reminderCard = proposalFromFlatArgs({ kind: "reminder", title: "x", why: "y", sourceKey: "mail:2", vendor: "Acme", amount: "1" });
  assert.equal("receipt" in reminderCard, false);
});

test("the accountant's list holds only approved files, with what the email said, and sums per currency", async () => {
  const env = trustSetup(); const { queue, done } = env;
  try {
    const file = (n: number, receipt: Record<string, string> | undefined, sender = ACME) => ({ proposal: { ...fileCard(`mail:${n}`), action: { id: String(n), attachment: `invoice-${n}.pdf`, folder: "Documents/Receipts/2026-10" }, ...(receipt ? { receipt } : {}) }, ctx: { botId: "nova", runId: `run-${n}`, sender } });
    const approve = async (n: number, receipt?: Record<string, string>, sender = ACME) => { const c = file(n, receipt, sender); const made = queue.propose(c.proposal, c.ctx); assert.ok(made.ok); if (made.ok) return queue.approve(made.item.id); throw new Error("not added"); };
    await approve(1, { vendor: "Acme", amount: "84.20", currency: "EUR", invoiceDate: "2026-10-01", reference: "INV-1042" });
    await approve(2, { vendor: "Acme", amount: "1240,50", currency: "EUR" });
    await approve(3, { vendor: "Globex", amount: "10.00", currency: "USD" }, "Globex <ar@globex.example>");
    await approve(4, undefined, "Pixel Print <hello@pixelprint.example>");
    const skipped = file(5, { vendor: "Skipped", amount: "999.00", currency: "EUR" }); const waiting = queue.propose(skipped.proposal, skipped.ctx);
    assert.ok(waiting.ok); if (waiting.ok) queue.skip(waiting.item.id);
    const undone = await approve(6, { vendor: "Undone", amount: "555.00", currency: "EUR" }); await queue.undo(undone.id);
    const pending = file(7, { vendor: "Pending", amount: "777.00", currency: "EUR" }); assert.ok(queue.propose(pending.proposal, pending.ctx).ok);

    const summary = queue.receipts();
    assert.equal(summary.rows.length, 4, "approved files only: not skipped, undone or still waiting");
    assert.deepEqual(summary.rows.map((row) => row.vendor), ["Acme", "Acme", "Globex", "pixelprint.example"], "a missing vendor falls back to the sender's company");
    assert.deepEqual(summary.totals, [{ currency: "EUR", amount: "1324.70", count: 2 }, { currency: "USD", amount: "10.00", count: 1 }], "sums per currency, in whole cents");
    assert.equal(summary.withoutAmount, 1);
    assert.equal(summary.rows[1]!.amount, "1240.50", "1240,50 is written plainly");
    assert.match(summary.rows[0]!.savedTo, /^~\/Documents\/Receipts\/2026-10\/invoice-1\.pdf$/);
    assert.deepEqual(summary.months, [summary.month]);
    assert.equal(queue.receipts("2001-02").rows.length, 0, "another month is empty");
    assert.equal(queue.receipts("not-a-month").month, summary.month, "a bad month falls back instead of failing");

    const { csv } = queue.receiptsCsv(summary.month);
    assert.ok(csv.startsWith("\uFEFFDate filed,Vendor,Invoice date,Reference,Amount,Currency,File,Saved to\r\n"));
    assert.match(csv, /Acme,2026-10-01,INV-1042,84\.20,EUR,invoice-1\.pdf,~\/Documents\/Receipts\/2026-10\/invoice-1\.pdf/);
    assert.equal(csv.trim().split("\r\n").length, 5, "a header and four rows");
  } finally { done(); }
});

test("a vendor that looks like a spreadsheet formula, or holds a comma or quote, is made safe in the file", async () => {
  const env = trustSetup(); const { queue, done } = env;
  try {
    const c = { kind: "file_attachment", title: "File it", why: "An invoice.", sourceKey: "mail:9", action: { id: "9", attachment: "a.pdf", folder: "Documents/Receipts/2026-10" }, receipt: { vendor: '=HYPERLINK("http://evil.example","x"), Inc', reference: "+1-555" } };
    const made = queue.propose(c, { botId: null, runId: null, sender: ACME });
    assert.ok(made.ok); if (!made.ok) return;
    await queue.approve(made.item.id);
    const { csv } = queue.receiptsCsv();
    assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil\.example"",""x""\), Inc"/, "a leading = becomes text, quotes are doubled");
    assert.match(csv, /,'\+1-555,/, "a leading + becomes text");
  } finally { done(); }
});

test("sample Mac mode answers every kind of card and undoes it without touching any file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sidemates-demo-mac-"));
  const home = path.join(root, "home");
  const db = new OpenBotDatabase(root);
  try {
    const sample = demoQueueExecutor(home);
    const queue = new WorkQueue(db, () => sample, undefined, { cardsPerDay: 100 });
    const cards = [reminder("mail:1"), eventCard("mail:2"), draftCard("mail:3"), fileCard("mail:4")];
    for (const card of cards) {
      const made = queue.propose(card, { botId: null, runId: null });
      assert.ok(made.ok); if (!made.ok) return;
      const done = await queue.approve(made.item.id);
      assert.equal(done.status, "done");
      assert.ok(done.result);
      await queue.undo(done.id);
    }
    assert.equal(db.queueItemsList(["undone"]).length, 4);
    assert.equal(existsSync(home), false, "sample mode never creates a folder or a file");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
