import { AccountService, KeyedMutex, Mutex } from "./accounts";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { DmsRunner } from "./dms";
import { DefaultMailService } from "./mail";

async function main(): Promise<void> {
  const config = loadConfig();

  const dms = new DmsRunner({ container: config.dmsContainer });
  try {
    await dms.preflightCheck();
  } catch (err) {
    console.error("DMS preflight check failed:", err);
    process.exit(1);
  }

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

  app.listen({
    hostname: config.tailscaleIp,
    port: config.port,
    maxRequestBodySize: 16 * 1024 * 1024,
  });

  console.log(
    `Server listening on http://${config.tailscaleIp}:${config.port}`,
  );

  const shutdown = async () => {
    console.log("Shutting down gracefully...");
    await app.stop();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}
