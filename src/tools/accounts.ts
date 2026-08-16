import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { YandexDirectClient } from "../client.js";
import { fail, ok, READ_ONLY } from "./util.js";

/**
 * The directory every other tool's `account` parameter points into.
 *
 * Purely LOCAL: the aliases come from the server's own configuration (already in
 * memory), so the tool makes no API request and spends no Units — it is safe to
 * call first in any session to find out which advertisers this server can reach.
 */
export function registerAccountsTool(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "list_accounts",
    {
      title: "Рекламные аккаунты сервера",
      annotations: READ_ONLY,
      description:
        "Перечисляет рекламные аккаунты, настроенные на этом сервере: у каждого свои ключи доступа " +
        "(отдельное OAuth-приложение), поэтому аккаунт выбирается алиасом, а не логином. Алиас из этого " +
        "списка передаётся параметром account в любой другой инструмент; вызов без account уходит в " +
        "аккаунт по умолчанию (поле defaultAccount, оно же isDefault=true). Это ЛОКАЛЬНЫЙ список из " +
        "конфигурации сервера: запрос в API Яндекс Директа не делается и баллы Units не тратятся, " +
        "поэтому вызывать его можно свободно. Не путать с list_agency_clients — тот ходит в API и " +
        "возвращает клиентские логины ОДНОГО агентского аккаунта (параметр login).",
      inputSchema: {},
    },
    async () => {
      try {
        const defaultAccount = client.defaultAccountAlias;
        return ok({
          accounts: client.accounts.map((alias) => ({ alias, isDefault: alias === defaultAccount })),
          defaultAccount,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
