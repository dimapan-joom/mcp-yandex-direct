import { test } from "node:test";
import assert from "node:assert/strict";
import { createTokenProvider, staticToken } from "./tokenProvider.js";

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const u = String(url);
    const i = (init ?? {}) as RequestInit;
    calls.push({ url: u, init: i });
    return handler(u, i);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const REFRESHING = {
  kind: "refreshing" as const,
  clientId: "id",
  clientSecret: "s3cret-value",
  refreshToken: "r3fresh-value",
  tokenUrl: "https://oauth.example.test/token",
  timeoutMs: 5_000,
};

function okToken(token: string, refreshToken?: string, expiresIn = 3600): Response {
  return new Response(
    JSON.stringify({ access_token: token, refresh_token: refreshToken, expires_in: expiresIn }),
    { status: 200 },
  );
}

test("staticToken returns the token and refuses to invalidate", async () => {
  const provider = staticToken("fixed");
  assert.equal(provider.kind, "static");
  assert.equal(await provider.getToken(), "fixed");
  assert.equal(provider.invalidate("fixed"), false);
});

test("a cached token is served without touching the network", async () => {
  const mock = mockFetch(() => okToken("minted"));
  try {
    const provider = createTokenProvider(REFRESHING);
    assert.equal(await provider.getToken(), "minted");
    assert.equal(await provider.getToken(), "minted");
    assert.equal(await provider.getToken(), "minted");
    assert.equal(mock.calls.length, 1, "only the first getToken may hit the network");
  } finally {
    mock.restore();
  }
});

test("a zero/malformed expires_in still caches (floor), not a refresh-per-request loop", async () => {
  const mock = mockFetch(() => okToken("minted", undefined, 0));
  try {
    const provider = createTokenProvider(REFRESHING);
    await provider.getToken();
    await provider.getToken();
    assert.equal(mock.calls.length, 1, "MIN_CACHE floor must prevent thrashing");
  } finally {
    mock.restore();
  }
});

test("single-flight: concurrent getToken calls collapse into one exchange", async () => {
  let resolveResponse!: (r: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const mock = mockFetch(() => pending);
  try {
    const provider = createTokenProvider(REFRESHING);
    const inFlight = Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);
    resolveResponse(okToken("minted"));
    const tokens = await inFlight;
    assert.deepEqual(tokens, ["minted", "minted", "minted", "minted", "minted"]);
    assert.equal(mock.calls.length, 1, "five concurrent callers → exactly one exchange");
  } finally {
    mock.restore();
  }
});

test("the rotated refresh token is used on the next exchange", async () => {
  let exchange = 0;
  const mock = mockFetch(() => {
    exchange++;
    return exchange === 1 ? okToken("first", "r0tated-value") : okToken("second");
  });
  try {
    const provider = createTokenProvider(REFRESHING);
    const first = await provider.getToken();
    assert.equal(first, "first");

    // Force a re-mint and check which refresh token went over the wire.
    assert.equal(provider.invalidate("first"), true);
    const second = await provider.getToken();
    assert.equal(second, "second");

    const secondBody = new URLSearchParams(String(mock.calls[1].init.body));
    assert.equal(secondBody.get("refresh_token"), "r0tated-value");
  } finally {
    mock.restore();
  }
});

test("invalidate is compare-and-clear: a stale token keeps the fresh cache", async () => {
  const mock = mockFetch(() => okToken("current"));
  try {
    const provider = createTokenProvider(REFRESHING);
    await provider.getToken();

    // A caller that used an OLDER token reports failure; the fresh cache survives.
    assert.equal(provider.invalidate("stale-token"), true);
    assert.equal(await provider.getToken(), "current");
    assert.equal(mock.calls.length, 1, "the fresh cache must not be discarded");

    // The CURRENT token failing clears the cache → next getToken re-mints.
    assert.equal(provider.invalidate("current"), true);
    await provider.getToken();
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test("a permanent OAuth failure enters cooldown: no repeat network calls, no secrets in the message", async () => {
  const mock = mockFetch(
    () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "revoked" }), {
        status: 400,
      }),
  );
  try {
    const provider = createTokenProvider(REFRESHING);
    await assert.rejects(() => provider.getToken(), /invalid_grant/);
    const callsAfterFirst = mock.calls.length;
    assert.equal(callsAfterFirst, 1, "a permanent 4xx must not be retried internally");

    // In cooldown: rethrows the stored error without another network round-trip.
    await assert.rejects(
      () => provider.getToken(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!err.message.includes("s3cret-value"), "client secret must never leak");
        assert.ok(!err.message.includes("r3fresh-value"), "refresh token must never leak");
        return true;
      },
    );
    assert.equal(mock.calls.length, callsAfterFirst, "cooldown must serve the error from memory");
  } finally {
    mock.restore();
  }
});
