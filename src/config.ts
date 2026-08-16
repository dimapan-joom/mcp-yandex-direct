import type { AccountConfig, AuthConfig, YandexDirectConfig } from "./types.js";

/**
 * A missing or malformed environment variable. Thrown instead of exiting on the
 * spot so index.ts can report the reason on stderr before the process dies;
 * `reason` is a closed machine-readable vocabulary (never a variable's value).
 */
export class ConfigError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "ConfigError";
    this.reason = reason;
  }
}

/** Everything index.ts needs to boot: client settings + every configured account. */
export interface LoadedConfig {
  config: YandexDirectConfig;
  accounts: AccountConfig[];
  /** Alias used when a call names no account. */
  defaultAccount: string;
}

const DEFAULT_TOKEN_URL = "https://oauth.yandex.ru/token";
/** Alias for credentials given via the single-account variables. */
const DEFAULT_ALIAS = "default";

/** `YANDEX_ACCOUNT_<ALIAS>_<FIELD>` — the multi-account form. */
const ACCOUNT_VAR =
  /^YANDEX_ACCOUNT_([A-Z0-9]+(?:_[A-Z0-9]+)*?)_(CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN|TOKEN|LOGIN|DESCRIPTION)$/;

/** Reads the OAuth endpoint override, rejecting anything that is not https. */
function resolveTokenUrl(): string {
  const tokenUrl = process.env.YANDEX_OAUTH_TOKEN_URL || DEFAULT_TOKEN_URL;
  // The exchange request carries client_secret + refresh_token; anything but
  // https would hand them to a plaintext or attacker-chosen endpoint. Same
  // spirit as the SSRF guard in client.call().
  let parsed: URL;
  try {
    parsed = new URL(tokenUrl);
  } catch {
    throw new ConfigError("YANDEX_OAUTH_TOKEN_URL не является корректным URL.", "invalid_oauth_token_url");
  }
  if (parsed.protocol !== "https:") {
    throw new ConfigError("YANDEX_OAUTH_TOKEN_URL должен использовать https.", "invalid_oauth_token_url");
  }
  return tokenUrl;
}

function resolveOauthTimeout(): number {
  const oauth = Number(process.env.YANDEX_OAUTH_TIMEOUT_MS);
  if (Number.isFinite(oauth) && oauth > 0) return oauth;
  const direct = Number(process.env.YANDEX_DIRECT_TIMEOUT_MS);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return 30_000;
}

/** Builds one account's auth from its raw field bag, or throws with its alias named. */
function authFromFields(
  alias: string,
  fields: Record<string, string>,
  tokenUrl: string,
  timeoutMs: number,
): AuthConfig {
  const trio = [fields.CLIENT_ID, fields.CLIENT_SECRET, fields.REFRESH_TOKEN];
  const provided = trio.filter(Boolean).length;
  if (provided > 0 && provided < 3) {
    throw new ConfigError(
      `Аккаунт "${alias}": для refresh-token авторизации нужны все три переменные — ` +
        "CLIENT_ID, CLIENT_SECRET и REFRESH_TOKEN, задана только часть.",
      "incomplete_oauth_credentials",
    );
  }
  if (provided === 3) {
    if (fields.TOKEN) {
      console.error(
        `mcp-yandex-direct: аккаунт "${alias}" использует refresh-token авторизацию; статический TOKEN игнорируется.`,
      );
    }
    return {
      kind: "refreshing",
      clientId: fields.CLIENT_ID,
      clientSecret: fields.CLIENT_SECRET,
      refreshToken: fields.REFRESH_TOKEN,
      tokenUrl,
      timeoutMs,
    };
  }
  if (fields.TOKEN) return { kind: "static", token: fields.TOKEN };
  throw new ConfigError(
    `Аккаунт "${alias}": не заданы ни OAuth-трио (CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN), ни статический TOKEN.`,
    "missing_token",
  );
}

/**
 * Collects `YANDEX_ACCOUNT_<ALIAS>_<FIELD>` variables into per-alias field bags.
 * Aliases are lowercased so callers can write them naturally.
 */
function collectAccountFields(): Map<string, Record<string, string>> {
  const bags = new Map<string, Record<string, string>>();
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    const match = ACCOUNT_VAR.exec(key);
    if (!match) continue;
    const alias = match[1].toLowerCase();
    const bag = bags.get(alias) ?? {};
    bags.set(alias, { ...bag, [match[2]]: value });
  }
  return bags;
}

