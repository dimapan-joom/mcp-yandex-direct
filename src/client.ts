import type { ApiError, YandexDirectConfig } from "./types.js";
import { YandexDirectError } from "./types.js";
import { staticToken, type TokenProvider } from "./auth/tokenProvider.js";
import { DEFAULT_PAGE_LIMIT, isReadMethod } from "./tools/util.js";

const PROD_BASE = "https://api.direct.yandex.com/json/v5/";
const SANDBOX_BASE = "https://api-sandbox.direct.yandex.com/json/v5/";

// Legacy Live v4 API — a DIFFERENT host/path and request shape than v5. Kept only for
// finance data: AccountManagement (the sole method exposing the shared-account balance)
// lives only here; v5 has no finance service.
const PROD_V4_BASE = "https://api.direct.yandex.ru/live/v4/json/";
const SANDBOX_V4_BASE = "https://api-sandbox.direct.yandex.ru/live/v4/json/";

export interface ReportOptions {
  processingMode?: "auto" | "online" | "offline";
  returnMoneyInMicros?: boolean;
  maxPolls?: number;
  /** Client-Login override for this report; undefined → configured login. */
  login?: string | null;
}

/** API error codes that are transient and worth retrying: 52 = try again later, 506 = request rate exceeded. */
const RETRYABLE_CODES = new Set([52, 506]);

/** Hard row cap for getAll so a runaway full-export can't exhaust memory/context. */
export const GETALL_MAX_ROWS = 100_000;
/** Hard byte cap (serialized merged entities) for getAll — ~1 MB. */
export const GETALL_MAX_BYTES = 1_000_000;

/** Optional caps for {@link YandexDirectClient.getAll}. */
export interface AutoPaginateCaps {
  maxRows?: number;
  maxBytes?: number;
}

/** Daily API points quota from the Units response header. */
export interface Units {
  spent: number;
  rest: number;
  limit: number;
}

export class YandexDirectClient {
  private readonly base: string;
  private readonly v4Base: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private latestUnits?: Units;

  constructor(
    private readonly config: YandexDirectConfig,
    // Defaulting to a static provider keeps every existing `new YandexDirectClient({token})`
    // call site (tests included) working unchanged; index.ts passes the real provider.
    private readonly tokens: TokenProvider = staticToken(config.token ?? ""),
  ) {
    this.base = config.sandbox ? SANDBOX_BASE : PROD_BASE;
    this.v4Base = config.sandbox ? SANDBOX_V4_BASE : PROD_V4_BASE;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseMs = config.retryBaseMs ?? 500;
  }

  /** The most recent API points quota seen in a Units response header, if any. */
  get units(): Units | undefined {
    return this.latestUnits;
  }

