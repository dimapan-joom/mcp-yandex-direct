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
  YANDEX_DIRECT_LOGIN: undefined,
  YANDEX_OAUTH_CLIENT_ID: undefined,
  YANDEX_OAUTH_CLIENT_SECRET: undefined,
  YANDEX_OAUTH_REFRESH_TOKEN: undefined,
  YANDEX_OAUTH_TOKEN_URL: undefined,
  YANDEX_DEFAULT_ACCOUNT: undefined,
  YANDEX_ACCOUNT_JOOM_CLIENT_ID: undefined,
  YANDEX_ACCOUNT_JOOM_CLIENT_SECRET: undefined,
  YANDEX_ACCOUNT_JOOM_REFRESH_TOKEN: undefined,
  YANDEX_ACCOUNT_JOOM_LOGIN: undefined,
  YANDEX_ACCOUNT_JOOM_DESCRIPTION: undefined,
  YANDEX_ACCOUNT_AYZEZE_CLIENT_ID: undefined,
  YANDEX_ACCOUNT_AYZEZE_CLIENT_SECRET: undefined,
  YANDEX_ACCOUNT_AYZEZE_REFRESH_TOKEN: undefined,
  YANDEX_ACCOUNT_DEFAULT_TOKEN: undefined,
};

/** A complete OAuth trio for one alias. */
function trio(alias: string, suffix = ""): Record<string, string> {
  return {
    [`YANDEX_ACCOUNT_${alias}_CLIENT_ID`]: `id${suffix}`,
    [`YANDEX_ACCOUNT_${alias}_CLIENT_SECRET`]: `secret${suffix}`,
    [`YANDEX_ACCOUNT_${alias}_REFRESH_TOKEN`]: `refresh${suffix}`,
  };
}

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

test("no credentials at all reports missing_token", () => {
  assert.equal(reasonOf({}), "missing_token");
});

test("the single-account form still works and becomes the 'default' account", () => {
  withEnv({ ...AUTH_ENV_CLEARED, YANDEX_DIRECT_TOKEN: "t0ken" }, () => {
    const { config, accounts, defaultAccount } = loadConfig();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].alias, "default");
    assert.deepEqual(accounts[0].auth, { kind: "static", token: "t0ken" });
    assert.equal(defaultAccount, "default");
    assert.equal(config.lang, "ru");
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
      const { config, accounts } = loadConfig();
      const auth = accounts[0].auth;
      assert.equal(auth.kind, "refreshing");
      assert.ok(auth.kind === "refreshing" && auth.tokenUrl === "https://oauth.yandex.ru/token");
      // The loggable config must carry no secrets.
      const serialized = JSON.stringify(config);
      assert.ok(!serialized.includes("s3cret"));
      assert.ok(!serialized.includes("r3fresh"));
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
      assert.equal(loadConfig().accounts[0].auth.kind, "refreshing");
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

// --- multi-account form ------------------------------------------------------

test("each account gets its OWN credentials, keyed by lowercased alias", () => {
  withEnv(
    {
      ...AUTH_ENV_CLEARED,
      ...trio("JOOM", "-joom"),
      ...trio("AYZEZE", "-ayzeze"),
      YANDEX_ACCOUNT_JOOM_LOGIN: "joom-login",
      YANDEX_ACCOUNT_JOOM_DESCRIPTION: "Основной аккаунт",
      YANDEX_DEFAULT_ACCOUNT: "joom",
    },
    () => {
      const { accounts, defaultAccount } = loadConfig();
      assert.equal(accounts.length, 2);
      const joom = accounts.find((a) => a.alias === "joom");
      const ayzeze = accounts.find((a) => a.alias === "ayzeze");
      assert.ok(joom && ayzeze, "both aliases parsed");
      // Credentials must not bleed between accounts — that would sign a call
      // for one advertiser with another advertiser's keys.
      assert.ok(joom.auth.kind === "refreshing" && joom.auth.refreshToken === "refresh-joom");
      assert.ok(ayzeze.auth.kind === "refreshing" && ayzeze.auth.refreshToken === "refresh-ayzeze");
      assert.equal(joom.login, "joom-login");
      assert.equal(joom.description, "Основной аккаунт");
      assert.equal(ayzeze.login, undefined);
      assert.equal(defaultAccount, "joom");
    },
  );
});

test("several accounts without an explicit default refuse to start", () => {
  // Guessing would send un-targeted calls — writes included — to a random account.
  assert.equal(reasonOf({ ...trio("JOOM"), ...trio("AYZEZE") }), "missing_default_account");
});

test("a default naming an unconfigured account is rejected", () => {
  assert.equal(
    reasonOf({ ...trio("JOOM"), YANDEX_DEFAULT_ACCOUNT: "typo" }),
    "unknown_default_account",
  );
});

test("a single named account needs no explicit default", () => {
  withEnv({ ...AUTH_ENV_CLEARED, ...trio("JOOM") }, () => {
    assert.equal(loadConfig().defaultAccount, "joom");
  });
});

test("a partial trio names the offending account", () => {
  let caught: unknown;
  withEnv(
    {
      ...AUTH_ENV_CLEARED,
      YANDEX_ACCOUNT_AYZEZE_CLIENT_ID: "id",
      YANDEX_ACCOUNT_AYZEZE_CLIENT_SECRET: "secret",
      // refresh token missing
    },
    () => {
      try {
        loadConfig();
      } catch (err) {
        caught = err;
      }
    },
  );
  assert.ok(caught instanceof ConfigError);
  assert.equal(caught.reason, "incomplete_oauth_credentials");
  assert.match(caught.message, /ayzeze/);
});

test("defining 'default' twice is an error, not a silent winner", () => {
  assert.equal(
    reasonOf({
      YANDEX_ACCOUNT_DEFAULT_TOKEN: "one",
      YANDEX_DIRECT_TOKEN: "two",
    }),
    "duplicate_default_account",
  );
});

test("the default account's login lands on the loggable config", () => {
  withEnv(
    {
      ...AUTH_ENV_CLEARED,
      ...trio("JOOM"),
      YANDEX_ACCOUNT_JOOM_LOGIN: "joom-login",
    },
    () => {
      assert.equal(loadConfig().config.login, "joom-login");
    },
  );
});
