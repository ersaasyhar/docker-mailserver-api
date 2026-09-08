import fs from "node:fs";
import os from "node:os";

export interface Config {
  tailscaleIp: string;
  port: number;
  adminApiToken: string;
  mailDomains: string[];
  dmsContainer: string;
  imapHost: string;
  imapPort: number;
  imapMasterUser: string;
  imapMasterPassword: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  mailTlsServername: string;
  mailTlsCaFile?: string;
  corsOrigins: string[];
}

export interface LoadConfigOptions {
  checkInterfaces?: boolean;
}

const DOMAIN_REGEX =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CONTAINER_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function validatePort(
  val: string | undefined,
  defaultPort: number,
  name: string,
): number {
  if (!val || val.trim() === "") {
    return defaultPort;
  }
  const parsed = Number.parseInt(val, 10);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > 65535 ||
    String(parsed) !== val.trim()
  ) {
    throw new Error(
      `Invalid ${name}: "${val}". Must be an integer between 1 and 65535.`,
    );
  }
  return parsed;
}

function isValidTailscaleIp(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((p) => {
    if (!/^\d+$/.test(p)) return -1;
    return Number.parseInt(p, 10);
  });
  const [a, b, c, d] = octets;
  if (a !== 100) return false;
  if (b < 64 || b > 127) return false;
  if (c < 0 || c > 255) return false;
  if (d < 0 || d > 255) return false;
  return true;
}

function isIpOnLocalInterface(ip: string): boolean {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const list = interfaces[name];
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === "IPv4" && iface.address === ip) {
        return true;
      }
    }
  }
  return false;
}

export function validateCorsOrigin(origin: string): string {
  const trimmed = origin.trim();
  if (trimmed === "" || trimmed === "null" || trimmed === "*") {
    throw new Error(
      `Invalid CORS origin "${origin}". Wildcards, null origins, and empty strings are rejected.`,
    );
  }
  if (trimmed.includes("*")) {
    throw new Error(
      `Invalid CORS origin "${origin}". Wildcard patterns are rejected.`,
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid CORS origin "${origin}". Must be a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Invalid CORS origin "${origin}". Protocol must be http: or https:.`,
    );
  }
  if (url.username || url.password) {
    throw new Error(
      `Invalid CORS origin "${origin}". Userinfo is not allowed.`,
    );
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new Error(
      `Invalid CORS origin "${origin}". Path-bearing origins are rejected.`,
    );
  }
  if (url.search || url.hash) {
    throw new Error(
      `Invalid CORS origin "${origin}". Query or hash is not allowed.`,
    );
  }
  if (trimmed !== url.origin) {
    throw new Error(
      `Invalid CORS origin "${origin}". Must match exact origin without trailing slash (expected "${url.origin}").`,
    );
  }
  return url.origin;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options?: LoadConfigOptions,
): Config {
  const tailscaleIp = env.TAILSCALE_IP?.trim();
  if (!tailscaleIp) {
    throw new Error("TAILSCALE_IP is required.");
  }
  if (!isValidTailscaleIp(tailscaleIp)) {
    throw new Error(
      `TAILSCALE_IP "${tailscaleIp}" is not a valid IPv4 address in the 100.64.0.0/10 Carrier-Grade NAT (CGNAT) range.`,
    );
  }
  if (options?.checkInterfaces !== false) {
    if (!isIpOnLocalInterface(tailscaleIp)) {
      throw new Error(
        `TAILSCALE_IP "${tailscaleIp}" is not present on any local network interface.`,
      );
    }
  }

  const port = validatePort(env.PORT, 3000, "PORT");

  const adminApiToken = env.ADMIN_API_TOKEN ?? "";
  if (Buffer.byteLength(adminApiToken, "utf8") < 32) {
    throw new Error(
      "ADMIN_API_TOKEN is required and must be at least 32 bytes.",
    );
  }

  const rawDomains =
    env.MAIL_DOMAINS?.split(",")
      .map((d) => d.trim())
      .filter(Boolean) ?? [];
  if (rawDomains.length === 0) {
    throw new Error(
      "MAIL_DOMAINS is required and must contain at least one DNS domain.",
    );
  }
  const mailDomains: string[] = [];
  for (const domain of rawDomains) {
    if (domain !== domain.toLowerCase()) {
      throw new Error(`MAIL_DOMAINS entry "${domain}" must be lowercase.`);
    }
    if (!DOMAIN_REGEX.test(domain) || domain.length > 253) {
      throw new Error(
        `MAIL_DOMAINS entry "${domain}" is not a valid DNS domain name.`,
      );
    }
    if (!mailDomains.includes(domain)) {
      mailDomains.push(domain);
    }
  }

  const dmsContainer = env.DMS_CONTAINER?.trim();
  if (!dmsContainer) {
    throw new Error("DMS_CONTAINER is required.");
  }
  if (
    !CONTAINER_NAME_REGEX.test(dmsContainer) ||
    dmsContainer.startsWith("-")
  ) {
    throw new Error(
      `DMS_CONTAINER "${dmsContainer}" must follow container name syntax and cannot start with a dash.`,
    );
  }

  const imapHost = env.IMAP_HOST?.trim() || "127.0.0.1";
  const imapPort = validatePort(env.IMAP_PORT, 993, "IMAP_PORT");
  const imapMasterUser = env.IMAP_MASTER_USER?.trim();
  if (!imapMasterUser) {
    throw new Error("IMAP_MASTER_USER is required.");
  }
  const imapMasterPassword = env.IMAP_MASTER_PASSWORD ?? "";
  if (imapMasterPassword === "") {
    throw new Error("IMAP_MASTER_PASSWORD is required.");
  }

  const smtpHost = env.SMTP_HOST?.trim() || "127.0.0.1";
  const smtpPort = validatePort(env.SMTP_PORT, 587, "SMTP_PORT");
  const smtpUser = env.SMTP_USER?.trim();
  if (!smtpUser) {
    throw new Error("SMTP_USER is required.");
  }
  const smtpPassword = env.SMTP_PASSWORD ?? "";
  if (smtpPassword === "") {
    throw new Error("SMTP_PASSWORD is required.");
  }

  const mailTlsServername = env.MAIL_TLS_SERVERNAME?.trim();
  if (!mailTlsServername) {
    throw new Error("MAIL_TLS_SERVERNAME is required.");
  }
  if (
    !DOMAIN_REGEX.test(mailTlsServername.toLowerCase()) ||
    mailTlsServername.length > 253
  ) {
    throw new Error(
      `MAIL_TLS_SERVERNAME "${mailTlsServername}" must be a valid DNS hostname.`,
    );
  }

  let mailTlsCaFile: string | undefined;
  if (env.MAIL_TLS_CA_FILE?.trim()) {
    mailTlsCaFile = env.MAIL_TLS_CA_FILE.trim();
    if (!fs.existsSync(mailTlsCaFile)) {
      throw new Error(
        `MAIL_TLS_CA_FILE path "${mailTlsCaFile}" does not exist.`,
      );
    }
  }

  const corsOrigins: string[] = [];
  if (env.CORS_ORIGINS?.trim()) {
    const rawOrigins = env.CORS_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const raw of rawOrigins) {
      const validated = validateCorsOrigin(raw);
      if (!corsOrigins.includes(validated)) {
        corsOrigins.push(validated);
      }
    }
  }

  return {
    tailscaleIp,
    port,
    adminApiToken,
    mailDomains,
    dmsContainer,
    imapHost,
    imapPort,
    imapMasterUser,
    imapMasterPassword,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPassword,
    mailTlsServername,
    mailTlsCaFile,
    corsOrigins,
  };
}
