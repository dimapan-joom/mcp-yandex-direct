import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRows } from "./statistics.aggregate.js";
import { registerAuditTools } from "./audits.js";
import {
  buildHealthReport,
  computeEfficiencyAudit,
  computePacingAudit,
  computeSearchTermAudit,
  div,
  renderFindings,
  reportParams,
  resolvePeriod,
  type AuditCampaign,
} from "./audits.compute.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

interface Stubs {
  report?: (params: any) => string;
  call?: (service: string, method: string, params: any) => unknown;
  callV4?: (method: string, param: any) => unknown;
}

/** Registers the audit tools against a fake server + client whose calls are stubbable. */
function harness(stubs: Stubs = {}) {
  const calls: any[] = [];
  const client = {
    report: async (params: any, opts: any) => {
      calls.push({ kind: "report", params, opts });
      return stubs.report ? stubs.report(params) : "";
    },
    call: async (service: string, method: string, params: any, login?: unknown) => {
      calls.push({ kind: "call", service, method, params, login });
      if (!stubs.call) throw new Error(`call ${service}/${method} не застаблен`);
      return stubs.call(service, method, params);
    },
    callV4: async (method: string, param: any) => {
      calls.push({ kind: "callV4", method, param });
      if (!stubs.callV4) throw new Error(`callV4 ${method} не застаблен`);
      return stubs.callV4(method, param);
    },
  };
  const tools: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerAuditTools(server as never, client as never);
  return { calls, tools };
}

const parsed = (fields: string[], tsv: string) => parseRows(tsv, fields);

// ---- numeric guards ---------------------------------------------------------

test("div returns undefined instead of Infinity/NaN when the denominator is zero", () => {
  assert.equal(div(10, 0), undefined);
  assert.equal(div(0, 0), undefined);
  assert.equal(div(10, 4), 2.5);
});

test("renderFindings sorts worst-first and keeps insertion order inside one severity", () => {
  const out = renderFindings([
    { rank: 3, text: "info" },
    { rank: 1, text: "high-1" },
    { rank: 0, text: "critical" },
    { rank: 1, text: "high-2" },
    { rank: 2, text: "medium" },
  ]);
  assert.deepEqual(out, ["critical", "high-1", "high-2", "medium", "info"]);
});

// ---- period + report plumbing ----------------------------------------------

test("resolvePeriod rejects a single date bound as ambiguous", () => {
  assert.throws(() => resolvePeriod(undefined, "2026-01-01", undefined, "LAST_30_DAYS"), /обе даты/);
  assert.throws(() => resolvePeriod("CUSTOM_DATE", undefined, undefined, "LAST_30_DAYS"), /CUSTOM_DATE/);
});

test("resolvePeriod: an explicit date pair wins over a predefined range", () => {
  const period = resolvePeriod("LAST_7_DAYS", "2026-01-01", "2026-01-31", "LAST_30_DAYS");
  assert.deepEqual(period, { range: "CUSTOM_DATE", dateFrom: "2026-01-01", dateTo: "2026-01-31" });
  assert.equal(resolvePeriod(undefined, undefined, undefined, "LAST_30_DAYS").range, "LAST_30_DAYS");
});

test("reportParams turns campaignIds into a CampaignId IN filter", () => {
  const params = reportParams("CAMPAIGN_PERFORMANCE_REPORT", ["Cost"], { range: "LAST_7_DAYS" }, [1, 2]) as any;
  assert.deepEqual(params.SelectionCriteria.Filter, [
    { Field: "CampaignId", Operator: "IN", Values: ["1", "2"] },
  ]);
  assert.equal(params.DateRangeType, "LAST_7_DAYS");
  assert.equal(params.Format, "TSV");
  const noFilter = reportParams("CAMPAIGN_PERFORMANCE_REPORT", ["Cost"], { range: "LAST_7_DAYS" }) as any;
  assert.equal("Filter" in noFilter.SelectionCriteria, false);
});

// ---- audit_campaign_efficiency: ROAS / CPA / CR -----------------------------