/** Reads the single-account variables into a field bag (empty when unused). */
function legacyFields(): Record<string, string> {
  const fields: Record<string, string> = {};
  const { YANDEX_OAUTH_CLIENT_ID, YANDEX_OAUTH_CLIENT_SECRET, YANDEX_OAUTH_REFRESH_TOKEN, YANDEX_DIRECT_TOKEN } =
    process.env;
  if (YANDEX_OAUTH_CLIENT_ID) fields.CLIENT_ID = YANDEX_OAUTH_CLIENT_ID;
  if (YANDEX_OAUTH_CLIENT_SECRET) fields.CLIENT_SECRET = YANDEX_OAUTH_CLIENT_SECRET;
  if (YANDEX_OAUTH_REFRESH_TOKEN) fields.REFRESH_TOKEN = YANDEX_OAUTH_REFRESH_TOKEN;
  if (YANDEX_DIRECT_TOKEN) fields.TOKEN = YANDEX_DIRECT_TOKEN;
  return fields;
}

/** Picks the alias for calls that name no account, refusing to guess. */
function resolveDefaultAlias(accounts: AccountConfig[]): string {
  const requested = process.env.YANDEX_DEFAULT_ACCOUNT?.toLowerCase();
  const known = accounts.map((a) => a.alias).join(", ");
  if (requested) {
    if (!accounts.some((a) => a.alias === requested)) {
      throw new ConfigError(
        `YANDEX_DEFAULT_ACCOUNT="${requested}" не найден среди настроенных аккаунтов: ${known}.`,
        "unknown_default_account",
      );
    }
    return requested;
  }
  // Silently picking one would send un-targeted calls — writes included — to an
  // arbitrary account, so several accounts without an explicit default is an error.
  if (accounts.length > 1) {
    throw new ConfigError(
      `Настроено несколько аккаунтов (${known}) — нужно указать YANDEX_DEFAULT_ACCOUNT, ` +
        "чтобы вызовы без параметра account не уходили в случайный аккаунт.",
      "missing_default_account",
    );
  }
  return accounts[0].alias;
}

/**
 * Resolves every configured account.
 *
 * Two forms coexist: the multi-account `YANDEX_ACCOUNT_<ALIAS>_*` variables, and
 * the original single-account ones (`YANDEX_OAUTH_*` / `YANDEX_DIRECT_TOKEN`),
 * which become the account named "default". Each Yandex account can be its own
 * OAuth application, so credentials belong to an account, not to the server.
 */
function loadAccounts(): { accounts: AccountConfig[]; defaultAccount: string } {
  const tokenUrl = resolveTokenUrl();
  const timeoutMs = resolveOauthTimeout();
  const accounts: AccountConfig[] = [];

  for (const [alias, fields] of collectAccountFields()) {
    accounts.push({
      alias,
      auth: authFromFields(alias, fields, tokenUrl, timeoutMs),
      login: fields.LOGIN || undefined,
      description: fields.DESCRIPTION || undefined,
    });
  }

  const legacy = legacyFields();
  if (Object.keys(legacy).length > 0) {
    if (accounts.some((a) => a.alias === DEFAULT_ALIAS)) {
      throw new ConfigError(
        `Аккаунт "${DEFAULT_ALIAS}" задан дважды: и через YANDEX_ACCOUNT_DEFAULT_*, и через одиночные ` +
          "переменные (YANDEX_OAUTH_* / YANDEX_DIRECT_TOKEN). Оставить один способ.",
        "duplicate_default_account",
      );
    }
    accounts.push({
      alias: DEFAULT_ALIAS,
      auth: authFromFields(DEFAULT_ALIAS, legacy, tokenUrl, timeoutMs),
      login: process.env.YANDEX_DIRECT_LOGIN || undefined,
    });
  }

  if (accounts.length === 0) {
    throw new ConfigError(
      "Не настроен ни один аккаунт. Задать либо YANDEX_ACCOUNT_<ALIAS>_CLIENT_ID / _CLIENT_SECRET / " +
        "_REFRESH_TOKEN для каждого аккаунта, либо одиночные YANDEX_OAUTH_CLIENT_ID / _CLIENT_SECRET / " +
        "_REFRESH_TOKEN (или YANDEX_DIRECT_TOKEN).",
      "missing_token",
    );
  }

  return { accounts, defaultAccount: resolveDefaultAlias(accounts) };
}

/** Builds the client config and every account from environment variables. */
export function loadConfig(): LoadedConfig {
  const { accounts, defaultAccount } = loadAccounts();
  const timeoutMs = Number(process.env.YANDEX_DIRECT_TIMEOUT_MS);
  const maxRetries = Number(process.env.YANDEX_DIRECT_MAX_RETRIES);
  const fallback = accounts.find((a) => a.alias === defaultAccount);
  return {
    accounts,
    defaultAccount,
    config: {
      // Secrets stay on AccountConfig/AuthConfig (and then inside the provider's
      // closure); the loggable config only carries the default account's login.
      login: fallback?.login,
      lang: process.env.YANDEX_DIRECT_LANG || "ru",
      sandbox: /^(1|true|yes)$/i.test(process.env.YANDEX_DIRECT_SANDBOX ?? ""),
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
      maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : 3,
    },
  };
}
