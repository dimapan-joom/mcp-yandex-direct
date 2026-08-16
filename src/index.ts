#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { YandexDirectClient } from "./client.js";
import { ConfigError, loadConfig, type LoadedConfig } from "./config.js";
import { createTokenProvider } from "./auth/tokenProvider.js";

/** Reads the package version so the server reports its real version to MCP clients. */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
import { registerAccountTools } from "./tools/account.js";
import { registerAccountsTool } from "./tools/accounts.js";
import { registerCampaignTools } from "./tools/campaigns.js";
import { registerAdGroupTools } from "./tools/adGroups.js";
import { registerAdTools } from "./tools/ads.js";
import { registerKeywordTools } from "./tools/keywords.js";
import { registerStatisticsTools } from "./tools/statistics.js";
import { registerDictionaryTools } from "./tools/dictionaries.js";
import { registerRawTool } from "./tools/raw.js";
import { registerBidModifierTools } from "./tools/bidModifiers.js";
import { registerAssetTools } from "./tools/assets.js";
import { registerMediaTools } from "./tools/media.js";
import { registerAuditTools } from "./tools/audits.js";

/**
 * The prose the calling model receives in the `initialize` result — the only text it
 * reads before it picks a tool, in every session. Cross-cutting facts only: what this
 * API is, what it refuses to do, what a call costs and which failures lie about their
 * cause. Per-tool gotchas belong in that tool's `description` (see CLAUDE.md), and
 * every line here is paid for out of the client's context, so keep it dense.
 */
const INSTRUCTIONS =
  "API Яндекс Директа v5 — это рекламный кабинет одного рекламодателя: поиск и сети, а не " +
  "веб-аналитика Метрики. Новые кампании и объявления создаются только текстовыми, но объекты " +
  "любого типа (смарт, динамические, CPM, единая перформанс-кампания) можно получать списком, " +
  "переименовывать, менять им бюджет, останавливать, архивировать и удалять по id; всё остальное — " +
  "через raw_request. Финансового сервиса нет: баланс доступен только на чтение, ни один " +
  "инструмент не двигает деньги. Каждый вызов тратит дневную квоту Units (остаток показывает " +
  "get_quota), " +
  "а get_statistics запускает асинхронную задачу в сервисе Reports со своими дневными лимитами — " +
  "запрашивать один широкий период, а не цикл по дням или кампаниям. Деньги везде в валюте " +
  "аккаунта, кроме raw_request, где они в микроединицах. Сервер обслуживает несколько рекламных " +
  "аккаунтов, и у КАЖДОГО свои ключи доступа: список алиасов отдаёт list_accounts (локально, без " +
  "запроса в API), параметр account выбирает аккаунт в каждом вызове, без него запрос уходит в " +
  "аккаунт по умолчанию. Внутри одного аккаунта агентский токен обслуживает несколько " +
  "клиентских логинов: их отдаёт list_agency_clients, и КАЖДЫЙ вызов должен явно " +
  "передавать параметр login — без него запрос уходит в аккаунт из YANDEX_DIRECT_LOGIN или в " +
  "собственный аккаунт агентства, поэтому пустой список сперва проверить на правильные account и login; " +
  "фильтр по типам без UNIFIED_CAMPAIGN скрывает актуальные " +
  "перформанс-кампании. Запись тратит реальные деньги, если не задан YANDEX_DIRECT_SANDBOX=true, " +
  "удаление необратимо, а частично неудачный пакет всё равно возвращает HTTP 200 — читать ошибки " +
  "по каждому объекту и повторять только то, что не прошло.";

/**
 * Loads the config, reporting a missing/malformed variable on stderr before the
 * process dies. An unconfigured server exits before the MCP handshake, so stderr
 * is the only place the operator ever sees the reason.
 */
function loadConfigOrExit(): LoadedConfig {
  try {
    return loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`Ошибка: ${err.message}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { config, accounts, defaultAccount } = loadConfigOrExit();
  // One provider per account: each account is its own OAuth application, so its
  // credentials must never be reused for another alias. The single-provider slot is
  // left empty — routing goes through this registry.
  const providers = accounts.map((a) => ({
    alias: a.alias,
    provider: createTokenProvider(a.auth),
    login: a.login,
  }));
  const client = new YandexDirectClient(config, undefined, providers, defaultAccount);

  const server = new McpServer(
    {
      name: "mcp-yandex-direct",
      version: readVersion(),
    },
    // Rides along in the initialize result; the SDK carries it as a ServerOption.
    { instructions: INSTRUCTIONS },
  );

  registerAccountsTool(server, client);
  registerAccountTools(server, client);
  registerCampaignTools(server, client);
  registerAdGroupTools(server, client);
  registerAdTools(server, client);
  registerKeywordTools(server, client);
  registerStatisticsTools(server, client);
  registerDictionaryTools(server, client);
  registerRawTool(server, client);
  registerBidModifierTools(server, client);
  registerAssetTools(server, client);
  registerMediaTools(server, client);
  registerAuditTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `mcp-yandex-direct работает на stdio${config.sandbox ? " (песочница)" : ""}`,
  );
}

main().catch((err) => {
  console.error("Критическая ошибка при запуске mcp-yandex-direct:", err);
  process.exit(1);
});