const EFF_FIELDS = ["CampaignId", "CampaignName", "Impressions", "Clicks", "Cost", "Conversions", "Revenue"];
// A: ROAS 4, CPA 25, CR 0.1 | B: spend, zero conversions | C: no clicks at all
const EFF_TSV = [
  "1\tA\t1000\t100\t250.00\t10\t1000.00",
  "2\tB\t500\t50\t120.00\t0\t0",
  "3\tC\t80\t0\t0\t0\t0",
].join("\n");

test("efficiency: ROAS, CPA and CR are computed on our side from Revenue/Cost/Conversions/Clicks", () => {
  const audit = computeEfficiencyAudit(parsed(EFF_FIELDS, EFF_TSV), { topN: 10, period: "LAST_30_DAYS" }) as any;
  const a = audit.campaigns.find((c: any) => c.campaignId === "1");
  assert.equal(a.roas, 4); // 1000 / 250
  assert.equal(a.cpa, 25); // 250 / 10
  assert.equal(a.cr, 0.1); // 10 / 100
  assert.equal(audit.revenueAvailable, true);
  assert.equal(audit.totals.cost, 370);
  assert.equal(audit.totals.revenue, 1000);
});

test("efficiency: unmeasurable ratios are ABSENT, never zero (no division by zero)", () => {
  const audit = computeEfficiencyAudit(parsed(EFF_FIELDS, EFF_TSV), { topN: 10, period: "LAST_30_DAYS" }) as any;
  const b = audit.campaigns.find((c: any) => c.campaignId === "2");
  assert.equal(b.roas, 0); // revenue really is 0 while other rows report revenue → a real 0
  assert.equal("cpa" in b, false, "нет конверсий → CPA не измерим");
  assert.equal(b.cr, 0);
  const c = audit.campaigns.find((c: any) => c.campaignId === "3");
  assert.equal("cr" in c, false, "нет кликов → CR не измерим");
  assert.equal("roas" in c, false, "нет расхода → ROAS не измерим");
});

test("efficiency: all-zero Revenue suppresses ROAS and raises an explicit warning first", () => {
  const tsv = ["1\tA\t1000\t100\t250.00\t10\t0", "2\tB\t500\t50\t120.00\t4\t--"].join("\n");
  const audit = computeEfficiencyAudit(parsed(EFF_FIELDS, tsv), { topN: 10, period: "LAST_30_DAYS" }) as any;
  assert.equal(audit.revenueAvailable, false);
  assert.ok(audit.campaigns.every((c: any) => !("roas" in c)), "ROAS не должен появляться");
  assert.equal("roas" in audit.totals, false);
  assert.match(audit.findings[0], /Выручка \(Revenue\) нулевая или пустая ВО ВСЕХ строках/);
  assert.match(audit.findings[0], /не рассчитан \(а не равен нулю\)/);
  // CPA/CR still work — they do not depend on revenue.
  assert.equal(audit.campaigns[0].cpa, 25);
});

test("efficiency: spend without conversions and the minRoas breach both surface in findings", () => {
  const audit = computeEfficiencyAudit(parsed(EFF_FIELDS, EFF_TSV), {
    topN: 10,
    period: "LAST_30_DAYS",
    minRoas: 5,
  }) as any;
  assert.ok(audit.findings.some((f: string) => /потратили 120 и не дали ни одной конверсии/.test(f)));
  assert.ok(audit.findings.some((f: string) => /ROAS ниже порога 5/.test(f)));
  assert.ok(audit.findings.some((f: string) => /Лидеры по ROAS/.test(f)));
  // The zero-conversion burn (HIGH) outranks the ROAS leaders line (MEDIUM).
  const burnAt = audit.findings.findIndex((f: string) => /не дали ни одной конверсии/.test(f));
  const leadersAt = audit.findings.findIndex((f: string) => /Лидеры по ROAS/.test(f));
  assert.ok(burnAt < leadersAt);
});

