import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { YandexDirectClient } from "../client.js";
import { MAX_TOP_N, parseRows } from "./statistics.aggregate.js";
import { DATE_RANGES } from "./statistics.js";
import { accountParam, compact, fail, isoDate, loginParam, normalizeMoney, ok, READ_ONLY } from "./util.js";
import {
  buildHealthReport,
  CAMPAIGN_AUDIT_FIELDS,
  computeEfficiencyAudit,
  computePacingAudit,
  computeSearchTermAudit,
  DEFAULT_CAMPAIGN_TOP_N,
  DEFAULT_EXAMPLES,
  DEFAULT_TOP_N,
  describePeriod,
  EFFICIENCY_FIELDS,
  PACING_FIELDS,
  REJECTED_AD_FIELDS,
  REJECTED_ADS_PAGE_LIMIT,
  reportParams,
  resolvePeriod,
  SEARCH_TERM_FIELDS,
  type AuditAccountFunds,
  type AuditAd,
  type AuditCampaign,
} from "./audits.compute.js";

/**
 * L4 — investigation tools: each one makes SEVERAL API calls and returns a computed
 * verdict ("что не так и где точки роста"), not a raw dump. The maths lives in
 * audits.compute.ts; this module is the API plumbing and the tool descriptions.
 *
 * A section whose source call FAILED is omitted from the answer and the reason lands
 * in `findings` — an absent section must never read as "всё в порядке".
 */

/** Shared period inputs so every audit takes the period the same way. */
const periodSchema = {
  dateRangeType: z.enum(DATE_RANGES).optional(),
  dateFrom: isoDate().optional().describe("Дата начала YYYY-MM-DD (вместе с dateTo включает CUSTOM_DATE)."),
  dateTo: isoDate().optional().describe("Дата окончания YYYY-MM-DD (обязательна вместе с dateFrom)."),
  campaignIds: z.array(z.number().int()).optional().describe("Ограничить аудит этими id кампаний."),
};

