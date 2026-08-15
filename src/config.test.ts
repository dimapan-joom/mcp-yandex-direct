import { test } from "node:test";
import assert from "node:assert/strict";

import { ConfigError, loadConfig } from "./config.js";

/**
 * The reason codes below are the vocabulary the dashboard groups by — renaming
 * one silently splits a bar in two, so they are pinned here.
 */
function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    run();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Every auth-related variable, cleared unless the test sets it explicitly. */
const AUTH_ENV_CLEARED: Record<string, string | undefined> = {
  YANDEX_DIRECT_TOKEN: undefined,
  YANDEX_OAUTH_CLIENT_ID: undefined,
  YANDEX_OAUTH_CLIENT_SECRET: undefined,
  YANDEX_OAUTH_REFRESH_TOKEN: undefined,
  YANDEX_OAUTH_TOKEN_URL: undefined,
};

function reasonOf(vars: Record<string, string | undefined>): string {
  let caught: unknown;
  withEnv({ ...AUTH_ENV_CLEARED, ...vars }, () => {
    try {
      loadConfig();
    } catch (err) {
      caught = err;
    }
  });
  assert.ok(caught instanceof ConfigError, "config problems must throw ConfigError, not exit");
  return caught.reason;
}

test("a missing token reports missing_token", () => {
  assert.equal(reasonOf({}), "missing_token");
});

test("a configured server loads without throwing", () => {
  withEnv({ ...AUTH_ENV_CLEARED, YANDEX_DIRECT_TOKEN: "t0ken" }, () => {
    const { config, auth } = loadConfig();
    assert.equal(config.token, "t0ken");
    assert.deepEqual(auth, { kind: "static", token: "t0ken" });
  });
});

test("a complete OAuth trio selects refreshing auth and keeps the config secret-free", () => {
  withEnv(
    {
      ...AUTH_ENV_CLEARED,
      YANDEX_OAUTH_CLIENT_ID: "id",
      YANDEX_OAUTH_CLIENT_SECRET: "s3cret",
      YANDEX_OAUTH_REFRESH_TOKEN: "r3fresh",
    },
    () => {
      const { config, auth } = loadConfig();
      assert.equal(auth.kind, "refreshing");
      assert.ok(auth.kind === "refreshing" && auth.tokenUrl === "https://oauth.yandex.ru/token");
      // The loggable config must carry no secrets in refreshing mode.
      assert.equal(config.token, undefined);
      assert.ok(!JSON.stringify(config).includes("s3cret"));
      assert.ok(!JSON.stringify(config).includes("r3fresh"));
    },
  );
});

test("the OAuth trio wins over a static token", () => {
  withEnv(
    {
      ...AUTH_ENV_CLEARED,
      YANDEX_DIRECT_TOKEN: "static-token",
      YANDEX_OAUTH_CLIENT_ID: "id",
      YANDEX_OAUTH_CLIENT_SECRET: "secret",
      YANDEX_OAUTH_REFRESH_TOKEN: "refresh",
    },
    () => {
      assert.equal(loadConfig().auth.kind, "refreshing");
    },
  );
});

test("a partial OAuth trio fails loudly instead of degrading to the static token", () => {
  assert.equal(
    reasonOf({
      YANDEX_DIRECT_TOKEN: "static-token",
      YANDEX_OAUTH_CLIENT_ID: "id",
      YANDEX_OAUTH_CLIENT_SECRET: "secret",
      // refresh token missing
    }),
    "incomplete_oauth_credentials",
  );
});

test("a non-https token URL is rejected", () => {
  assert.equal(
    reasonOf({
      YANDEX_OAUTH_CLIENT_ID: "id",
      YANDEX_OAUTH_CLIENT_SECRET: "secret",
      YANDEX_OAUTH_REFRESH_TOKEN: "refresh",
      YANDEX_OAUTH_TOKEN_URL: "http://oauth.yandex.ru/token",
    }),
    "invalid_oauth_token_url",
  );
});

test("a malformed token URL is rejected", () => {
  assert.equal(
    reasonOf({
      YANDEX_OAUTH_CLIENT_ID: "id",
      YANDEX_OAUTH_CLIENT_SECRET: "secret",
      YANDEX_OAUTH_REFRESH_TOKEN: "refresh",
      YANDEX_OAUTH_TOKEN_URL: "not a url",
    }),
    "invalid_oauth_token_url",
  );
});