test("efficiency: campaigns are sorted by cost desc and capped by topN", () => {
  const audit = computeEfficiencyAudit(parsed(EFF_FIELDS, EFF_TSV), { topN: 2, period: "LAST_30_DAYS" }) as any;
  assert.equal(audit.campaigns.length, 2);
  assert.deepEqual(audit.campaigns.map((c: any) => c.campaignId), ["1", "2"]);
  assert.equal(audit.campaignsShown, 2);
  assert.equal(audit.totals.campaigns, 3);
});

test("efficiency: an empty report yields the explicit empty-slice note, not invented findings", () => {
  const audit = computeEfficiencyAudit(parsed(EFF_FIELDS, EFF_FIELDS.join("\t")), {
    topN: 10,
    period: "LAST_30_DAYS",
  }) as any;
  assert.equal(audit.totals.campaigns, 0);
  assert.equal(audit.findings.length, 1);
  assert.match(audit.findings[0], /0 строк в этом срезе/);
});

// ---- audit_search_terms: categorisation -------------------------------------

const SQ_FIELDS = ["Query", "CampaignName", "Impressions", "Clicks", "Cost", "Conversions"];
// слив: cost>0, conv=0 | точка роста: conv>0 | нулевой: показы без кликов
const SQ_TSV = [
  "купить холодильник дёшево\tA\t100\t20\t160.00\t0",
  "холодильник самсунг\tA\t200\t40\t200.00\t8",
  "ремонт холодильника\tB\t50\t5\t40.00\t0",
  "холодильник картинки\tB\t300\t0\t0\t0",
].join("\n");

test("search terms: queries split into wasted / growth / zeroClicks", () => {
  const audit = computeSearchTermAudit(parsed(SQ_FIELDS, SQ_TSV), { topN: 10, period: "LAST_30_DAYS" }) as any;
  assert.equal(audit.totals.queries, 4);
  assert.equal(audit.totals.cost, 400);
  assert.equal(audit.wasted.queries, 2);
  assert.equal(audit.wasted.cost, 200); // 160 + 40
  assert.equal(audit.wasted.shareOfCost, 0.5);
  assert.equal(audit.wasted.top[0].query, "купить холодильник дёшево"); // sorted by cost desc
  assert.equal(audit.growth.queries, 1);
  assert.equal(audit.growth.top[0].query, "холодильник самсунг");
  assert.equal(audit.zeroClicks.queries, 1);
  assert.equal(audit.zeroClicks.top[0].query, "холодильник картинки");
});

test("search terms: a zero-click query is never counted as wasted spend", () => {
  const audit = computeSearchTermAudit(parsed(SQ_FIELDS, SQ_TSV), { topN: 10, period: "LAST_30_DAYS" }) as any;
  assert.ok(!audit.wasted.top.some((q: any) => q.query === "холодильник картинки"));
  assert.equal(audit.zeroClicks.top[0].cost, 0);
  assert.equal("ctr" in audit.zeroClicks.top[0], true);
  assert.equal(audit.zeroClicks.top[0].ctr, 0);
});

test("search terms: CTR is absent when there were no impressions (no division by zero)", () => {
  const audit = computeSearchTermAudit(parsed(SQ_FIELDS, "пусто\tA\t0\t0\t0\t0"), {
    topN: 10,
    period: "LAST_30_DAYS",
  }) as any;
  assert.equal(audit.totals.queries, 1);
  assert.equal(audit.wasted.queries, 0);
  assert.equal(audit.zeroClicks.queries, 0); // 0 impressions → not a zero-click finding either
});

test("search terms: zero conversions everywhere warns BEFORE the wasted-spend line", () => {
  const tsv = ["a\tA\t100\t20\t160.00\t0", "b\tA\t50\t10\t40.00\t0"].join("\n");
  const audit = computeSearchTermAudit(parsed(SQ_FIELDS, tsv), { topN: 10, period: "LAST_30_DAYS" }) as any;
  assert.match(audit.findings[0], /Конверсий нет НИ В ОДНОЙ строке/);
  assert.match(audit.findings[0], /цели Яндекс Метрики не привязаны/);
  assert.match(audit.findings[1], /Слив: 200 потрачено на 2 запросов/);
});

