import { mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** A throwaway studio filled with SAMPLE data, running in sample Mac mode (SIDEMATES_DEMO_MAC=sample): the real queue,
 * checks and trust rules, but approving touches no reminder, event, draft or file. Used by the demo recorder, the film's
 * screenshot capture and anything else that needs the real screen without anything real on it.
 *   const { studio, stop } = await startSampleStudio({ root, work, dist }) */
export async function startSampleStudio({ root, work, dist }) {
// A studio of our own, filled with sample data the way a real morning would look.
const { OpenBotDatabase } = await import("../../src/server/database.ts");
const { WorkQueue } = await import("../../src/server/queue.ts");
const { demoQueueExecutor } = await import("../../src/server/demo-mac.ts");
const studioRoot = path.join(work, "studio");
mkdirSync(studioRoot, { recursive: true });
const db = new OpenBotDatabase(studioRoot, { dataDir: path.join(studioRoot, "data"), seedStarterBots: true });
const queue = new WorkQueue(db, () => demoQueueExecutor("/Users/sample"), undefined, { cardsPerDay: 100 });
const ACME = "Acme Billing <billing@acme.com>";
const invoice = (n, amount, day) => ({ kind: "file_attachment", title: `File Acme invoice ${1040 + n}`, why: "Acme sent an invoice PDF.", sourceKey: `mail:${2000 + n}:inv.pdf`,
  action: { id: String(2000 + n), attachment: `invoice-${1040 + n}.pdf`, folder: "Documents/Receipts/2026-10" },
  receipt: { vendor: "Acme", amount, currency: "EUR", invoiceDate: `2026-10-0${day}`, reference: `INV-${1040 + n}` } });
const sample = (card, sender) => { const made = queue.propose(card, { botId: null, runId: null, sender }); if (!made.ok) throw new Error(made.message); return made.item; };
// Four invoices from Acme that the person already approved, so the fifth earns the offer to do it automatically.
[["92.50", 1], ["105.00", 2], ["117.50", 3], ["130.00", 4]].forEach(([amount, day], index) => {
  const item = sample(invoice(index + 1, amount, day), ACME);
  db.queueItemTransition(item.id, ["ready"], { status: "done", decidedBy: "person", result: { saved: `/Users/sample/Documents/Receipts/2026-10/invoice-${1041 + index}.pdf`, bytes: 52_000 } });
});
// What is waiting this morning, in the order it is shown.
sample({ kind: "reply_draft", title: "Reply to Anna about Friday", why: "Anna asked on Tuesday if Friday works, and nobody has answered yet.", sourceKey: "mail:1001",
  action: { to: ["anna.berg@example.com"], subject: "Re: Berlin trip, Friday?", body: "Hi Anna,\n\nFriday works for me. I can be at the station by 6 pm.\n\nSpeak soon!" } }, "Anna Berg <anna.berg@example.com>");
sample({ ...invoice(5, "125.00", 5), title: "File Acme invoice 1045", why: "Acme sent invoice 1045 as a PDF. Your receipts folder is where invoices go." }, ACME);
sample({ kind: "reminder", title: "Pay the gas bill", why: "Your provider's email says it is due this Friday.", sourceKey: "mail:1003", action: { title: "Pay the gas bill", due: "2026-10-09T09:00:00+03:00" } }, "Gas Co <bills@gasco.example>");
sample({ kind: "calendar_event", title: "School concert", why: "The school invited families to the autumn concert.", sourceKey: "mail:1004",
  action: { title: "School concert", start: "2026-10-14T18:00:00+03:00", end: "2026-10-14T19:30:00+03:00", location: "Primary School hall" } }, "Oak Primary <office@oakprimary.example>");
const dataDir = db.dataDir;
db.close();

const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const studio = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], { cwd: root, stdio: "ignore", env: {
  PATH: process.env.PATH, HOME: process.env.HOME, LANG: "en_US.UTF-8", OPENBOT_LOAD_ENV: "0", OPENBOT_DATA_DIR: dataDir, OPENBOT_PORT: String(port), OPENBOT_HOST: "127.0.0.1",
  OPENBOT_APP_URL: studio, OPENBOT_DEPLOYMENT_MODE: "local", OPENBOT_DIST_DIR: dist, SIDEMATES_DEMO_MAC: "sample", NODE_ENV: "test" } });
const stop = () => { child.kill("SIGTERM"); };
process.on("exit", stop);
let ready = false;
for (let n = 0; n < 900 && !ready; n++) { try { ready = (await fetch(`${studio}/api/healthz`)).ok; } catch { await delay(150); } }
if (!ready) { stop(); throw new Error("The sample studio did not start."); }
return { studio, stop };
}