const topNSchema = (def: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(MAX_TOP_N)
    .optional()
    .describe(`Сколько строк детализации вернуть в каждой секции (максимум ${MAX_TOP_N}). По умолчанию ${def}.`);

export function registerAuditTools(server: McpServer, client: YandexDirectClient): void {
  server.registerTool(
    "audit_account_health",
    {
      title: "Аудит: здоровье аккаунта",
      annotations: READ_ONLY,
      description:
        "РАССЛЕДОВАНИЕ «что горит в аккаунте» одним вызовом: делает три запроса (campaigns/get, ads/get по отклонённым, баланс через Live v4 AccountManagement) и возвращает готовый разбор, а не сырые списки. Проверяет: запрет оплаты у кампаний (StatusPayment=DISALLOWED), отклонённые модерацией кампании и объявления вместе с причинами (StatusClarification, если API их отдал), активные кампании без дневного бюджета, остаток денег и на сколько дней его хватит при текущей сумме дневных бюджетов. Ключевое поле ответа — findings: список находок строками, отсортированный от самой опасной к информационной, его можно пересказывать как есть. ВАЖНО: если какая-то из трёх проверок не прошла (нет прав, нет единого счёта), соответствующая секция ОТСУТСТВУЕТ в ответе, а причина попадает в findings — отсутствие секции не значит «всё в порядке». Для конкретного клиента агентства обязательно передавать login.",
      inputSchema: {
        campaignIds: z.array(z.number().int()).optional().describe("Ограничить аудит этими id кампаний."),
        maxExamples: z
          .number()
          .int()
          .min(1)
          .max(MAX_TOP_N)
          .optional()
          .describe(`Сколько примеров объектов показывать в каждой секции. По умолчанию ${DEFAULT_EXAMPLES}.`),
        account: accountParam(),
        login: loginParam(),
      },
    },
    async ({ campaignIds, maxExamples, account, login }) => {
      try {
        const limit = maxExamples ?? DEFAULT_EXAMPLES;
        // campaigns/get is the backbone of the report: if it fails there is nothing to
        // audit, so this one propagates instead of degrading into an empty verdict.
        const campaignsResult = await client.call<{ Campaigns?: AuditCampaign[] }>(
          "campaigns",
          "get",
          {
            SelectionCriteria: compact({ Ids: campaignIds?.length ? campaignIds : undefined }),
            FieldNames: CAMPAIGN_AUDIT_FIELDS,
          },
          { account, login },
        );
        const campaigns = normalizeMoney(campaignsResult).Campaigns ?? [];

        // The other two probes degrade softly: a missing shared account or a field the
        // account has no rights to must not sink the whole audit.
        let rejectedAds: AuditAd[] | undefined;
        let rejectedAdsError: string | undefined;
        try {
          const adsResult = await client.call<{ Ads?: AuditAd[] }>(
            "ads",
            "get",
            {
              SelectionCriteria: compact({
                CampaignIds: campaignIds?.length ? campaignIds : undefined,
                Statuses: ["REJECTED"],
              }),
              FieldNames: REJECTED_AD_FIELDS,
              Page: { Limit: REJECTED_ADS_PAGE_LIMIT, Offset: 0 },
            },
            { account, login },
          );
          rejectedAds = adsResult.Ads ?? [];
        } catch (e) {
          rejectedAdsError = e instanceof Error ? e.message : String(e);
        }

        let funds: AuditAccountFunds[] | undefined;
        let fundsError: string | undefined;
        try {
          // Live v4 has no Client-Login header — the account is selected via Logins.
          // `account` still routes it, because it picks WHICH credentials sign the call.
          const v4 = await client.callV4<{ Accounts?: AuditAccountFunds[] }>(
            "AccountManagement",
            {
              Action: "Get",
              SelectionCriteria: login ? { Logins: [login] } : {},
            },
            { account },
          );
          funds = v4.Accounts ?? [];
        } catch (e) {
          fundsError = e instanceof Error ? e.message : String(e);
        }

        return ok(
          buildHealthReport({ campaigns, rejectedAds, rejectedAdsError, funds, fundsError, maxExamples: limit }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "audit_search_terms",
    {
      title: "Аудит: поисковые запросы",
      annotations: READ_ONLY,
      description:
        "РАССЛЕДОВАНИЕ поисковых запросов: где сливается бюджет и где точки роста. Берёт SEARCH_QUERY_PERFORMANCE_REPORT (Query, CampaignName, Impressions, Clicks, Cost, Conversions) за период и раскладывает запросы на три категории: wasted — есть расход и НОЛЬ конверсий (кандидаты в минус-слова, отсортированы по расходу), growth — есть конверсии (кандидаты на вынос в отдельные ключевые фразы, отсортированы по конверсиям), zeroClicks — показы без кликов (нерелевантное объявление или низкая позиция). В итогах — сколько денег ушло впустую и какая это доля расхода за период. Конверсии берутся агрегированно по всем целям Метрики: разрез по конкретным целям и моделям атрибуции здесь не поддерживается, для него нужен get_statistics с goals/attributionModels. Если конверсий нет ни в одной строке, инструмент явно предупреждает об этом в findings — тогда список wasted нельзя считать доказанным мусором. ALL_TIME без campaignIds отклоняется (взрыв объёма).",
      inputSchema: {
        ...periodSchema,
        dateRangeType: z
          .enum(DATE_RANGES)
          .optional()
          .describe("Период отчёта. По умолчанию LAST_30_DAYS."),
        topN: topNSchema(DEFAULT_TOP_N),
        account: accountParam(),
        login: loginParam(),
      },
    },
    async ({ dateRangeType, dateFrom, dateTo, campaignIds, topN, account, login }) => {
      try {
        const period = resolvePeriod(dateRangeType, dateFrom, dateTo, "LAST_30_DAYS");
        if (period.range === "ALL_TIME" && !campaignIds?.length) {
          return fail(
            "ALL_TIME без фильтра по кампаниям недопустим для отчёта по поисковым запросам (вернётся весь аккаунт за всё время). Передать campaignIds или ограниченный период — например LAST_30_DAYS.",
          );
        }
        const params = reportParams("SEARCH_QUERY_PERFORMANCE_REPORT", SEARCH_TERM_FIELDS, period, campaignIds);
        const tsv = await client.report(params, { account, login });
        const rows = parseRows(tsv, SEARCH_TERM_FIELDS);
        return ok(computeSearchTermAudit(rows, { topN: topN ?? DEFAULT_TOP_N, period: describePeriod(period) }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "audit_budget_pacing",
    {
      title: "Аудит: темп расходования бюджета",
      annotations: READ_ONLY,
      description:
        "РАССЛЕДОВАНИЕ темпа расхода: кто упирается в дневной бюджет, а кто его не осваивает. Делает два запроса — campaigns/get (дневные бюджеты в валюте аккаунта) и CAMPAIGN_PERFORMANCE_REPORT с разбивкой по дням — и сравнивает фактический СРЕДНЕДНЕВНОЙ расход с дневным бюджетом. Средний расход считается по числу дней, в которые кампания реально тратила, а не по длине периода: кампания, работавшая 2 дня из 30, не выглядит недоосваивающей. Вердикт по каждой кампании: at_limit (расход ≥ 90% бюджета — спрос режется, кандидат на повышение), under_pacing (≤ 50% — деньги зарезервированы, но не тратятся), normal, no_spend, no_daily_budget. У кампании без дневного бюджета темп НЕ рассчитывается (pacing отсутствует, а не равен нулю) — ограничение может стоять на общем счёте. По умолчанию период LAST_7_DAYS: длинный период раздувает отчёт (кампании × дни).",
      inputSchema: {
        ...periodSchema,
        dateRangeType: z
          .enum(DATE_RANGES)
          .optional()
          .describe("Период отчёта. По умолчанию LAST_7_DAYS."),
        topN: topNSchema(DEFAULT_CAMPAIGN_TOP_N),
        account: accountParam(),
        login: loginParam(),
      },
    },
    async ({ dateRangeType, dateFrom, dateTo, campaignIds, topN, account, login }) => {
      try {
        const period = resolvePeriod(dateRangeType, dateFrom, dateTo, "LAST_7_DAYS");
        const campaignsResult = await client.call<{ Campaigns?: AuditCampaign[] }>(
          "campaigns",
          "get",
          {
            SelectionCriteria: compact({ Ids: campaignIds?.length ? campaignIds : undefined }),
            FieldNames: ["Id", "Name", "State", "Status", "DailyBudget"],
          },
          { account, login },
        );
        const campaigns = normalizeMoney(campaignsResult).Campaigns ?? [];
        const tsv = await client.report(
          reportParams("CAMPAIGN_PERFORMANCE_REPORT", PACING_FIELDS, period, campaignIds),
          { account, login },
        );
        const rows = parseRows(tsv, PACING_FIELDS);
        return ok(
          computePacingAudit(rows, campaigns, {
            topN: topN ?? DEFAULT_CAMPAIGN_TOP_N,
            period: describePeriod(period),
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "audit_campaign_efficiency",
    {
      title: "Аудит: эффективность кампаний",
      annotations: READ_ONLY,
      description:
        "РАССЛЕДОВАНИЕ эффективности кампаний с ROAS. Берёт CAMPAIGN_PERFORMANCE_REPORT (CampaignId, CampaignName, Impressions, Clicks, Cost, Conversions, Revenue) за период и считает НА СВОЕЙ СТОРОНЕ, потому что готовых полей в API нет: ROAS = Revenue / Cost (GoalsRoi — это ROI, другое число), CPA = Cost / Conversions, CR = Conversions / Clicks. Список кампаний отсортирован по расходу. В findings попадают: кампании с расходом и нулём конверсий, кампании с ROAS ниже порога minRoas и лидеры по ROAS (куда переносить бюджет). КРИТИЧНО: если Revenue нулевой или пустой во всех строках, ROAS НЕ считается нулевым — поле roas отсутствует, revenueAvailable=false, а в findings уходит явное предупреждение, что выручка не передаётся из Метрики. Деления на ноль не происходит: неизмеримые коэффициенты (нет кликов, нет конверсий) просто отсутствуют в ответе. Конверсии и выручка берутся агрегированно по всем целям Метрики — разрез по целям и моделям атрибуции только через get_statistics.",
      inputSchema: {
        ...periodSchema,
        dateRangeType: z
          .enum(DATE_RANGES)
          .optional()
          .describe("Период отчёта. По умолчанию LAST_30_DAYS."),
        minRoas: z
          .number()
          .min(0)
          .optional()
          .describe(
            "Порог ROAS как ОТНОШЕНИЕ Revenue / Cost (например 3 = выручка втрое больше расхода), не проценты. Кампании ниже порога попадут в findings. Работает только если выручка реально передаётся.",
          ),
        topN: topNSchema(DEFAULT_CAMPAIGN_TOP_N),
        account: accountParam(),
        login: loginParam(),
      },
    },
    async ({ dateRangeType, dateFrom, dateTo, campaignIds, minRoas, topN, account, login }) => {
      try {
        const period = resolvePeriod(dateRangeType, dateFrom, dateTo, "LAST_30_DAYS");
        const tsv = await client.report(
          reportParams("CAMPAIGN_PERFORMANCE_REPORT", EFFICIENCY_FIELDS, period, campaignIds),
          { account, login },
        );
        const rows = parseRows(tsv, EFFICIENCY_FIELDS);
        return ok(
          computeEfficiencyAudit(rows, {
            topN: topN ?? DEFAULT_CAMPAIGN_TOP_N,
            period: describePeriod(period),
            minRoas,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );
}