test("search terms: the wasted-share percentage is reported in the finding", () => {
  const audit = computeSearchTermAudit(parsed(SQ_FIELDS, SQ_TSV), { topN: 10, period: "LAST_30_DAYS" }) as any;
  assert.ok(audit.findings.some((f: string) => /это 50% расхода за период/.test(f)));
});

// ---- audit_budget_pacing ----------------------------------------------------

const PACING_FIELDS = ["CampaignId", "CampaignName", "Date", "Cost", "Clicks", "Impressions"];
const CAMPAIGNS: AuditCampaign[] = [
  { Id: 1, Name: "AtLimit", State: "ON", DailyBudget: { Amount: 100, Mode: "STANDARD" } },
  { Id: 2, Name: "Under", State: "ON", DailyBudget: { Amount: 500, Mode: "STANDARD" } },
  { Id: 3, Name: "NoBudget", State: "ON" },
  { Id: 4, Name: "Idle", State: "ON", DailyBudget: { Amount: 300, Mode: "STANDARD" } },
];
// campaign 1 spends ~98/day over 2 days; 2 spends 100/day of a 500 budget; 3 spends without a budget.
const PACING_TSV = [
  "1\tAtLimit\t2026-01-01\t98.00\t10\t100",
  "1\tAtLimit\t2026-01-02\t98.00\t10\t100",
  "2\tUnder\t2026-01-01\t100.00\t20\t400",
  "3\tNoBudget\t2026-01-01\t70.00\t7\t90",
].join("\n");

test("pacing: average daily spend uses days that actually spent, not the period length", () => {
  const audit = computePacingAudit(parsed(PACING_FIELDS, PACING_TSV), CAMPAIGNS, {
    topN: 10,
    period: "LAST_7_DAYS",
  }) as any;
  const atLimit = audit.campaigns.find((c: any) => c.campaignId === 1);
  assert.equal(atLimit.cost, 196);
  assert.equal(atLimit.activeDays, 2);
  assert.equal(atLimit.avgDailySpend, 98);
  assert.equal(atLimit.pacing, 0.98);
  assert.equal(atLimit.verdict, "at_limit");
});

test("pacing: verdicts cover under-pacing, missing budget and no spend", () => {
  const audit = computePacingAudit(parsed(PACING_FIELDS, PACING_TSV), CAMPAIGNS, {
    topN: 10,
    period: "LAST_7_DAYS",
  }) as any;
  const byId = Object.fromEntries(audit.campaigns.map((c: any) => [c.campaignId, c]));
  assert.equal(byId[2].pacing, 0.2);
  assert.equal(byId[2].verdict, "under_pacing");
  assert.equal(byId[3].verdict, "no_daily_budget");
  assert.equal("pacing" in byId[3], false, "без дневного бюджета темп не считается");
  assert.equal(byId[4].verdict, "no_spend");
  assert.equal(byId[4].activeDays, 0);
  assert.equal("avgDailySpend" in byId[4], false, "0 активных дней → средний расход не измерим");
});

test("pacing: findings put the budget-capped campaigns above the under-pacing ones", () => {
  const audit = computePacingAudit(parsed(PACING_FIELDS, PACING_TSV), CAMPAIGNS, {
    topN: 10,
    period: "LAST_7_DAYS",
  }) as any;
  const capped = audit.findings.findIndex((f: string) => /упираются в дневной бюджет/.test(f));
  const under = audit.findings.findIndex((f: string) => /недоосваивают бюджет/.test(f));
  const noBudget = audit.findings.findIndex((f: string) => /без заданного дневного бюджета/.test(f));
  assert.ok(capped >= 0 && under > capped, "at_limit — раньше under_pacing");
  assert.ok(noBudget > capped);
  assert.equal(audit.totals.atLimit, 1);
  assert.equal(audit.totals.underPacing, 1);
});