  /** Backoff before a retry: honors Retry-After when present, else exponential (capped at 30s). */
  private backoffMs(attempt: number, res?: Response): number {
    const retryAfter = res ? Number(res.headers.get("Retry-After")) : NaN;
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, 30) * 1000;
    return Math.min(this.retryBaseMs * 2 ** attempt, 30_000);
  }

  /**
   * fetch with an AbortController timeout so a hung connection can't hang the tool
   * forever. Reads the body INSIDE the guarded zone (the timer is cleared only after
   * `res.text()` resolves), so a slow/drip-feed body is covered by the same timeout
   * as the headers — not left to hang on the default body timeout.
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    service: string,
  ): Promise<{ res: Response; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const text = await res.text();
      return { res, text };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Запрос к "${service}" превысил таймаут ${this.timeoutMs} мс`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Builds request headers around an already-minted Bearer token. Callers fetch the
   * token themselves (one per loop iteration) so the SAME value goes into the request
   * and into tokens.invalidate() on an auth failure — fetching twice could straddle a
   * cache refresh and invalidate the wrong token. Client-Login stays orthogonal to
   * auth: one agency token serves all logins.
   *
   * `login` semantics: undefined → the configured YANDEX_DIRECT_LOGIN (if any);
   * a string → that client's account; null → NO Client-Login header at all
   * (required by agencyclients.get, which addresses the agency itself).
   */
  private buildHeaders(
    token: string,
    extra?: Record<string, string>,
    login?: string | null,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Accept-Language": this.config.lang,
      "Content-Type": "application/json; charset=utf-8",
    };
    const effectiveLogin = login === undefined ? this.config.login : login;
    if (effectiveLogin) headers["Client-Login"] = effectiveLogin;
    return { ...headers, ...extra };
  }

  /**
   * True when the response is an auth rejection worth ONE re-mint + retry.
   * Code 53 = «Ошибка авторизации» (invalid/revoked token). Deliberately NOT
   * 52 (auth server down — transient, already in RETRYABLE_CODES), NOT 54
   * («нет прав» — a fresh token grants no new rights) and NOT 8000 (covers
   * genuinely malformed requests too).
   */
  private static isAuthFailure(status: number, errorCode?: number): boolean {
    return status === 401 || errorCode === 53;
  }

  /**
   * Calls a JSON service (campaigns, ads, keywords, ...) and returns its `result` object.
   * `login` overrides the configured Client-Login for this call (see buildHeaders).
   */
  async call<T = unknown>(
    service: string,
    method: string,
    params: Record<string, unknown>,
    login?: string | null,
  ): Promise<T> {
    // SSRF guard (matches the sibling MCP servers): resolve `service` against the API
    // base and reject anything that lands on a FOREIGN origin — an absolute URL
    // ("https://evil/x", "http://evil/x") or a protocol-relative/backslash form
    // ("\\evil/x") would otherwise rebase the token-bearing request onto another host.
    // Comparing the resolved origin (not a brittle string test) stays correct regardless
    // of how the URL is built below.
    const target = new URL(service.replace(/^\//, ""), this.base);
    if (target.origin !== new URL(this.base).origin) {
      throw new Error(
        `service должен быть относительным путём API (получился чужой origin ${target.origin})`,
      );
    }
    // Only read methods (get/has/check) are safe to auto-retry on a network failure or
    // 5xx: a write (add/update/delete/set) may have committed before the gateway error,
    // so a blind retry could duplicate it. Rate-limit codes (429/506/52) mean the request
    // was NOT processed and are retried for any method (handled below).
    const idempotent = isReadMethod(method);
    // At most ONE token re-mint per logical request, outside the transient budget.
    let reauthUsed = false;
    for (let attempt = 0; ; ) {
      const token = await this.tokens.getToken();
      let res: Response;
      let text: string;
      try {
        ({ res, text } = await this.fetchWithTimeout(
          target.toString(),
          {
            method: "POST",
            headers: this.buildHeaders(token, undefined, login),
            body: JSON.stringify({ method, params }),
          },
          service,
        ));
      } catch (err) {
        // Network error or timeout: retry idempotent reads within budget, else rethrow.
        if (idempotent && attempt < this.maxRetries) {
          await delay(this.backoffMs(attempt));
          attempt++;
          continue;
        }
        throw err;
      }

      const units = parseUnits(res.headers.get("Units"));
      if (units) this.latestUnits = units;

      // Auth rejection (HTTP 401): like 429, the request was NOT executed — it died
      // at the auth gate — so a retry with a fresh token is safe for ANY method,
      // writes included. Static tokens return false from invalidate() → no retry,
      // preserving the original behaviour.
      if (YandexDirectClient.isAuthFailure(res.status) && !reauthUsed && this.tokens.invalidate(token)) {
        reauthUsed = true;
        continue; // deliberately does NOT consume the transient `attempt` budget
      }

      // HTTP 429 means the request was NOT processed, so (like error codes 506/52)
      // it is safe to retry for ANY method, writes included.
      if (res.status === 429) {
        if (attempt < this.maxRetries) {
          await delay(this.backoffMs(attempt, res));
          attempt++;
          continue;
        }
        throw new Error(
          `"${service}" вернул HTTP 429 — превышена частота запросов (попыток: ${attempt + 1}): ${text.slice(0, 300)}`,
        );
      }

      // Gateway/server errors are transient — back off and retry, but only for
      // idempotent reads (a write may already have taken effect on the backend).
      if (res.status >= 500 && res.status < 600) {
        if (idempotent && attempt < this.maxRetries) {
          await delay(this.backoffMs(attempt, res));
          attempt++;
          continue;
        }
        throw new Error(
          `"${service}" вернул HTTP ${res.status} (попыток: ${attempt + 1}): ${text.slice(0, 300)}`,
        );
      }

      let data: { result?: T; error?: ApiError };
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          `Некорректный JSON в ответе "${service}" (HTTP ${res.status}): ${text.slice(0, 500)}`,
        );
      }

      if (data.error) {
        // Error code 53 = invalid/revoked token, same auth-gate semantics as HTTP 401.
        if (
          YandexDirectClient.isAuthFailure(res.status, data.error.error_code) &&
          !reauthUsed &&
          this.tokens.invalidate(token)
        ) {
          reauthUsed = true;
          continue;
        }
        if (RETRYABLE_CODES.has(data.error.error_code) && attempt < this.maxRetries) {
          await delay(this.backoffMs(attempt, res));
          attempt++;
          continue;
        }
        throw new YandexDirectError(data.error);
      }
      if (data.result === undefined) {
        // Neither `result` nor `error`: surface the raw response so the caller sees what the
        // API actually returned, instead of returning `undefined` (which `JSON.stringify`s to
        // `undefined` downstream → invalid MCP content / a silent, cryptic failure).
        throw new Error(
          `Неожиданный ответ "${service}" (HTTP ${res.status}) — нет поля "result": ${text.slice(0, 500)}`,
        );
      }
      return data.result as T;
    }
  }

  /**
   * Calls the legacy Live v4 API (different base URL AND request shape than v5): the
   * OAuth token goes in the JSON body, not the Authorization header, and the result is
   * under `data` (errors under `error_code`/`error_str`). Used only for finance reads
   * (AccountManagement) that v5 does not expose. Money in v4 is already in currency units
   * (not micros) — callers must NOT run normalizeMoney on it.
   */
  async callV4<T = unknown>(method: string, param: Record<string, unknown>): Promise<T> {
    // v4 multiplexes read and write behind one method (AccountManagement) via `Action`,
    // so idempotency keys off Action=Get. Only reads are retried on a transient network
    // error or 5xx; a write action (Deposit/Update/…) must never be blindly re-sent.
    const idempotent = String(param.Action ?? "").toLowerCase() === "get";
    // Same one-shot re-auth as call(): v4 carries the token in the BODY, not a header.
    let reauthUsed = false;
    for (let attempt = 0; ; ) {
      const token = await this.tokens.getToken();
      let res: Response;
      let text: string;
      try {
        ({ res, text } = await this.fetchWithTimeout(
          this.v4Base,
          {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ method, token, locale: this.config.lang, param }),
          },
          method,
        ));
      } catch (err) {
        if (idempotent && attempt < this.maxRetries) {
          await delay(this.backoffMs(attempt));
          attempt++;
          continue;
        }
        throw err;
      }

      if (res.status >= 500 && res.status < 600) {
        if (idempotent && attempt < this.maxRetries) {
          await delay(this.backoffMs(attempt, res));
          attempt++;
          continue;
        }
        throw new Error(
          `Live v4 "${method}" вернул HTTP ${res.status} (попыток: ${attempt + 1}): ${text.slice(0, 300)}`,
        );
      }

      let data: { data?: T; error_code?: number; error_str?: string; error_detail?: string };
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          `Некорректный JSON от Live v4 "${method}" (HTTP ${res.status}): ${text.slice(0, 500)}`,
        );
      }

      if (data.error_code !== undefined) {
        // v4 code 53 = authorization error, same auth-gate semantics as v5 —
        // the request was rejected before execution, one fresh-token retry is safe.
        if (data.error_code === 53 && !reauthUsed && this.tokens.invalidate(token)) {
          reauthUsed = true;
          continue;
        }
        const detail = data.error_detail ? `: ${data.error_detail}` : "";
        throw new Error(`Ошибка Live v4 "${method}": [${data.error_code}] ${data.error_str ?? ""}${detail}`);
      }
      if (data.data === undefined) {
        throw new Error(
          `Неожиданный ответ Live v4 для "${method}" (HTTP ${res.status}) — нет поля "data": ${text.slice(0, 500)}`,
        );
      }
      return data.data as T;
    }
  }

  /**
   * Runs a `get` request, following the LimitedBy cursor to fetch every page
   * and merging the entity array, so large accounts are not silently truncated.
   * Pages at DEFAULT_PAGE_LIMIT (10k) regardless of the per-tool `limit` clamp
   * (which governs single-page calls only), so capacity is deterministic — not
   * path-dependent. Bounded by maxPages (runaway-loop stop) AND by hard row/byte
   * caps (GETALL_MAX_ROWS / GETALL_MAX_BYTES), because nothing downstream limits
   * the result size and an unbounded full-export would flood the LLM context.
   * Hitting any cap flags the merged result with `_truncated`/`_truncatedNote`
   * and keeps LimitedBy as a resume cursor, so a truncated full-export is
   * explicit and never silent data loss.
   */
  async getAll<T = unknown>(
    service: string,
    params: Record<string, unknown>,
    maxPages = 100,
    caps: AutoPaginateCaps = {},
    login?: string | null,
  ): Promise<T> {
    const basePage = (params.Page as Record<string, unknown> | undefined) ?? {};
    // autoPaginate ("fetch all") ALWAYS pages at the API max, independent of the
    // per-tool `limit` clamp (which governs single-page calls only). This keeps
    // capacity deterministic instead of path-dependent (a caller passing
    // limit:1000 alongside autoPaginate must not silently shrink the export ceiling).
    const limit = DEFAULT_PAGE_LIMIT;
    const maxRows = caps.maxRows ?? GETALL_MAX_ROWS;
    const maxBytes = caps.maxBytes ?? GETALL_MAX_BYTES;
    let offset = Number(basePage.Offset ?? 0);
    let merged: Record<string, unknown> | undefined;
    let entityKey: string | undefined;
    let bytes = 0;
    let capNote: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const pageParams = { ...params, Page: { Limit: limit, Offset: offset } };
      const result = await this.call<Record<string, unknown>>(service, "get", pageParams, login);

      if (!merged) {
        merged = result;
        entityKey = Object.keys(result).find((key) => Array.isArray(result[key]));
      } else if (entityKey && Array.isArray(result[entityKey])) {
        (merged[entityKey] as unknown[]).push(...(result[entityKey] as unknown[]));
      }
      const batch = entityKey && Array.isArray(result[entityKey]) ? (result[entityKey] as unknown[]) : [];
      if (batch.length) bytes += JSON.stringify(batch).length;
      const rows = entityKey ? (merged[entityKey] as unknown[]).length : 0;

      // Checked BEFORE the caps: a dataset that completes exactly on a cap boundary
      // is complete, not truncated (nothing left to fetch → no "narrow the filter" advice).
      const limitedBy = result.LimitedBy;
      if (typeof limitedBy !== "number") {
        delete merged.LimitedBy;
        return merged as T;
      }
      offset = limitedBy;

      // Hard caps: more pages remain, but stop before a runaway export exhausts
      // memory or the downstream context.
      if (rows >= maxRows || bytes >= maxBytes) {
        capNote =
          `Остановлено на лимите объёма autoPaginate (объектов: ${rows}, байт: ~${bytes}); ` +
          `остались ещё объекты (LimitedBy=${offset}). ` +
          "Сузить фильтр или пройти страницы вручную с offset, чтобы получить остальные.";
        break;
      }
    }
    // Stopped on a cap (pages or rows/bytes) with LimitedBy still set → more objects
    // remain. Make this LOUD: a bare LimitedBy number is easy for an LLM consumer to miss,
    // and a silently truncated full-export is legitimate-data loss.
    if (merged && typeof (merged as Record<string, unknown>).LimitedBy === "number") {
      const m = merged as Record<string, unknown>;
      // The scalar LimitedBy was copied from the FIRST page and is now stale (it points
      // just past page 1, not past the merged set). Overwrite it with `offset`, the cursor
      // after the last merged page, so "paginate with offset from LimitedBy" resumes at the
      // right place instead of re-fetching from the start.
      m.LimitedBy = offset;
      m._truncated = true;
      m._truncatedNote =
        capNote ??
        `Остановлено на лимите страниц (${maxPages}); остались ещё объекты (LimitedBy=${m.LimitedBy}). ` +
          "Сузить фильтр или пройти страницы вручную с offset, чтобы получить остальные.";
    }
    return merged as T;
  }

  /** Requests a TSV statistics report, polling while Yandex generates it. */
  async report(params: Record<string, unknown>, opts: ReportOptions = {}): Promise<string> {
    const url = this.base + "reports";
    const extraHeaders = {
      processingMode: opts.processingMode ?? "auto",
      returnMoneyInMicros: String(opts.returnMoneyInMicros ?? false),
      skipReportHeader: "true",
      skipReportSummary: "true",
    };
    const maxPolls = opts.maxPolls ?? 10;
    let lastStatus = 0;
    // One-shot re-auth, same semantics as call(): a 401 means the poll request
    // never reached the report queue, so retrying it cannot double-submit.
    let reauthUsed = false;

    for (let attempt = 0; attempt < maxPolls; attempt++) {
      const token = await this.tokens.getToken();
      // Headers are rebuilt EVERY poll: a long offline report is exactly the
      // window in which a cached token can expire mid-generation.
      const { res, text } = await this.fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: this.buildHeaders(token, extraHeaders, opts.login),
          body: JSON.stringify({ params }),
        },
        "reports",
      );
      lastStatus = res.status;

      if (res.status === 200) return text;

      if (res.status === 401 && !reauthUsed && this.tokens.invalidate(token)) {
        reauthUsed = true;
        attempt--; // the rejected poll never counted against the report queue
        continue;
      }

      // 201/202: report still generating. 5xx: transient server error during
      // generation — the docs recommend retrying after retryIn rather than
      // treating it as fatal. Both are retried within the poll budget.
      if (res.status === 201 || res.status === 202 || (res.status >= 500 && res.status < 600)) {
        if (attempt === maxPolls - 1) break;
        await delay(pollDelayMs(res));
        continue;
      }

      try {
        const parsed = JSON.parse(text) as { error?: ApiError };
        if (parsed.error) throw new YandexDirectError(parsed.error);
      } catch (e) {
        if (e instanceof YandexDirectError) throw e;
      }
      throw new Error(`Запрос отчёта завершился ошибкой (HTTP ${res.status}): ${text.slice(0, 500)}`);
    }

    throw new Error(`Отчёт не был готов; опросов: ${maxPolls}, последний HTTP ${lastStatus}`);
  }
}

/** Seconds to wait before re-polling a report, from the retryIn header (capped). */
function pollDelayMs(res: Response): number {
  const retryIn = Number(res.headers.get("retryIn") ?? 5);
  return Math.min(Number.isFinite(retryIn) ? retryIn : 5, 10) * 1000;
}

/** Parses the "spent/rest/limit" Units header into structured quota numbers. */
export function parseUnits(header: string | null): Units | undefined {
  if (!header) return undefined;
  const parts = header.split("/").map((n) => Number(n.trim()));
  if (parts.length !== 3 || !parts.every(Number.isFinite)) return undefined;
  const [spent, rest, limit] = parts;
  return { spent, rest, limit };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
