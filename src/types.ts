export interface YandexDirectConfig {
  /**
   * Static access token (upstream auth mode). Optional since the refresh-token
   * mode keeps secrets off this object entirely — see AuthConfig.
   */
  token?: string;
  login?: string;
  lang: string;
  sandbox: boolean;
  /** Per-request timeout in milliseconds. Defaults to 60_000. */
  timeoutMs?: number;
  /** Max retries for transient errors (rate limits, 5xx). Defaults to 3. */
  maxRetries?: number;
  /** Base backoff in milliseconds, doubled each retry. Defaults to 500. */
  retryBaseMs?: number;
}

/**
 * How the server authenticates to the Direct API. Resolved once at startup by
 * loadConfig(); consumed only by createTokenProvider(). Secrets deliberately live
 * here (and then in the provider's closure) rather than on YandexDirectConfig,
 * so serializing/printing the config can never leak them.
 */
export type AuthConfig =
  | { kind: "static"; token: string }
  | {
      kind: "refreshing";
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      tokenUrl: string;
      timeoutMs: number;
    };

/**
 * One configured advertiser account: its own OAuth credentials plus an optional
 * default Client-Login. Each account in Yandex Direct can be a separate OAuth
 * application, so credentials are per-account rather than global — the client
 * keeps one TokenProvider per alias and picks it by the `account` call target.
 */
export interface AccountConfig {
  /** Stable name the caller uses to select this account (lowercased env suffix). */
  alias: string;
  auth: AuthConfig;
  /** Client-Login applied to this account's calls unless the call overrides it. */
  login?: string;
  /** Free-text note from config, surfaced by list_accounts to orient the caller. */
  description?: string;
}

/** Where a single call is routed: which credentials, and which client account. */
export interface CallTarget {
  /** Account alias; omitted → the default account. */
  account?: string;
  /**
   * Client-Login override: a string selects a client of an agency account,
   * null forces NO header (agencyclients requires this), undefined falls back
   * to the account's configured login.
   */
  login?: string | null;
}

export interface ApiError {
  error_code: number;
  error_string: string;
  error_detail?: string;
  request_id?: string;
}

export class YandexDirectError extends Error {
  readonly code: number;
  readonly detail?: string;
  readonly requestId?: string;

  constructor(err: ApiError) {
    const detail = err.error_detail ? `: ${err.error_detail}` : "";
    // request_id is what Yandex support asks for when triaging a failed call — surface it
    // in the message so it reaches the user/logs instead of being buried on the object.
    const reqId = err.request_id ? ` (request_id: ${err.request_id})` : "";
    super(`[${err.error_code}] ${err.error_string}${detail}${reqId}`);
    this.name = "YandexDirectError";
    this.code = err.error_code;
    this.detail = err.error_detail;
    this.requestId = err.request_id;
  }
}