test("pacing: report rows for campaigns outside the campaign list are counted, not silently dropped", () => {
  const tsv = `${PACING_TSV}\n99\tGhost\t2026-01-01\t10.00\t1\t10`;
  const audit = computePacingAudit(parsed(PACING_FIELDS, tsv), CAMPAIGNS, {
    topN: 10,
    period: "LAST_7_DAYS",
  }) as any;
  assert.ok(audit.findings.some((f: string) => /1 кампаний есть в отчёте, но нет в списке кампаний/.test(f)));
});

// ---- audit_account_health ---------------------------------------------------

test("health: payment block outranks moderation rejections and both reach findings", () => {
  const report = buildHealthReport({
    campaigns: [
      { Id: 1, Name: "Blocked", State: "ON", Status: "ACCEPTED", StatusPayment: "DISALLOWED" },
      { Id: 2, Name: "Rejected", State: "ON", Status: "REJECTED", StatusClarification: "нарушение" },
    ],
    rejectedAds: [{ Id: 10, CampaignId: 2, State: "ON", Status: "REJECTED", StatusClarification: "текст" }],
    funds: [{ AccountID: 7, Login: "acc", Amount: "1000", Currency: "RUB" }],
    maxExamples: 5,
  }) as any;
  assert.match(report.findings[0], /Оплата запрещена/);
  assert.ok(report.findings.some((f: string) => /Модерация отклонила 1 кампаний/.test(f)));
  assert.ok(report.findings.some((f: string) => /Модерация отклонила 1 неархивных объявлений/.test(f)));
  assert.equal(report.campaigns.payment.blocked, 1);
  assert.equal(report.campaigns.moderation.rejectedExamples[0].reason, "нарушение");
  assert.equal(report.rejectedAds.total, 1);
});

test("health: a failed probe omits its section and says so in findings (never reads as 'all clear')", () => {
  const report = buildHealthReport({
    campaigns: [{ Id: 1, Name: "A", State: "ON", DailyBudget: { Amount: 100 } }],
    rejectedAdsError: "нет прав",
    fundsError: "нет единого счёта",
    maxExamples: 5,
  }) as any;
  assert.equal("rejectedAds" in report, false);
  assert.equal("balance" in report, false);
  assert.ok(report.findings.some((f: string) => /НЕ построена: ads\/get вернул ошибку «нет прав»/.test(f)));
  assert.ok(report.findings.some((f: string) => /НЕ построена: Live v4 AccountManagement/.test(f)));
});

test("health: low balance is measured against the daily budgets of ACTIVE campaigns", () => {
  const report = buildHealthReport({
    campaigns: [
      { Id: 1, Name: "On", State: "ON", DailyBudget: { Amount: 1000 } },
      { Id: 2, Name: "Off", State: "OFF", DailyBudget: { Amount: 5000 } },
    ],
    funds: [{ AccountID: 7, Login: "acc", Amount: "1500.5", Currency: "RUB" }],
    maxExamples: 5,
  }) as any;
  assert.equal(report.campaigns.budgets.dailyBudgetActiveTotal, 1000);
  assert.equal(report.balance.accounts[0].amount, 1500.5);
  assert.equal(report.balance.accounts[0].runwayDays, 1.5);
  assert.ok(report.findings.some((f: string) => /хватит примерно на 1\.5 дн\./.test(f)));
});

test("health: a negative balance is CRITICAL and reported as debt", () => {
  const report = buildHealthReport({
    campaigns: [{ Id: 1, Name: "On", State: "ON", DailyBudget: { Amount: 100 } }],
    funds: [{ AccountID: 7, Login: "acc", Amount: "-42", Currency: "RUB" }],
    maxExamples: 5,
  }) as any;
  assert.match(report.findings[0], /денег нет/);
});

