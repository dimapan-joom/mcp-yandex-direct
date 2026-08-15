import type { AuthConfig, YandexDirectConfig } from "./types.js";

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

/** Everything index.ts needs to boot: client settings + the resolved auth mode. */
export interface LoadedConfig {
  config: YandexDirectConfig;
  auth: AuthConfig;
}

const DEFAULT_TOKEN_URL = "https://oauth.yandex.ru/token";

/**
 * Resolves the auth mode from the environment.
 *
 * Precedence: a complete OAuth trio (client id + secret + refresh token) wins over
 * a static YANDEX_DIRECT_TOKEN — with a loud stderr note, because silently ignoring
 * a set variable is a footgun. A PARTIAL trio is a hard error rather than a silent
 * fall-back to the static token: a half-configured refresh setup must fail at
 * startup, not expire unattended weeks later.
 */
function loadAuth(): AuthConfig {
  const staticTokenValue = process.env.YANDEX_DIRECT_TOKEN;
  const clientId = process.env.YANDEX_OAUTH_CLIENT_ID;
  const clientSecret = process.env.YANDEX_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.YANDEX_OAUTH_REFRESH_TOKEN;

  const provided = [clientId, clientSecret, refreshToken].filter(Boolean).length;
  if (provided > 0 && provided < 3) {
    throw new ConfigError(
      "Для refresh-token авторизации нужны все три переменные: YANDEX_OAUTH_CLIENT_ID, " +
        "YANDEX_OAUTH_CLIENT_SECRET и YANDEX_OAUTH_REFRESH_TOKEN — задана только часть.",
      "incomplete_oauth_credentials",
    );
  }

  if (provided === 3) {
    const tokenUrl = process.env.YANDEX_OAUTH_TOKEN_URL || DEFAULT_TOKEN_URL;
    // The exchange request carries client_secret + refresh_token; anything but
    // https would hand them to a plaintext or attacker-chosen endpoint. Same
    // spirit as the SSRF guard in client.call().
    let parsed: URL;
    try {
      parsed = new URL(tokenUrl);
    } catch {
      throw new ConfigError(
        "YANDEX_OAUTH_TOKEN_URL не является корректным URL.",
        "invalid_oauth_token_url",
      );
    }
    if (parsed.protocol !== "https:") {
      throw new ConfigError(
        "YANDEX_OAUTH_TOKEN_URL должен использовать https.",
        "invalid_oauth_token_url",
      );
    }
    if (staticTokenValue) {
      console.error(
        "mcp-yandex-direct: используется refresh-token авторизация; YANDEX_DIRECT_TOKEN игнорируется.",
      );
    }
    const oauthTimeout = Number(process.env.YANDEX_OAUTH_TIMEOUT_MS);
    const directTimeout = Number(process.env.YANDEX_DIRECT_TIMEOUT_MS);
    const timeoutMs =
      Number.isFinite(oauthTimeout) && oauthTimeout > 0
        ? oauthTimeout
        : Number.isFinite(directTimeout) && directTimeout > 0
          ? directTimeout
          : 30_000;
    return {
      kind: "refreshing",
      clientId: clientId as string,
      clientSecret: clientSecret as string,
      refreshToken: refreshToken as string,
      tokenUrl,
      timeoutMs,
    };
  }

  if (staticTokenValue) return { kind: "static", token: staticTokenValue };

  throw new ConfigError(
    "Требуется авторизация: либо YANDEX_DIRECT_TOKEN, либо трио YANDEX_OAUTH_CLIENT_ID / " +
      "YANDEX_OAUTH_CLIENT_SECRET / YANDEX_OAUTH_REFRESH_TOKEN.",
    "missing_token",
  );
}

/** Builds the client config and auth mode from environment variables. */
export function loadConfig(): LoadedConfig {
  const auth = loadAuth();
  const timeoutMs = Number(process.env.YANDEX_DIRECT_TIMEOUT_MS);
  const maxRetries = Number(process.env.YANDEX_DIRECT_MAX_RETRIES);
  return {
    auth,
    config: {
      // The static token also stays on the config for the client's back-compat
      // default provider; in refreshing mode the config carries no secrets.
      token: auth.kind === "static" ? auth.token : undefined,
      login: process.env.YANDEX_DIRECT_LOGIN || undefined,
      lang: process.env.YANDEX_DIRECT_LANG || "ru",
      sandbox: /^(1|true|yes)$/i.test(process.env.YANDEX_DIRECT_SANDBOX ?? ""),
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
      maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : 3,
    },
  };
}
