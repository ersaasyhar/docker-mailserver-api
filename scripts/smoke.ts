import fs from "node:fs";
import path from "node:path";
import type { Elysia } from "elysia";
import { AccountService, KeyedMutex, Mutex } from "../src/accounts";
import { createApp } from "../src/app";
import type { Config } from "../src/config";
import { DmsRunner } from "../src/dms";
import { DefaultMailService } from "../src/mail";

const ROOT_DIR = path.resolve(import.meta.dir, "..");
const FIXTURES_DIR = path.join(ROOT_DIR, "test", "fixtures");
const CERTS_DIR = path.join(FIXTURES_DIR, "certs");
const CONFIG_DIR = path.join(FIXTURES_DIR, "config");
const DATA_DIR = path.join(FIXTURES_DIR, "data");
const STATE_DIR = path.join(FIXTURES_DIR, "state");
const COMPOSE_FILE = path.join(FIXTURES_DIR, "mailserver.compose.yml");
const PROJECT_NAME = "mail-api-smoke";
const CONTAINER_NAME = "mail-api-smoke-dms";

const TEST_ADMIN_TOKEN = "smoke-test-admin-token-at-least-32-bytes-long";
const MASTER_PASSWORD = "smoke-dovecot-master-password-123";
const ADMIN_PASSWORD = "admin-test-password-123";

function runCmd(cmd: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const res = Bun.spawnSync(cmd, { cwd: ROOT_DIR });
  return {
    stdout: res.stdout ? res.stdout.toString() : "",
    stderr: res.stderr ? res.stderr.toString() : "",
    exitCode: res.exitCode,
  };
}

async function runCmdStdin(cmd: string[], stdinData: string): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: ROOT_DIR,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.stdin && typeof proc.stdin !== "number") {
    proc.stdin.write(new TextEncoder().encode(stdinData));
    proc.stdin.flush();
    proc.stdin.end();
  }

  await proc.exited;
}

function checkDocker(): boolean {
  const res = runCmd(["docker", "info"]);
  return res.exitCode === 0;
}