test("health: a clean account still returns a findings array, not an empty one", () => {
  const report = buildHealthReport({
    campaigns: [{ Id: 1, Name: "On", State: "ON", Status: "ACCEPTED", DailyBudget: { Amount: 100 } }],
    rejectedAds: [],
    funds: [{ AccountID: 7, Login: "acc", Amount: "100000", Currency: "RUB" }],
    maxExamples: 5,
  }) as any;
  assert.equal(report.findings.length, 1);
  assert.match(report.findings[0], /Явных проблем не найдено/);
});

// ---- handlers ---------------------------------------------------------------

test("audit_campaign_efficiency requests the campaign report with the ROAS field set", async () => {
  const { calls, tools } = harness({ report: () => `${EFF_FIELDS.join("\t")}\n${EFF_TSV}` });
  const res = await tools.audit_campaign_efficiency({ dateRangeType: "LAST_7_DAYS", login: "client1" });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].params.ReportType, "CAMPAIGN_PERFORMANCE_REPORT");
  assert.deepEqual(calls[0].params.FieldNames, EFF_FIELDS);
  assert.equal(calls[0].params.DateRangeType, "LAST_7_DAYS");
  assert.equal(calls[0].opts.login, "client1");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.audit, "campaign_efficiency");
  assert.equal(body.campaigns[0].roas, 4);
});

test("audit_search_terms refuses ALL_TIME without campaignIds and makes no request", async () => {
  const { calls, tools } = harness();
  const res = await tools.audit_search_terms({ dateRangeType: "ALL_TIME" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /ALL_TIME без фильтра по кампаниям/);
  assert.equal(calls.length, 0);
});

test("audit_search_terms rejects a single date bound before spending a Reports task", async () => {
  const { calls, tools } = harness();
  const res = await tools.audit_search_terms({ dateFrom: "2026-01-01" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /обе даты/);
  assert.equal(calls.length, 0);
});

test("audit_budget_pacing reads campaigns and a day-split report, then joins them", async () => {
  const { calls, tools } = harness({
    call: () => ({
      Campaigns: [{ Id: 1, Name: "AtLimit", State: "ON", DailyBudget: { Amount: 100_000_000 } }],
    }),
    report: () => `${PACING_FIELDS.join("\t")}\n1\tAtLimit\t2026-01-01\t98.00\t10\t100`,
  });
  const res = await tools.audit_budget_pacing({});
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].service, "campaigns");
  assert.ok(calls[1].params.FieldNames.includes("Date"), "отчёт должен быть с разбивкой по дням");
  const body = JSON.parse(res.content[0].text);
  // DailyBudget arrives in micros and must be normalised to 100 currency units.
  assert.equal(body.campaigns[0].dailyBudget, 100);
  assert.equal(body.campaigns[0].verdict, "at_limit");
});

test("audit_account_health survives failing ads/balance probes and still reports campaigns", async () => {
  const { tools } = harness({
    call: (service) => {
      if (service === "ads") throw new Error("нет прав на объявления");
      return { Campaigns: [{ Id: 1, Name: "A", State: "ON", StatusPayment: "DISALLOWED" }] };
    },
  });
  const res = await tools.audit_account_health({});
  assert.equal(res.isError, undefined);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.campaigns.total, 1);
  assert.equal("rejectedAds" in body, false);
  assert.match(body.findings[0], /Оплата запрещена/);
  assert.ok(body.findings.some((f: string) => /нет прав на объявления/.test(f)));
});

test("audit_account_health fails loudly when campaigns/get itself fails", async () => {
  const { tools } = harness({
    call: () => {
      throw new Error("токен отозван");
    },
  });
  const res = await tools.audit_account_health({});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /токен отозван/);
});

test("audit_account_health selects the agency client's account for the Live v4 balance call", async () => {
  const { calls, tools } = harness({
    call: () => ({ Campaigns: [] }),
    callV4: () => ({ Accounts: [] }),
  });
  await tools.audit_account_health({ login: "client1" });
  const v4 = calls.find((c) => c.kind === "callV4");
  assert.deepEqual(v4.param.SelectionCriteria, { Logins: ["client1"] });
  assert.equal(v4.param.Action, "Get");
});
