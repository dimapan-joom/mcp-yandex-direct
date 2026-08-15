import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { buildPage, compact, fail, loginParam, MAX_TOOL_LIMIT, ok, READ_ONLY } from "./util.js";

const DEFAULT_FIELDS = [
  "Login",
  "ClientId",
  "ClientInfo",
  "Currency",
  "Type",
  "CountryId",
  "AccountQuality",
];

const AGENCY_CLIENT_FIELDS = ["Login", "ClientId", "ClientInfo", "Archived", "Currency", "Type"];

export function registerAccountTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "get_account_info",
    {
      title: "Данные аккаунта",
      annotations: READ_ONLY,
      description:
        "Возвращает данные текущего аккаунта рекламодателя (логин, валюта, тип, страна) через сервис `clients` Яндекс Директа.",
      inputSchema: {
        fieldNames: z
          .array(z.string())
          .optional()
          .describe("Какие поля клиента вернуть. По умолчанию — типовой набор."),
        login: loginParam(),
      },
    },
    async ({ fieldNames, login }) => {
      try {
        const result = await client.call(
          "clients",
          "get",
          { FieldNames: fieldNames?.length ? fieldNames : DEFAULT_FIELDS },
          login,
        );
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_balance",
    {
      title: "Баланс аккаунта",
      annotations: READ_ONLY,
      description:
        "Возвращает баланс общего счёта и финансовые поля (Amount, AmountAvailableForTransfer, Currency, Discount, AccountID) через устаревший сервис AccountManagement Live v4 — единственный API Яндекс Директа, который отдаёт баланс (в v5 финансового метода нет). Amount — строка в ВАЛЮТЕ АККАУНТА (не в микроединицах); отрицательный Amount означает задолженность. По умолчанию — собственный аккаунт токена; чтобы получить конкретные общие счета, передать logins.",
      inputSchema: {
        logins: z
          .array(z.string())
          .optional()
          .describe("Логины аккаунтов, по которым нужны данные. По умолчанию — собственный аккаунт токена."),
      },
    },
    async ({ logins }) => {
      try {
        // Money in Live v4 is already in currency units — do NOT normalizeMoney it.
        const result = await client.callV4("AccountManagement", {
          Action: "Get",
          SelectionCriteria: logins?.length ? { Logins: logins } : {},
        });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_quota",
    {
      title: "Квота API",
      annotations: READ_ONLY,
      description:
        "Возвращает сегодняшнюю квоту баллов API (потрачено / осталось / лимит) из заголовка Units — чтобы не упереться в дневной лимит.",
      inputSchema: {
        login: loginParam(),
      },
    },
    async ({ login }) => {
      try {
        await client.call("clients", "get", { FieldNames: ["Login"] }, login);
        const units = client.units;
        return ok(units ?? "API не вернул квоту Units.");
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_agency_clients",
    {
      title: "Клиенты агентства",
      annotations: READ_ONLY,
      description:
        "Возвращает клиентов агентства через agencyclients/get. Работает только с агентским токеном; " +
        "у прямого рекламодателя вернёт ошибку. Логины из ответа подставляются в параметр login остальных инструментов.",
      inputSchema: {
        logins: z.array(z.string()).optional().describe("Фильтр по логинам клиентов."),
        archived: z
          .enum(["YES", "NO"])
          .optional()
          .describe("Фильтр по архивности: YES — только архивные, NO — только активные. Без параметра вернутся все."),
        fieldNames: z.array(z.string()).optional().describe("Какие поля клиента вернуть. По умолчанию — типовой набор."),
        limit: z.number().int().min(1).max(MAX_TOOL_LIMIT).optional().describe("Максимум объектов на страницу."),
        offset: z.number().int().min(0).optional().describe("Смещение постраничной выдачи (сколько объектов пропустить)."),
      },
    },
    async ({ logins, archived, fieldNames, limit, offset }) => {
      try {
        const selection = compact({
          Logins: logins?.length ? logins : undefined,
          Archived: archived,
        });
        const params: Record<string, unknown> = {
          SelectionCriteria: selection,
          FieldNames: fieldNames?.length ? fieldNames : AGENCY_CLIENT_FIELDS,
        };
        const page = buildPage(limit, offset);
        if (page) params.Page = page;
        // agencyclients требует запрос БЕЗ заголовка Client-Login, поэтому login = null («явно без заголовка»).
        const result = await client.call("agencyclients", "get", params, null);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
