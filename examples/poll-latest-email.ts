import type { MessageDetail } from "../src/messages";

const changed =
  "Mailbox changed; restart polling before requesting another OTP.";
const timedOut = "Timed out waiting for email.";

function fail(message: string, status = 1): never {
  console.error(message);
  process.exit(status);
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--new-only"))
  fail("Usage: bun examples/poll-latest-email.ts [--new-only]");
const base = process.env.MAIL_API_BASE_URL;
const token = process.env.ADMIN_API_TOKEN;
const mailbox = process.env.MAILBOX;
if (!base || !token || !mailbox)
  fail("MAIL_API_BASE_URL, ADMIN_API_TOKEN, and MAILBOX are required.");
let url: URL;
try {
  const origin = new URL(base);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error();
  url = new URL(
    `${origin.href.replace(/\/$/, "")}/v1/accounts/${encodeURIComponent(mailbox)}/messages/latest`,
  );
} catch {
  fail(
    "MAIL_API_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment.",
  );
}
url.search = new URLSearchParams({
  folder: process.env.MAIL_FOLDER || "INBOX",
}).toString();
function timer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (
    !/^[0-9]+$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) <= 0
  )
    fail(`${name} must be a positive integer.`);
  return Number(raw);
}
const interval = timer("POLL_INTERVAL_MS", 2000);
const deadline = Date.now() + timer("POLL_TIMEOUT_MS", 120000);
const newOnly = args.length === 1;
let baselineCaptured = false;
let baseline: Pick<MessageDetail, "folder" | "uidValidity" | "uid"> | null =
  null;

while (true) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) fail(timedOut, 2);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(remaining),
    });
  } catch {
    if (Date.now() >= deadline) fail(timedOut, 2);
    fail("Mail API request failed.");
  }
  if (response.status === 200) {
    let message: MessageDetail;
    try {
      message = (await response.json()) as MessageDetail;
    } catch {
      if (Date.now() >= deadline) fail(timedOut, 2);
      fail("Mail API returned invalid JSON.");
    }
    if (Date.now() >= deadline) fail(timedOut, 2);
    if (
      !newOnly ||
      (baselineCaptured &&
        (!baseline ||
          (message.folder === baseline.folder &&
            message.uidValidity === baseline.uidValidity &&
            message.uid > baseline.uid)))
    ) {
      console.log(JSON.stringify(message));
      process.exit(0);
    }
    if (
      baseline &&
      (message.uidValidity !== baseline.uidValidity ||
        message.folder !== baseline.folder)
    )
      fail(changed);
    if (!baselineCaptured) {
      baseline = {
        folder: message.folder,
        uidValidity: message.uidValidity,
        uid: message.uid,
      };
      baselineCaptured = true;
      console.error("Ready: waiting for new mail.");
    }
  } else if (response.status === 204) {
    if (newOnly && !baselineCaptured) {
      baselineCaptured = true;
      console.error("Ready: waiting for new mail.");
    }
  } else if (response.status === 409) {
    let code: string | undefined;
    try {
      code = ((await response.json()) as { error?: { code?: string } }).error
        ?.code;
    } catch {
      /* no error payload */
    }
    if (code === "STALE_MAILBOX") fail(changed);
    fail("Mail API returned HTTP 409.");
  } else if (response.status !== 404 && response.status !== 503) {
    fail(`Mail API returned HTTP ${response.status}.`);
  }
  const wait = deadline - Date.now();
  if (wait <= 0) fail(timedOut, 2);
  await Bun.sleep(Math.min(interval, wait));
}
