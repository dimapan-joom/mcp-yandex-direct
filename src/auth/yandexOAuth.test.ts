import { test } from "node:test";
import assert from "node:assert/strict";
import { exchangeRefreshToken, OAuthExchangeError } from "./yandexOAuth.js";

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
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

const PARAMS = {
  tokenUrl: "https://oauth.example.test/token",
  clientId: "the-client-id",
  clientSecret: "the-client-secret",
  refreshToken: "the-refresh-token",
  timeoutMs: 5_000,
};

test("sends a form-encoded refresh_token grant with all four fields", async () => {
  const mock = mockFetch(
    () =>
      new Response(
        JSON.stringify({ access_token: "fresh", refresh_token: "next", expires_in: 3600 }),
        { status: 200 },
      ),
  );
  try {
    const result = await exchangeRefreshToken(PARAMS);

    assert.equal(result.accessToken, "fresh");
    assert.equal(result.refreshToken, "next");
    assert.equal(result.expiresInSec, 3600);

    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].url, PARAMS.tokenUrl);
    const headers = (mock.calls[0].init.headers ?? {}) as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(mock.calls[0].init.body));
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "the-refresh-token");
    assert.equal(body.get("client_id"), "the-client-id");
    assert.equal(body.get("client_secret"), "the-client-secret");
  } finally {
    mock.restore();
  }
});

test("a malformed expires_in degrades to 0 instead of NaN", async () => {
  const mock = mockFetch(
    () =>
      new Response(JSON.stringify({ access_token: "fresh", expires_in: "soon" }), { status: 200 }),
  );
  try {
    const result = await exchangeRefreshToken(PARAMS);
    assert.equal(result.expiresInSec, 0);
    assert.equal(result.refreshToken, undefined);
  } finally {
    mock.restore();
  }
});

test("invalid_grant maps to a permanent error naming the human fix", async () => {
  const mock = mockFetch(
    () =>
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "expired" }),
        { status: 400 },
      ),
  );
  try {
    await assert.rejects(
      () => exchangeRefreshToken(PARAMS),
      (err: unknown) => {
        assert.ok(err instanceof OAuthExchangeError);
        assert.equal(err.permanent, true);
        assert.match(err.message, /invalid_grant/);
        assert.match(err.message, /повторная авторизация/i);
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});

test("a 5xx maps to a transient error", async () => {
  const mock = mockFetch(() => new Response("oops", { status: 502 }));
  try {
    await assert.rejects(
      () => exchangeRefreshToken(PARAMS),
      (err: unknown) => {
        assert.ok(err instanceof OAuthExchangeError);
        assert.equal(err.permanent, false);
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});

test("no error message ever carries the raw response body", async () => {
  // A 200 with broken JSON is the nastiest case: the body IS secret material.
  const leak = "SECRET-ACCESS-TOKEN-VALUE";
  const responses = [
    new Response(`{"access_token": "${leak}`, { status: 200 }), // truncated JSON
    new Response(JSON.stringify({ not_a_token: leak }), { status: 200 }), // no access_token
    new Response(`plain text with ${leak}`, { status: 403 }), // non-JSON error
  ];
  let i = 0;
  const mock = mockFetch(() => responses[i++]);
  try {
    for (let n = 0; n < responses.length; n++) {
      await assert.rejects(
        () => exchangeRefreshToken(PARAMS),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(
            !err.message.includes(leak),
            `error message must not embed the response body: ${err.message}`,
          );
          return true;
        },
      );
    }
  } finally {
    mock.restore();
  }
});
