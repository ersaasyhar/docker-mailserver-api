import type { Subprocess } from "bun";
import { AppError } from "./app";

export interface DmsClient {
  listAccounts(): Promise<string[]>;
  addAccount(email: string, password: string): Promise<void>;
  updateAccount(email: string, password: string): Promise<void>;
  checkMaildirExists(domain: string, localPart: string): Promise<boolean>;
  deleteAccount(email: string, maildirExists: boolean): Promise<void>;
  preflightCheck(): Promise<void>;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence stripping requires matching ESC control character
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const ACCOUNT_LINE_REGEX = /^\*\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+)(?:\s.*)?$/;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB limit
const COMMAND_TIMEOUT_MS = 30_000; // 30 seconds

export interface DmsRunnerOptions {
  container: string;
}

export class DmsRunner implements DmsClient {
  private readonly container: string;

  constructor(options: DmsRunnerOptions) {
    this.container = options.container;
  }

  private async exec(
    args: string[],
    stdinData?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const fullArgs = [
      "docker",
      "exec",
      ...(stdinData ? ["-i"] : []),
      this.container,
      ...args,
    ];

    let proc: Subprocess;
    try {
      proc = Bun.spawn(fullArgs, {
        stdin: stdinData ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        "Failed to spawn Docker process.",
      );
    }

    if (stdinData && proc.stdin && typeof proc.stdin !== "number") {
      try {
        proc.stdin.write(new TextEncoder().encode(stdinData));
        proc.stdin.flush();
        proc.stdin.end();
      } catch {
        proc.kill();
        throw new AppError(
          "UPSTREAM_FAILURE",
          "Failed to write to upstream stdin.",
        );
      }
    }

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, COMMAND_TIMEOUT_MS);

    try {
      const stdoutPromise =
        proc.stdout && typeof proc.stdout !== "number"
          ? new Response(proc.stdout).arrayBuffer()
          : Promise.resolve(new ArrayBuffer(0));
      const stderrPromise =
        proc.stderr && typeof proc.stderr !== "number"
          ? new Response(proc.stderr).arrayBuffer()
          : Promise.resolve(new ArrayBuffer(0));

      const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
        stdoutPromise,
        stderrPromise,
        proc.exited,
      ]);

      if (timedOut) {
        throw new AppError(
          "UPSTREAM_UNAVAILABLE",
          "Upstream command timed out.",
        );
      }

      if (stdoutBuf.byteLength + stderrBuf.byteLength > MAX_OUTPUT_BYTES) {
        throw new AppError(
          "UPSTREAM_FAILURE",
          "Upstream command output exceeded maximum allowed size.",
        );
      }

      const stdout = new TextDecoder().decode(stdoutBuf);
      const stderr = new TextDecoder().decode(stderrBuf);

      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async preflightCheck(): Promise<void> {
    const { exitCode, stdout, stderr } = await this.exec([
      "setup",
      "email",
      "list",
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `DMS preflight check failed (exit code ${exitCode}): ${stderr || stdout}`,
      );
    }
  }

  async listAccounts(): Promise<string[]> {
    const { stdout, exitCode } = await this.exec(["setup", "email", "list"]);
    if (exitCode !== 0) {
      throw new AppError(
        "UPSTREAM_FAILURE",
        "Failed to list accounts from mailserver.",
      );
    }

    const clean = stdout.replace(ANSI_REGEX, "");
    const lines = clean.split(/\r?\n/);
    const accounts: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === "") continue;

      // Ignore known setup header / banner lines
      if (
        line.startsWith("=") ||
        line.startsWith("Listing") ||
        line.startsWith("Mail accounts") ||
        line.startsWith("No mail accounts")
      ) {
        continue;
      }

      const match = line.match(ACCOUNT_LINE_REGEX);
      if (match) {
        const email = match[1].toLowerCase();
        if (!accounts.includes(email)) {
          accounts.push(email);
        }
      } else {
        // Unexpected non-account output indicates DMS error or unexpected format
        throw new AppError(
          "UPSTREAM_FAILURE",
          "Unexpected output format from mailserver setup.",
        );
      }
    }

    return accounts;
  }

  async addAccount(email: string, password: string): Promise<void> {
    const stdinInput = `${password}\n${password}\n`;
    const { exitCode, stdout, stderr } = await this.exec(
      ["setup", "email", "add", email],
      stdinInput,
    );

    if (exitCode !== 0) {
      const combined = `${stdout} ${stderr}`.toLowerCase();
      if (
        combined.includes("already exists") ||
        combined.includes("duplicate") ||
        combined.includes("conflict")
      ) {
        throw new AppError("CONFLICT", "Account already exists.");
      }
      throw new AppError("UPSTREAM_FAILURE", "Failed to create mail account.");
    }
  }

  async updateAccount(email: string, password: string): Promise<void> {
    const stdinInput = `${password}\n${password}\n`;
    const { exitCode } = await this.exec(
      ["setup", "email", "update", email],
      stdinInput,
    );

    if (exitCode !== 0) {
      throw new AppError(
        "UPSTREAM_FAILURE",
        "Failed to update account password.",
      );
    }
  }

  async checkMaildirExists(
    domain: string,
    localPart: string,
  ): Promise<boolean> {
    const { exitCode } = await this.exec([
      "test",
      "-d",
      `/var/mail/${domain}/${localPart}`,
    ]);
    if (exitCode === 0) return true;
    if (exitCode === 1) return false;
    throw new AppError(
      "UPSTREAM_FAILURE",
      "Failed to check mail storage status.",
    );
  }

  async deleteAccount(email: string, maildirExists: boolean): Promise<void> {
    const flag = maildirExists ? "-y" : "-n";
    const { exitCode } = await this.exec([
      "setup",
      "email",
      "del",
      flag,
      email,
    ]);
    if (exitCode !== 0) {
      throw new AppError(
        "UPSTREAM_FAILURE",
        "Failed to delete account in mailserver.",
      );
    }
  }
}
