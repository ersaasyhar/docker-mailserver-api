import { AppError } from "./app";
import type { DmsClient } from "./dms";

export interface AccountItem {
  email: string;
}

export interface AccountProvisionResult {
  email: string;
  provisioning: "pending";
}

export interface DeleteAccountOptions {
  confirmEmail: string;
  purge: boolean;
}

export interface AccountServiceOptions {
  dms: DmsClient;
  mailDomains: string[];
  smtpUser: string;
  accountLock: Mutex;
  accountKeyedLock: KeyedMutex;
}

const LOCAL_PART_REGEX = /^[a-z0-9]+(?:[._+-][a-z0-9]+)*$/;

export class Mutex {
  private queue: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

export class KeyedMutex {
  private locks = new Map<string, Promise<void>>();

  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const current = this.locks.get(key) ?? Promise.resolve();
    const next = current.then(fn, fn);
    this.locks.set(
      key,
      next.then(
        () => {},
        () => {},
      ),
    );
    next.finally(() => {
      if (this.locks.get(key) === next) {
        this.locks.delete(key);
      }
    });
    return next;
  }
}

export function normalizeAndValidateAccountEmail(
  rawEmail: string,
  allowedDomains: string[],
): { email: string; localPart: string; domain: string } {
  const normalized = rawEmail.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 254) {
    throw new AppError(
      "INVALID_REQUEST",
      "Email must be between 1 and 254 characters.",
    );
  }
  const atIndex = normalized.indexOf("@");
  if (atIndex === -1 || atIndex !== normalized.lastIndexOf("@")) {
    throw new AppError("INVALID_REQUEST", "Invalid email address format.");
  }
  const localPart = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);

  if (localPart.length === 0 || localPart.length > 64) {
    throw new AppError(
      "INVALID_REQUEST",
      "Email local-part must be between 1 and 64 characters.",
    );
  }
  if (!LOCAL_PART_REGEX.test(localPart)) {
    throw new AppError(
      "INVALID_REQUEST",
      "Email local-part contains invalid characters. Only lowercase alphanumeric characters and non-consecutive separators (._+-) are allowed.",
    );
  }
  if (!allowedDomains.includes(domain)) {
    throw new AppError(
      "DOMAIN_FORBIDDEN",
      `Domain "${domain}" is not in the allowed MAIL_DOMAINS.`,
    );
  }

  return { email: normalized, localPart, domain };
}

export function validateAccountPassword(password: string): void {
  const byteLength = Buffer.byteLength(password, "utf8");
  if (byteLength < 12 || byteLength > 256) {
    throw new AppError(
      "INVALID_REQUEST",
      "Password must be between 12 and 256 bytes.",
    );
  }
  if (/[\0\r\n]/.test(password)) {
    throw new AppError(
      "INVALID_REQUEST",
      "Password must not contain NUL or newline characters.",
    );
  }
}

export class AccountService {
  private readonly dms: DmsClient;
  private readonly mailDomains: string[];
  private readonly smtpUser: string;
  private readonly mutationLock: Mutex;
  private readonly keyedLock: KeyedMutex;

  constructor(options: AccountServiceOptions) {
    this.dms = options.dms;
    this.mailDomains = options.mailDomains;
    this.smtpUser = options.smtpUser.toLowerCase();
    this.mutationLock = options.accountLock;
    this.keyedLock = options.accountKeyedLock;
  }

  async listAccounts(): Promise<AccountItem[]> {
    const rawList = await this.dms.listAccounts();
    const items: AccountItem[] = [];

    for (const email of rawList) {
      const atIndex = email.indexOf("@");
      if (atIndex === -1) continue;
      const localPart = email.slice(0, atIndex);
      const domain = email.slice(atIndex + 1);

      if (
        this.mailDomains.includes(domain) &&
        localPart.length <= 64 &&
        LOCAL_PART_REGEX.test(localPart)
      ) {
        items.push({ email });
      }
    }

    items.sort((a, b) => a.email.localeCompare(b.email));
    return items;
  }

  async getAccount(rawEmail: string): Promise<AccountItem> {
    const { email } = normalizeAndValidateAccountEmail(
      rawEmail,
      this.mailDomains,
    );
    const accounts = await this.listAccounts();
    const found = accounts.find((a) => a.email === email);
    if (!found) {
      throw new AppError("NOT_FOUND", "Account not found.");
    }
    return found;
  }

  async createAccount(
    rawEmail: string,
    password: string,
  ): Promise<AccountProvisionResult> {
    const { email } = normalizeAndValidateAccountEmail(
      rawEmail,
      this.mailDomains,
    );
    validateAccountPassword(password);

    return this.mutationLock.runExclusive(async () => {
      const accounts = await this.dms.listAccounts();
      if (accounts.includes(email)) {
        throw new AppError("CONFLICT", "Account already exists.");
      }

      await this.dms.addAccount(email, password);
      return { email, provisioning: "pending" };
    });
  }

  async updatePassword(
    rawEmail: string,
    password: string,
  ): Promise<AccountProvisionResult> {
    const { email } = normalizeAndValidateAccountEmail(
      rawEmail,
      this.mailDomains,
    );
    validateAccountPassword(password);

    return this.mutationLock.runExclusive(async () => {
      const accounts = await this.dms.listAccounts();
      if (!accounts.includes(email)) {
        throw new AppError("NOT_FOUND", "Account not found.");
      }

      await this.dms.updateAccount(email, password);
      return { email, provisioning: "pending" };
    });
  }

  async deleteAccount(
    rawEmail: string,
    options: DeleteAccountOptions,
  ): Promise<void> {
    const { email, localPart, domain } = normalizeAndValidateAccountEmail(
      rawEmail,
      this.mailDomains,
    );

    if (
      options.confirmEmail?.trim().toLowerCase() !== email ||
      options.purge !== true
    ) {
      throw new AppError(
        "INVALID_REQUEST",
        "Invalid deletion confirmation. confirmEmail must match account and purge must be true.",
      );
    }

    if (email === this.smtpUser) {
      throw new AppError("CONFLICT", "Cannot delete configured SMTP_USER.");
    }

    return this.mutationLock.runExclusive(async () => {
      return this.keyedLock.runExclusive(email, async () => {
        const accounts = await this.dms.listAccounts();
        if (!accounts.includes(email)) {
          throw new AppError("NOT_FOUND", "Account not found.");
        }

        const maildirExists = await this.dms.checkMaildirExists(
          domain,
          localPart,
        );
        await this.dms.deleteAccount(email, maildirExists);
      });
    });
  }
}