function ensureDirectories(): void {
  for (const dir of [CERTS_DIR, CONFIG_DIR, DATA_DIR, STATE_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function generateCertificates(): void {
  const caKey = path.join(CERTS_DIR, "ca.key");
  const caPem = path.join(CERTS_DIR, "ca.pem");
  const serverKey = path.join(CERTS_DIR, "key.pem");
  const serverCsr = path.join(CERTS_DIR, "server.csr");
  const serverPem = path.join(CERTS_DIR, "cert.pem");
  const extFile = path.join(CERTS_DIR, "openssl.ext");

  if (fs.existsSync(serverPem) && fs.existsSync(caPem)) {
    return;
  }

  console.log("Generating test certificates...");
  runCmd([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-days",
    "7",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    caPem,
    "-subj",
    "/CN=Smoke Test CA",
  ]);

  runCmd([
    "openssl",
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    serverKey,
    "-out",
    serverCsr,
    "-subj",
    "/CN=mail.mail.test",
  ]);

  fs.writeFileSync(
    extFile,
    "subjectAltName=DNS:mail.mail.test,DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n",
  );

  runCmd([
    "openssl",
    "x509",
    "-req",
    "-in",
    serverCsr,
    "-CA",
    caPem,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    serverPem,
    "-days",
    "7",
    "-extfile",
    extFile,
  ]);
}

function writePostfixConfigs(): void {
  const pcreFile = path.join(CONFIG_DIR, "postfix-admin-senders.pcre");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: PCRE syntax uses ${1} backreference
  const pcreContent = "/^([^@]+@mail\\.test)$/ ${1}, admin@mail.test\n";
  fs.writeFileSync(pcreFile, pcreContent);

  const mainCf = path.join(CONFIG_DIR, "postfix-main.cf");
  const mainCfContent =
    "smtpd_sender_login_maps = unionmap:{ pcre:/tmp/docker-mailserver/postfix-admin-senders.pcre, texthash:/etc/postfix/virtual, hash:/etc/aliases, pcre:/etc/postfix/maps/sender_login_maps.pcre }\n";
  fs.writeFileSync(mainCf, mainCfContent);
}

async function waitForRunning(maxSeconds = 30): Promise<void> {
  console.log("Waiting for container to start running...");
  for (let i = 0; i < maxSeconds; i++) {
    const res = runCmd([
      "docker",
      "inspect",
      "--format={{.State.Running}}",
      CONTAINER_NAME,
    ]);
    if (res.stdout.trim() === "true") {
      console.log("Container is running!");
      return;
    }
    await Bun.sleep(1000);
  }
  throw new Error("Timed out waiting for container to enter running state.");
}

async function waitForHealth(maxSeconds = 180): Promise<void> {
  console.log("Waiting for Docker Mailserver container readiness...");
  for (let i = 0; i < maxSeconds; i++) {
    const res = runCmd([
      "docker",
      "inspect",
      "--format={{.State.Health.Status}}",
      CONTAINER_NAME,
    ]);
    const status = res.stdout.trim();
    if (status === "healthy") {
      console.log("Container is healthy!");
      return;
    }
    if (i % 15 === 0) {
      console.log(
        `Still waiting for health (current status: "${status}")... [${i}s]`,
      );
    }
    await Bun.sleep(1000);
  }
  const logs = runCmd(["docker", "logs", "--tail", "100", CONTAINER_NAME]);
  console.error("DMS container logs:\n", logs.stdout, logs.stderr);
  throw new Error(
    "Timed out waiting for mailserver container to become healthy.",
  );
}

async function preseedAccounts(): Promise<void> {
  console.log("Preseeding accounts and master user in DMS fixture...");
  // Wait briefly for setup command availability
  for (let attempt = 0; attempt < 10; attempt++) {
    const check = runCmd(["docker", "exec", CONTAINER_NAME, "which", "setup"]);
    if (check.exitCode === 0) break;
    await Bun.sleep(1000);
  }
  // Master user
  await runCmdStdin(
    [
      "docker",
      "exec",
      "-i",
      CONTAINER_NAME,
      "setup",
      "dovecot-master",
      "add",
      "mail-api",
    ],
    `${MASTER_PASSWORD}\n${MASTER_PASSWORD}\n`,
  );

  // Admin user
  await runCmdStdin(
    [
      "docker",
      "exec",
      "-i",
      CONTAINER_NAME,
      "setup",
      "email",
      "add",
      "admin@mail.test",
    ],
    `${ADMIN_PASSWORD}\n${ADMIN_PASSWORD}\n`,
  );

  // User a
  await runCmdStdin(
    [
      "docker",
      "exec",
      "-i",
      CONTAINER_NAME,
      "setup",
      "email",
      "add",
      "a@mail.test",
    ],
    "a-secret-password-123\na-secret-password-123\n",
  );

  // User b
  await runCmdStdin(
    [
      "docker",
      "exec",
      "-i",
      CONTAINER_NAME,
      "setup",
      "email",
      "add",
      "b@mail.test",
    ],
    "b-secret-password-123\nb-secret-password-123\n",
  );
}

function getMappedPort(containerPort: string): number {
  const res = runCmd([
    "docker",
    "compose",
    "-f",
    COMPOSE_FILE,
    "-p",
    PROJECT_NAME,
    "port",
    "dms",
    containerPort,
  ]);
  const out = res.stdout.trim();
  const match = out.match(/:(\d+)$/);
  if (!match) {
    throw new Error(
      `Failed to determine mapped port for ${containerPort}: ${out}`,
    );
  }
  return Number.parseInt(match[1], 10);
}

async function main(): Promise<void> {
  if (!checkDocker()) {
    if (process.env.GITHUB_ACTIONS === "true") {
      console.error(
        "Docker daemon is required in GitHub Actions CI but is not running!",
      );
      process.exit(1);
    }
    console.log(
      "Notice: Docker daemon is not running on this host.\n" +
        "Skipping local containerized integration test.\n" +
        "End-to-end container integration will run on GitHub Actions Ubuntu CI runner.",
    );
    process.exit(0);
  }

  ensureDirectories();
  generateCertificates();
  writePostfixConfigs();

  console.log("Starting Docker Mailserver container fixture...");
  runCmd([
    "docker",
    "compose",
    "-f",
    COMPOSE_FILE,
    "-p",
    PROJECT_NAME,
    "up",
    "-d",
  ]);

  let serverStopped = false;
  let appServer: Elysia | undefined;

  const cleanup = async () => {
    if (appServer && !serverStopped) {
      serverStopped = true;
      await appServer.stop();
    }
    console.log("Tearing down Docker Mailserver fixture...");
    runCmd([
      "docker",
      "compose",
      "-f",
      COMPOSE_FILE,
      "-p",
      PROJECT_NAME,
      "down",
      "-v",
    ]);
  };

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(1);
  });

  try {
    await waitForRunning();
    await preseedAccounts();
    await waitForHealth();

    const imapPort = getMappedPort("993");
    const smtpPort = getMappedPort("587");
    console.log(`Mapped IMAPS port: ${imapPort}, SMTP port: ${smtpPort}`);

    const config: Config = {
      tailscaleIp: "127.0.0.1",
      port: 0,
      adminApiToken: TEST_ADMIN_TOKEN,
      mailDomains: ["mail.test"],
      dmsContainer: CONTAINER_NAME,
      imapHost: "127.0.0.1",
      imapPort,
      imapMasterUser: "mail-api",
      imapMasterPassword: MASTER_PASSWORD,
      smtpHost: "127.0.0.1",
      smtpPort,
      smtpUser: "admin@mail.test",
      smtpPassword: ADMIN_PASSWORD,
      mailTlsServername: "mail.mail.test",
      mailTlsCaFile: path.join(CERTS_DIR, "ca.pem"),
      corsOrigins: [],
    };

    const dms = new DmsRunner({ container: CONTAINER_NAME });
    await dms.preflightCheck();

    const accountLock = new Mutex();
    const accountKeyedLock = new KeyedMutex();

    const accounts = new AccountService({
      dms,
      mailDomains: config.mailDomains,
      smtpUser: config.smtpUser,
      accountLock,
      accountKeyedLock,
    });

    const mail = new DefaultMailService({
      config,
      accountKeyedLock,
    });

    const app = createApp(config, { accounts, mail });
    appServer = app.listen({ hostname: "127.0.0.1", port: 0 });
    const localPort = appServer.server?.port ?? 3000;
    const baseUrl = `http://127.0.0.1:${localPort}`;
    console.log(`Local test app listening at ${baseUrl}`);

    const authHeaders = {
      Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    };

    // 1. Health check
    console.log("Step 1: Check /health");
    const healthRes = await fetch(`${baseUrl}/health`, {
      headers: authHeaders,
    });
    if (healthRes.status !== 200)
      throw new Error(`Health check failed: ${healthRes.status}`);

    // 2. List accounts
    console.log("Step 2: List accounts");
    const listRes = await fetch(`${baseUrl}/v1/accounts`, {
      headers: authHeaders,
    });
    const listData = (await listRes.json()) as {
      items: Array<{ email: string }>;
    };
    const emails = listData.items.map((i) => i.email);
    console.log("Accounts found:", emails);
    if (
      !emails.includes("admin@mail.test") ||
      !emails.includes("b@mail.test")
    ) {
      throw new Error("Missing preseeded accounts");
    }

    // 3. Create profile test1@mail.test
    console.log("Step 3: Create profile test1@mail.test");
    const createRes = await fetch(`${baseUrl}/v1/accounts`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        email: "test1@mail.test",
        password: "test1-password-123",
      }),
    });
    if (createRes.status !== 201)
      throw new Error(`Create account failed: ${createRes.status}`);

    // 4. Send message from admin@mail.test to b@mail.test
    console.log("Step 4: Send message to b@mail.test");
    const sendRes = await fetch(
      `${baseUrl}/v1/accounts/admin%40mail.test/messages/send`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          to: ["b@mail.test"],
          subject: "Smoke Test Subject",
          text: "Hello from smoke test!",
          html: "<p>Hello from <b>smoke test</b>!</p>",
          attachments: [
            {
              filename: "smoke.txt",
              contentType: "text/plain",
              contentBase64:
                Buffer.from("smoke file content").toString("base64"),
            },
          ],
        }),
      },
    );
    if (sendRes.status !== 200) {
      const errText = await sendRes.text();
      throw new Error(`Send message failed: ${sendRes.status} ${errText}`);
    }
    console.log("Message accepted by SMTP!");

    // Wait for delivery to b@mail.test
    console.log("Step 5: Waiting for delivery in b@mail.test INBOX...");
    let bMessages: Array<{ uid: number; subject: string | null }> = [];
    let bUidValidity = "";
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(1000);
      const bListRes = await fetch(
        `${baseUrl}/v1/accounts/b%40mail.test/messages?folder=INBOX`,
        {
          headers: authHeaders,
        },
      );
      if (bListRes.status === 200) {
        const data = (await bListRes.json()) as {
          items: Array<{ uid: number; subject: string | null }>;
          uidValidity: string;
        };
        bUidValidity = data.uidValidity;
        if (data.items.length > 0) {
          bMessages = data.items;
          break;
        }
      }
    }

    if (bMessages.length === 0) {
      throw new Error(
        "Message not received in b@mail.test INBOX within 30 seconds.",
      );
    }
    console.log(
      `Received message in b@mail.test INBOX (UID: ${bMessages[0].uid})`,
    );

    // 6. Fetch message and attachment
    console.log("Step 6: Fetch message detail and attachment");
    const targetUid = bMessages[0].uid;
    const msgDetailRes = await fetch(
      `${baseUrl}/v1/accounts/b%40mail.test/messages/${targetUid}?uidValidity=${bUidValidity}`,
      { headers: authHeaders },
    );
    if (msgDetailRes.status !== 200)
      throw new Error("Failed to fetch message detail");
    const detail = (await msgDetailRes.json()) as {
      text: string;
      attachments: Array<{ filename: string }>;
    };
    if (!detail.text.includes("Hello from smoke test!")) {
      throw new Error("Message text mismatch");
    }

    const attRes = await fetch(
      `${baseUrl}/v1/accounts/b%40mail.test/messages/${targetUid}/attachments/0?uidValidity=${bUidValidity}`,
      { headers: authHeaders },
    );
    if (attRes.status !== 200) throw new Error("Failed to fetch attachment");
    const attBuf = Buffer.from(await attRes.arrayBuffer());
    if (attBuf.toString("utf8") !== "smoke file content") {
      throw new Error("Attachment content mismatch");
    }
    console.log("Byte-exact attachment verified!");

    // 7. Flag update: mark seen
    console.log("Step 7: Flag update");
    const flagRes = await fetch(
      `${baseUrl}/v1/accounts/b%40mail.test/messages/${targetUid}?uidValidity=${bUidValidity}`,
      {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({ seen: true }),
      },
    );
    if (flagRes.status !== 200) throw new Error("Failed to update flags");

    // 8. Move message to Archive then Trash
    console.log("Step 8: Move message to Archive");
    const moveRes = await fetch(
      `${baseUrl}/v1/accounts/b%40mail.test/messages/${targetUid}/move?uidValidity=${bUidValidity}`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ destination: "archive" }),
      },
    );
    if (moveRes.status !== 200)
      throw new Error("Failed to move message to Archive");

    // 9. Delete test1@mail.test
    console.log("Step 9: Delete account test1@mail.test");
    const delRes = await fetch(`${baseUrl}/v1/accounts/test1%40mail.test`, {
      method: "DELETE",
      headers: authHeaders,
      body: JSON.stringify({ confirmEmail: "test1@mail.test", purge: true }),
    });
    if (delRes.status !== 204) throw new Error("Failed to delete account");

    console.log("\n=== ALL SMOKE TEST SCENARIOS PASSED SUCCESSFULLY ===");
  } finally {
    await cleanup();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Smoke test failed:", err);
    process.exit(1);
  });
}
