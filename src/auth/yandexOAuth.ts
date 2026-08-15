/**
 * The single place that talks to the Yandex OAuth token endpoint.
 *
 * Secret-safety contract: a SUCCESSFUL response body contains two secrets
 * (access_token + rotated refresh_token), so no raw response text may ever be
 * embedded in an error message or log line. On failure only the machine `error`
 * code and human `error_description` are surfaced; a non-JSON body degrades to
 * "HTTP <status>, <n> байт" and nothing else.
 */

/** Parsed success payload of the refresh_token grant. */
export interface TokenResponse {
  readonly accessToken: string;
  /** Yandex rotates the refresh token on every exchange; may be absent in theory. */
  readonly refreshToken?: string;
  readonly expiresInSec: number;
}

export interface ExchangeParams {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly timeoutMs: number;
}

/** OAuth error codes that mean re-authorization is required — retrying is pointless. */
const PERMANENT_OAUTH_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

/** A failed token exchange; `permanent` means a fresh attempt cannot succeed. */
export class OAuthExchangeError extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = "OAuthExchangeError";
    this.permanent = permanent;
  }
}

/**
 * Exchanges a refresh token for a fresh access token.
 * POST application/x-www-form-urlencoded per https://yandex.ru/dev/id/doc/ru/tokens/refresh-client.
 */
export async function exchangeRefreshToken(params: ExchangeParams): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await fetch(params.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new OAuthExchangeError(
        `Обмен refresh-токена превысил таймаут ${params.timeoutMs} мс`,
        false,
      );
    }
    // Network-layer failure: no response body exists, so nothing secret can leak here.
    const reason = err instanceof Error ? err.message : String(err);
    throw new OAuthExchangeError(`Сетевая ошибка при обмене refresh-токена: ${reason}`, false);
  } finally {
    clearTimeout(timer);
  }

  if (res.ok) {
    let data: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    try {
      data = JSON.parse(text);
    } catch {
      // Deliberately NOT quoting the body: a 200 body is secret material even if malformed.
      throw new OAuthExchangeError(
        `OAuth-сервер вернул HTTP ${res.status} с некорректным JSON (${text.length} байт)`,
        false,
      );
    }
    if (typeof data.access_token !== "string" || data.access_token.length === 0) {
      throw new OAuthExchangeError(
        `OAuth-сервер вернул HTTP ${res.status} без access_token (${text.length} байт)`,
        false,
      );
    }
    const expiresIn = Number(data.expires_in);
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      expiresInSec: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 0,
    };
  }

  // Failure path: surface ONLY the documented error fields, never the raw body.
  let errorCode = "";
  let description = "";
  try {
    const parsed = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    if (typeof parsed.error === "string") errorCode = parsed.error;
    if (typeof parsed.error_description === "string") description = parsed.error_description;
  } catch {
    // Non-JSON error body — report size only.
  }
  const detail = errorCode
    ? `${errorCode}${description ? ` — ${description}` : ""}`
    : `HTTP ${res.status}, ${text.length} байт`;

  if (PERMANENT_OAUTH_ERRORS.has(errorCode)) {
    throw new OAuthExchangeError(
      `Refresh-токен Яндекс OAuth отклонён (${detail}). ` +
        "Токены отзываются при смене пароля, включении/выключении двухфакторной аутентификации, " +
        "«выйти на всех устройствах» и отзыве доступа приложения. " +
        "Нужна повторная авторизация приложения и обновление refreshToken в хранилище секретов.",
      true,
    );
  }
  // 5xx or unknown 4xx: transient from the caller's perspective (it may retry).
  throw new OAuthExchangeError(
    `Обмен refresh-токена не удался (HTTP ${res.status}: ${detail})`,
    res.status >= 400 && res.status < 500 && errorCode !== "",
  );
}
