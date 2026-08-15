/**
 * Token lifecycle for the Direct client: a static env token (upstream behaviour,
 * unchanged) or a self-refreshing OAuth token minted from clientId/clientSecret/
 * refreshToken. The client only ever sees `getToken()`/`invalidate()`; secrets
 * live in this module's closures and never land on the loggable config object.
 */
import type { AuthConfig } from "../types.js";
import { exchangeRefreshToken, OAuthExchangeError } from "./yandexOAuth.js";

/** Kind is for diagnostics only — it never carries secret material. */
export type TokenProviderKind = "static" | "refreshing";

export interface TokenProvider {
  readonly kind: TokenProviderKind;
  /** Bearer token for the next request. Served from cache unless expiry is near. */
  getToken(): Promise<string>;
  /**
   * Called after the API rejected `usedToken`. Returns true only if a subsequent
   * getToken() could plausibly return a DIFFERENT token — i.e. a retry is worth it.
   * Compare-and-clear: if the cache already moved past `usedToken` (a concurrent
   * refresh won), the fresh value is kept and true is still returned.
   */
  invalidate(usedToken: string): boolean;
}

/** Upstream behaviour: one fixed token, nothing to re-mint, never worth a retry. */
export function staticToken(token: string): TokenProvider {
  return {
    kind: "static",
    getToken: async () => token,
    invalidate: () => false,
  };
}

/** Refresh this long before nominal expiry, so a token never expires mid-request. */
const SKEW_MS = 5 * 60_000;
/** Floor: a malformed/zero expires_in must not become a refresh-per-request loop. */
const MIN_CACHE_MS = 30_000;
/**
 * Ceiling: Yandex reports expires_in on the order of a YEAR. Trusting it literally
 * means a weeks-running process only discovers server-side revocation as a hard 401
 * mid-request. Re-minting at least twice a day is free insurance.
 */
const MAX_CACHE_MS = 12 * 3_600_000;
/** After a permanent OAuth failure, don't hit the network again for this long. */
const COOLDOWN_MS = 60_000;
/** Internal retries for transient (network/5xx) exchange failures. */
const EXCHANGE_RETRIES = 2;
const EXCHANGE_BACKOFF_MS = 500;

interface Cached {
  readonly token: string;
  readonly expiresAt: number;
  readonly generation: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

class RefreshingToken implements TokenProvider {
  readonly kind = "refreshing" as const;
  private cached?: Cached;
  /** Rotates on every successful exchange — Yandex issues a new one each time. */
  private refreshTokenValue: string;
  private inflight?: Promise<string>;
  private cooldownUntil = 0;
  private lastError?: Error;
  private generation = 0;
  private rotationAnnounced = false;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    refreshToken: string,
    private readonly tokenUrl: string,
    private readonly timeoutMs: number,
  ) {
    this.refreshTokenValue = refreshToken;
  }

  async getToken(): Promise<string> {
    // Happy path — runs on every single API call, must stay allocation-free.
    if (this.cached && Date.now() < this.cached.expiresAt) return this.cached.token;
    return this.refresh();
  }

  invalidate(usedToken: string): boolean {
    // A concurrent refresh already produced a newer token: keep it, retry with it.
    if (this.cached && this.cached.token !== usedToken) return true;
    this.cached = undefined;
    return true;
  }

  /** Single-flight: assigned synchronously, so N concurrent callers → 1 exchange. */
  private refresh(): Promise<string> {
    if (!this.inflight) {
      this.inflight = this.doRefresh().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async doRefresh(): Promise<string> {
    // A dead refresh token must not turn every tool call into an outbound request.
    if (Date.now() < this.cooldownUntil && this.lastError) throw this.lastError;

    let lastTransient: Error | undefined;
    for (let attempt = 0; attempt <= EXCHANGE_RETRIES; attempt++) {
      try {
        const response = await exchangeRefreshToken({
          tokenUrl: this.tokenUrl,
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          refreshToken: this.refreshTokenValue,
          timeoutMs: this.timeoutMs,
        });
        return this.accept(response.accessToken, response.refreshToken, response.expiresInSec);
      } catch (err) {
        if (err instanceof OAuthExchangeError && err.permanent) {
          this.cooldownUntil = Date.now() + COOLDOWN_MS;
          this.lastError = err;
          throw err;
        }
        lastTransient = err instanceof Error ? err : new Error(String(err));
        if (attempt < EXCHANGE_RETRIES) {
          await new Promise((r) => setTimeout(r, EXCHANGE_BACKOFF_MS * 2 ** attempt));
        }
      }
    }
    throw lastTransient ?? new Error("Обмен refresh-токена не удался");
  }

  private accept(
    accessToken: string,
    rotatedRefreshToken: string | undefined,
    expiresInSec: number,
  ): string {
    this.generation += 1;
    this.cooldownUntil = 0;
    this.lastError = undefined;
    const ttlMs = clamp(expiresInSec * 1000 - SKEW_MS, MIN_CACHE_MS, MAX_CACHE_MS);
    this.cached = {
      token: accessToken,
      expiresAt: Date.now() + ttlMs,
      generation: this.generation,
    };
    if (rotatedRefreshToken && rotatedRefreshToken !== this.refreshTokenValue) {
      this.refreshTokenValue = rotatedRefreshToken;
      // One-time operational note; generation counter instead of any token material.
      if (!this.rotationAnnounced) {
        this.rotationAnnounced = true;
        console.error(
          `mcp-yandex-direct: refresh-токен ротирован Яндексом (generation ${this.generation}). ` +
            "Сервер использует новый токен в памяти; значение в хранилище секретов рекомендуется " +
            "обновлять при плановой переавторизации.",
        );
      }
    }
    return accessToken;
  }
}

/** Builds the provider matching the auth mode resolved by loadConfig(). */
export function createTokenProvider(auth: AuthConfig): TokenProvider {
  if (auth.kind === "static") return staticToken(auth.token);
  return new RefreshingToken(
    auth.clientId,
    auth.clientSecret,
    auth.refreshToken,
    auth.tokenUrl,
    auth.timeoutMs,
  );
}
