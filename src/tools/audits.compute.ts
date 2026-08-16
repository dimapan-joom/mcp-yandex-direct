import { parseRows } from "./statistics.aggregate.js";
import { compact } from "./util.js";

/**
 * L4 — pure computation behind the investigation tools (src/tools/audits.ts). No network:
 * every function here takes what the API already returned and produces the verdict.
 *
 * Each audit makes SEVERAL API calls and returns a computed
 * verdict ("what is broken and where the growth is"), not a raw dump: the consumer is
 * a marketer asking "что не так", and a TSV of 4000 rows does not answer that.
 *
 * Two rules hold everywhere in this file:
 *   1. Never invent a number. A section whose source call failed is OMITTED and the
 *      reason lands in `findings` — an absent section must never read as "all clear".
 *   2. Never divide silently by zero. `div` returns undefined ("не измеримо"), because
 *      a 0 would be read as a real observation and invert the conclusion.
 */

/** One parsed report row (dimensions + metrics), as produced by parseRows. */
type ReportRow = ReturnType<typeof parseRows>[number];

// --- tuning constants (no magic numbers inline) -------------------------------

/** Spend/budget share at or above which a campaign is treated as capped by its budget. */
const NEAR_LIMIT_SHARE = 0.9;
/** Spend/budget share at or below which a campaign is treated as under-pacing. */
const UNDER_PACE_SHARE = 0.5;
/** Days of runway (balance / daily budget of active campaigns) below which we alarm. */
const RUNWAY_WARN_DAYS = 3;
/** How many objects a finding line names before it switches to "…+N". */
export const DEFAULT_EXAMPLES = 5;
/** Detail rows per category in audit_search_terms. */
export const DEFAULT_TOP_N = 20;
/** Campaign rows returned by the campaign-level audits. */
export const DEFAULT_CAMPAIGN_TOP_N = 50;
/** How many best-ROAS campaigns a finding lists as "лидеры". */
const ROAS_LEADERS = 3;
/** Page limit for the rejected-ads probe; only counts + examples are surfaced. */
export const REJECTED_ADS_PAGE_LIMIT = 1000;

// --- numeric helpers ----------------------------------------------------------

/** Rounds to `digits` decimals (money → 2, rates/ratios → 3). */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const money = (value: number): number => round(value, 2);

/**
 * Division guarded against a zero or non-finite denominator. Returns undefined —
 * NOT 0 — because "no clicks" means CR is UNMEASURABLE, while a 0 would be read as
 * a measured "converts nothing" and flip the verdict.
 */
export function div(numerator: number, denominator: number): number | undefined {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return undefined;
  }
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : undefined;
}

/** Rounds an optional number, keeping undefined ("не измеримо") intact. */
function roundOpt(value: number | undefined, digits: number): number | undefined {
  return value === undefined ? undefined : round(value, digits);
}

/** Formats a 0..1 share as a percent string for a finding line. */
function pct(share: number | undefined): string {
  return share === undefined ? "н/д" : `${round(share * 100, 1)}%`;
}

// --- findings -----------------------------------------------------------------

/** Severity ranks; findings are emitted worst-first so the model retells them in order. */
const SEVERITY = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 } as const;
type Severity = (typeof SEVERITY)[keyof typeof SEVERITY];

export interface RankedFinding {
  rank: Severity;
  text: string;
}

/**
 * Flattens ranked findings into the wire format: strings, worst first. The sort is
 * stable, so findings of equal severity keep the order the audit produced them in
 * (money problems before informational context within the same rank).
 */
export function renderFindings(items: readonly RankedFinding[]): string[] {
  return [...items].sort((a, b) => a.rank - b.rank).map((item) => item.text);
}

// --- period + report plumbing -------------------------------------------------

interface Period {
  range: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Resolves the reporting period exactly like get_statistics does: an explicit date
 * pair wins over a predefined range, and a SINGLE bound is rejected instead of
 * silently falling back to a default (which would hide the caller's mistake).
 */
export function resolvePeriod(
  dateRangeType: string | undefined,
  dateFrom: string | undefined,
  dateTo: string | undefined,
  fallback: string,
): Period {
  if ((dateFrom === undefined) !== (dateTo === undefined)) {
    throw new Error(
      "Нужно указать обе даты — dateFrom и dateTo (YYYY-MM-DD) — либо ни одной: одна граница периода неоднозначна.",
    );
  }
  if (dateFrom && dateTo) return { range: "CUSTOM_DATE", dateFrom, dateTo };
  if (dateRangeType === "CUSTOM_DATE") {
    throw new Error("Для периода CUSTOM_DATE нужны обе даты: dateFrom и dateTo (YYYY-MM-DD).");
  }
  return { range: dateRangeType ?? fallback };
}

/** Human-readable period label carried into the JSON answer. */
export function describePeriod(period: Period): string {
  return period.range === "CUSTOM_DATE" ? `${period.dateFrom}..${period.dateTo}` : period.range;
}

/** Builds a Reports request body; campaignIds become the standard CampaignId IN filter. */
export function reportParams(
  type: string,
  fields: string[],
  period: Period,
  campaignIds?: number[],
): Record<string, unknown> {
  const selection: Record<string, unknown> = {};
  if (period.range === "CUSTOM_DATE") {
    selection.DateFrom = period.dateFrom;
    selection.DateTo = period.dateTo;
  }
  if (campaignIds?.length) {
    selection.Filter = [{ Field: "CampaignId", Operator: "IN", Values: campaignIds.map(String) }];
  }
  return {
    SelectionCriteria: selection,
    FieldNames: fields,
    ReportName: `mcp-audit-${type}-${Date.now()}`,
    ReportType: type,
    DateRangeType: period.range,
    Format: "TSV",
    IncludeVAT: "YES",
    IncludeDiscount: "NO",
  };
}

/** The note every audit returns when its report came back with zero data rows. */
const EMPTY_SLICE_NOTE =
  "0 строк в этом срезе — отчёт построился, но данных за период нет. Значит, срез ПУСТОЙ, " +
  "а не отчёт недоступен или закрыт правами. Сообщить, что данных нет, и предложить " +
  "проверить период и id кампаний; не выдумывать причины.";

// =============================================================================
// 1. audit_account_health
// =============================================================================

export const CAMPAIGN_AUDIT_FIELDS = [
  "Id",
  "Name",
  "Type",
  "State",
  "Status",
  "StatusPayment",
  "StatusClarification",
  "DailyBudget",
];

export const REJECTED_AD_FIELDS = ["Id", "CampaignId", "AdGroupId", "State", "Status", "StatusClarification"];

export interface AuditCampaign {
  Id: number;
  Name?: string;
  Type?: string;
  State?: string;
  Status?: string;
  StatusPayment?: string;
  StatusClarification?: string;
  /** Amount is already in account currency units here (normalizeMoney ran on the response). */
  DailyBudget?: { Amount?: number; Mode?: string };
}

export interface AuditAd {
  Id: number;
  CampaignId?: number;
  AdGroupId?: number;
  State?: string;
  Status?: string;
  StatusClarification?: string;
}

/** Live v4 AccountManagement account row; Amount arrives as a STRING in currency units. */
export interface AuditAccountFunds {
  AccountID?: number;
  Login?: string;
  Amount?: string | number;
  Currency?: string;
}

/** Daily budget in currency units, or undefined when the campaign has none. */
function budgetOf(campaign: AuditCampaign): number | undefined {
  const amount = campaign.DailyBudget?.Amount;
  return typeof amount === "number" && Number.isFinite(amount) ? amount : undefined;
}

/** "Имя (id), Имя (id), …+N" — bounded so one finding line cannot flood the context. */
function nameList(campaigns: readonly AuditCampaign[], max: number): string {
  const shown = campaigns.slice(0, max).map((c) => `${c.Name ?? "без имени"} (${c.Id})`);
  const rest = campaigns.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, …+${rest}` : shown.join(", ");
}

function campaignSection(campaigns: readonly AuditCampaign[], maxExamples: number) {
  const byState: Record<string, number> = {};
  for (const c of campaigns) {
    const state = c.State ?? "UNKNOWN";
    byState[state] = (byState[state] ?? 0) + 1;
  }
  const paymentBlocked = campaigns.filter((c) => c.StatusPayment === "DISALLOWED");
  const rejected = campaigns.filter((c) => c.Status === "REJECTED");
  const active = campaigns.filter((c) => c.State === "ON");
  const activeNoBudget = active.filter((c) => budgetOf(c) === undefined);
  const dailyBudgetActive = money(active.reduce((sum, c) => sum + (budgetOf(c) ?? 0), 0));

  const findings: RankedFinding[] = [];
  if (paymentBlocked.length > 0) {
    findings.push({
      rank: SEVERITY.CRITICAL,
      text: `Оплата запрещена (StatusPayment=DISALLOWED) у ${paymentBlocked.length} кампаний: ${nameList(paymentBlocked, maxExamples)} — показов не будет, пока счёт не пополнен.`,
    });
  }
  if (campaigns.length > 0 && active.length === 0) {
    findings.push({
      rank: SEVERITY.HIGH,
      text: `Ни одной активной кампании (State=ON) из ${campaigns.length} — открутка полностью остановлена.`,
    });
  }
  if (rejected.length > 0) {
    findings.push({
      rank: SEVERITY.HIGH,
      text: `Модерация отклонила ${rejected.length} кампаний (Status=REJECTED): ${nameList(rejected, maxExamples)}.`,
    });
  }
  if (activeNoBudget.length > 0) {
    findings.push({
      rank: SEVERITY.MEDIUM,
      text: `У ${activeNoBudget.length} активных кампаний не задан дневной бюджет — темп их расхода не ограничен на уровне кампании (может ограничиваться общим счётом).`,
    });
  }
  if (campaigns.length === 0) {
    findings.push({
      rank: SEVERITY.INFO,
      text: "Кампаний в этом срезе нет — либо аккаунт пуст, либо неверный login/фильтр campaignIds.",
    });
  }

  const section = {
    total: campaigns.length,
    active: active.length,
    stopped: campaigns.filter((c) => c.State === "OFF" || c.State === "SUSPENDED").length,
    archived: byState.ARCHIVED ?? 0,
    byState,
    moderation: {
      rejected: rejected.length,
      onModeration: campaigns.filter((c) => c.Status === "MODERATION").length,
      drafts: campaigns.filter((c) => c.Status === "DRAFT").length,
      rejectedExamples: rejected.slice(0, maxExamples).map((c) =>
        compact({ id: c.Id, name: c.Name, reason: c.StatusClarification || undefined }),
      ),
    },
    payment: {
      blocked: paymentBlocked.length,
      blockedExamples: paymentBlocked.slice(0, maxExamples).map((c) => compact({ id: c.Id, name: c.Name })),
    },
    budgets: {
      withDailyBudget: campaigns.filter((c) => budgetOf(c) !== undefined).length,
      activeWithoutDailyBudget: activeNoBudget.length,
      dailyBudgetActiveTotal: dailyBudgetActive,
    },
  };
  return { section, findings, dailyBudgetActive };
}

function rejectedAdsSection(ads: AuditAd[] | undefined, error: string | undefined, maxExamples: number) {
  if (error !== undefined) {
    return {
      section: undefined,
      findings: [
        {
          rank: SEVERITY.MEDIUM,
          text: `Секция отклонённых объявлений НЕ построена: ads/get вернул ошибку «${error}». Это не значит, что отклонений нет — их просто не удалось проверить.`,
        },
      ] as RankedFinding[],
    };
  }
  if (!ads) return { section: undefined, findings: [] as RankedFinding[] };

  const live = ads.filter((ad) => ad.State !== "ARCHIVED");
  const withReason = live.filter((ad) => (ad.StatusClarification ?? "").trim().length > 0);
  const findings: RankedFinding[] = [];
  if (live.length > 0) {
    findings.push({
      rank: SEVERITY.HIGH,
      text: `Модерация отклонила ${live.length} неархивных объявлений — они не показываются; причины и id в секции rejectedAds.`,
    });
    if (withReason.length === 0) {
      findings.push({
        rank: SEVERITY.INFO,
        text: "Причины отклонения API не вернул (StatusClarification пуст) — смотреть их в веб-интерфейсе Директа.",
      });
    }
  }
  const section = {
    total: live.length,
    archivedSkipped: ads.length - live.length,
    withReason: withReason.length,
    examples: live.slice(0, maxExamples).map((ad) =>
      compact({
        id: ad.Id,
        campaignId: ad.CampaignId,
        adGroupId: ad.AdGroupId,
        reason: ad.StatusClarification || undefined,
      }),
    ),
  };
  return { section, findings };
}

/** Live v4 returns Amount as a string; parse it without inventing a value when absent. */
function toAmount(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function balanceSection(
  accounts: AuditAccountFunds[] | undefined,
  error: string | undefined,
  dailyBudgetActive: number,
) {
  if (error !== undefined) {
    return {
      section: undefined,
      findings: [
        {
          rank: SEVERITY.MEDIUM,
          text: `Секция баланса НЕ построена: Live v4 AccountManagement вернул ошибку «${error}» (частые причины — у аккаунта нет единого счёта или у токена нет прав на финансы). Остаток денег не проверен.`,
        },
      ] as RankedFinding[],
    };
  }
  if (!accounts || accounts.length === 0) {
    return {
      section: undefined,
      findings: [
        {
          rank: SEVERITY.INFO,
          text: "Live v4 AccountManagement не вернул ни одного счёта — секция баланса пропущена, остаток денег неизвестен.",
        },
      ] as RankedFinding[],
    };
  }

  const findings: RankedFinding[] = [];
  const rows = accounts.map((acc) => {
    const amount = toAmount(acc.Amount);
    const runwayDays = amount === undefined ? undefined : div(amount, dailyBudgetActive);
    const label = `счёт ${acc.Login ?? acc.AccountID ?? "?"}`;
    if (amount !== undefined && amount <= 0) {
      findings.push({
        rank: SEVERITY.CRITICAL,
        text: `${label}: баланс ${money(amount)} ${acc.Currency ?? ""} — денег нет (отрицательное значение = задолженность), показы остановятся или уже остановлены.`,
      });
    } else if (runwayDays !== undefined && runwayDays < RUNWAY_WARN_DAYS) {
      findings.push({
        rank: SEVERITY.HIGH,
        text: `${label}: остатка ${money(amount ?? 0)} ${acc.Currency ?? ""} хватит примерно на ${round(runwayDays, 1)} дн. при сумме дневных бюджетов активных кампаний ${dailyBudgetActive} — пополнить.`,
      });
    }
    if (amount === undefined) {
      findings.push({
        rank: SEVERITY.MEDIUM,
        text: `${label}: API не вернул поле Amount — остаток по этому счёту в отчёт не включён.`,
      });
    }
    return compact({
      accountId: acc.AccountID,
      login: acc.Login,
      currency: acc.Currency,
      amount: amount === undefined ? undefined : money(amount),
      runwayDays: roundOpt(runwayDays, 1),
    });
  });
  return { section: { accounts: rows, dailyBudgetActiveTotal: dailyBudgetActive }, findings };
}

export interface HealthInputs {
  campaigns: AuditCampaign[];
  rejectedAds?: AuditAd[];
  rejectedAdsError?: string;
  funds?: AuditAccountFunds[];
  fundsError?: string;
  maxExamples: number;
}

/** Pure assembler: takes what the three probes returned and produces the verdict. */
export function buildHealthReport(input: HealthInputs): Record<string, unknown> {
  const campaigns = campaignSection(input.campaigns, input.maxExamples);
  const ads = rejectedAdsSection(input.rejectedAds, input.rejectedAdsError, input.maxExamples);
  const balance = balanceSection(input.funds, input.fundsError, campaigns.dailyBudgetActive);
  const findings = renderFindings([...campaigns.findings, ...ads.findings, ...balance.findings]);
  return compact({
    audit: "account_health",
    campaigns: campaigns.section,
    rejectedAds: ads.section,
    balance: balance.section,
    findings: findings.length > 0 ? findings : ["Явных проблем не найдено: блокировок оплаты, отклонений модерации и нехватки денег не обнаружено."],
  });
}

// =============================================================================
// 2. audit_search_terms
// =============================================================================

export const SEARCH_TERM_FIELDS = ["Query", "CampaignName", "Impressions", "Clicks", "Cost", "Conversions"];

export interface QueryStat {
  query: string;
  campaign: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  ctr?: number;
  cpa?: number;
}

function toQueryStat(row: ReportRow): QueryStat {
  const impressions = row.m.Impressions ?? 0;
  const clicks = row.m.Clicks ?? 0;
  const cost = row.m.Cost ?? 0;
  const conversions = row.m.Conversions ?? 0;
  return compact({
    query: row.dims.Query ?? "",
    campaign: row.dims.CampaignName ?? "",
    impressions,
    clicks,
    cost: money(cost),
    conversions,
    ctr: roundOpt(div(clicks, impressions), 3),
    cpa: roundOpt(div(cost, conversions), 2),
  }) as QueryStat;
}

/** Sorts a copy by a numeric key, descending, with a secondary key for ties. */
function topBy<T>(items: readonly T[], key: (item: T) => number, tie: (item: T) => number, limit: number): T[] {
  return [...items]
    .sort((a, b) => key(b) - key(a) || tie(b) - tie(a))
    .slice(0, limit);
}

export function computeSearchTermAudit(
  rows: readonly ReportRow[],
  opts: { topN: number; period: string },
): Record<string, unknown> {
  const stats = rows.map(toQueryStat);
  const totals = {
    queries: stats.length,
    impressions: stats.reduce((s, q) => s + q.impressions, 0),
    clicks: stats.reduce((s, q) => s + q.clicks, 0),
    cost: money(stats.reduce((s, q) => s + q.cost, 0)),
    conversions: stats.reduce((s, q) => s + q.conversions, 0),
  };
  // Categories are exclusive by construction: a query with impressions but no clicks
  // spends nothing, so it cannot also be a "слив".
  const zeroClicks = stats.filter((q) => q.impressions > 0 && q.clicks === 0);
  const wasted = stats.filter((q) => q.cost > 0 && q.conversions === 0);
  const growth = stats.filter((q) => q.conversions > 0);
  const wastedCost = money(wasted.reduce((s, q) => s + q.cost, 0));
  const wastedShare = div(wastedCost, totals.cost);

  const findings: RankedFinding[] = [];
  if (stats.length === 0) {
    findings.push({ rank: SEVERITY.INFO, text: EMPTY_SLICE_NOTE });
  }
  // The zero-conversion warning MUST come before the "слив" line: without conversion
  // data every paid query looks wasted, and the wasted figure would be misread as real.
  if (stats.length > 0 && totals.conversions === 0) {
    findings.push({
      rank: SEVERITY.HIGH,
      text: "Конверсий нет НИ В ОДНОЙ строке отчёта. Это значит одно из двух: конверсий действительно не было, либо цели Яндекс Метрики не привязаны к кампаниям и Директ их не получает. Пока это не проверено, список «сливов» нельзя считать доказанным мусором — там могут быть конвертящие запросы.",
    });
  }
  if (wastedCost > 0) {
    findings.push({
      rank: SEVERITY.HIGH,
      text: `Слив: ${wastedCost} потрачено на ${wasted.length} запросов без единой конверсии — это ${pct(wastedShare)} расхода за период. Кандидаты в минус-слова в секции wasted.`,
    });
  }
  if (growth.length > 0) {
    findings.push({
      rank: SEVERITY.MEDIUM,
      text: `Точки роста: ${growth.length} запросов с конверсиями — кандидаты на вынос в отдельные ключевые фразы/группы с собственной ставкой (секция growth).`,
    });
  }
  if (zeroClicks.length > 0) {
    findings.push({
      rank: SEVERITY.MEDIUM,
      text: `${zeroClicks.length} запросов набрали показы, но ноль кликов — либо объявление нерелевантно запросу, либо позиция слишком низкая (секция zeroClicks).`,
    });
  }

  return compact({
    audit: "search_terms",
    period: opts.period,
    totals,
    wasted: {
      queries: wasted.length,
      cost: wastedCost,
      shareOfCost: roundOpt(wastedShare, 3),
      top: topBy(wasted, (q) => q.cost, (q) => q.clicks, opts.topN),
    },
    growth: {
      queries: growth.length,
      conversions: growth.reduce((s, q) => s + q.conversions, 0),
      cost: money(growth.reduce((s, q) => s + q.cost, 0)),
      top: topBy(growth, (q) => q.conversions, (q) => q.ctr ?? 0, opts.topN),
    },
    zeroClicks: {
      queries: zeroClicks.length,
      impressions: zeroClicks.reduce((s, q) => s + q.impressions, 0),
      top: topBy(zeroClicks, (q) => q.impressions, () => 0, opts.topN),
    },
    findings: renderFindings(findings),
  });
}

// =============================================================================
// 3. audit_budget_pacing
// =============================================================================

export const PACING_FIELDS = ["CampaignId", "CampaignName", "Date", "Cost", "Clicks", "Impressions"];

interface SpendAccumulator {
  name: string;
  cost: number;
  clicks: number;
  impressions: number;
  days: Set<string>;
  maxDayCost: number;
}

/** Folds day-level report rows into per-campaign spend with a real active-day count. */
function groupSpendByCampaign(rows: readonly ReportRow[]): Map<string, SpendAccumulator> {
  const byCampaign = new Map<string, SpendAccumulator>();
  for (const row of rows) {
    const id = row.dims.CampaignId ?? "";
    const acc = byCampaign.get(id) ?? {
      name: row.dims.CampaignName ?? "",
      cost: 0,
      clicks: 0,
      impressions: 0,
      days: new Set<string>(),
      maxDayCost: 0,
    };
    const dayCost = row.m.Cost ?? 0;
    acc.cost += dayCost;
    acc.clicks += row.m.Clicks ?? 0;
    acc.impressions += row.m.Impressions ?? 0;
    acc.maxDayCost = Math.max(acc.maxDayCost, dayCost);
    // Active days = days that actually SPENT. Dividing by the nominal period length
    // would understate the daily pace of a campaign that ran only part of the period.
    if (dayCost > 0 && row.dims.Date) acc.days.add(row.dims.Date);
    byCampaign.set(id, acc);
  }
  return byCampaign;
}

export interface PacingItem {
  campaignId: number;
  campaignName: string;
  state?: string;
  dailyBudget?: number;
  cost: number;
  activeDays: number;
  avgDailySpend?: number;
  maxDayCost: number;
  pacing?: number;
  verdict: "at_limit" | "under_pacing" | "normal" | "no_spend" | "no_daily_budget";
}

function toPacingItem(campaign: AuditCampaign, spend: SpendAccumulator | undefined): PacingItem {
  const cost = money(spend?.cost ?? 0);
  const activeDays = spend?.days.size ?? 0;
  const avgDailySpend = div(cost, activeDays);
  const dailyBudget = budgetOf(campaign);
  const pacing = avgDailySpend === undefined || dailyBudget === undefined
    ? undefined
    : div(avgDailySpend, dailyBudget);
  return compact({
    campaignId: campaign.Id,
    campaignName: campaign.Name ?? spend?.name ?? "",
    state: campaign.State,
    dailyBudget,
    cost,
    activeDays,
    avgDailySpend: roundOpt(avgDailySpend, 2),
    maxDayCost: money(spend?.maxDayCost ?? 0),
    pacing: roundOpt(pacing, 3),
    verdict: verdictFor(cost, dailyBudget, pacing),
  }) as PacingItem;
}

function verdictFor(cost: number, dailyBudget: number | undefined, pacing: number | undefined): PacingItem["verdict"] {
  if (dailyBudget === undefined) return "no_daily_budget";
  if (cost === 0 || pacing === undefined) return "no_spend";
  if (pacing >= NEAR_LIMIT_SHARE) return "at_limit";
  if (pacing <= UNDER_PACE_SHARE) return "under_pacing";
  return "normal";
}

export function computePacingAudit(
  rows: readonly ReportRow[],
  campaigns: readonly AuditCampaign[],
  opts: { topN: number; period: string },
): Record<string, unknown> {
  const spend = groupSpendByCampaign(rows);
  const items = campaigns.map((c) => toPacingItem(c, spend.get(String(c.Id))));
  const known = new Set(campaigns.map((c) => String(c.Id)));
  const unmatched = [...spend.keys()].filter((id) => !known.has(id)).length;

  const atLimit = items.filter((i) => i.verdict === "at_limit");
  const underPacing = items.filter((i) => i.verdict === "under_pacing");
  const spendingNoBudget = items.filter((i) => i.verdict === "no_daily_budget" && i.cost > 0);

  const findings: RankedFinding[] = [];
  if (rows.length === 0) findings.push({ rank: SEVERITY.INFO, text: EMPTY_SLICE_NOTE });
  if (atLimit.length > 0) {
    const extraCost = money(atLimit.reduce((s, i) => s + i.cost, 0));
    findings.push({
      rank: SEVERITY.HIGH,
      text: `${atLimit.length} кампаний упираются в дневной бюджет (средний дневной расход ≥ ${pct(NEAR_LIMIT_SHARE)} бюджета, суммарно ${extraCost} за период): ${atLimit.slice(0, DEFAULT_EXAMPLES).map((i) => `${i.campaignName} (${i.campaignId})`).join(", ")} — спрос обрезается бюджетом, это кандидаты на повышение.`,
    });
  }
  if (underPacing.length > 0) {
    findings.push({
      rank: SEVERITY.MEDIUM,
      text: `${underPacing.length} кампаний недоосваивают бюджет (расход ≤ ${pct(UNDER_PACE_SHARE)} от дневного): деньги зарезервированы, но не тратятся — проверить ставки, охват и минус-слова.`,
    });
  }
  if (spendingNoBudget.length > 0) {
    findings.push({
      rank: SEVERITY.MEDIUM,
      text: `${spendingNoBudget.length} кампаний тратят деньги без заданного дневного бюджета — темп для них НЕ рассчитан (pacing отсутствует, а не равен нулю).`,
    });
  }
  if (unmatched > 0) {
    findings.push({
      rank: SEVERITY.INFO,
      text: `${unmatched} кампаний есть в отчёте, но нет в списке кампаний (архив или фильтр campaignIds) — их темп не оценивался.`,
    });
  }

  return compact({
    audit: "budget_pacing",
    period: opts.period,
    thresholds: { atLimitShare: NEAR_LIMIT_SHARE, underPacingShare: UNDER_PACE_SHARE },
    totals: {
      campaigns: items.length,
      atLimit: atLimit.length,
      underPacing: underPacing.length,
      withoutDailyBudget: items.filter((i) => i.verdict === "no_daily_budget").length,
      noSpend: items.filter((i) => i.verdict === "no_spend").length,
      cost: money(items.reduce((s, i) => s + i.cost, 0)),
    },
    campaigns: topBy(items, (i) => i.cost, (i) => i.pacing ?? 0, opts.topN),
    findings: renderFindings(findings),
  });
}

// =============================================================================
// 4. audit_campaign_efficiency
// =============================================================================

export const EFFICIENCY_FIELDS = [
  "CampaignId",
  "CampaignName",
  "Impressions",
  "Clicks",
  "Cost",
  "Conversions",
  "Revenue",
];

export interface CampaignEfficiency {
  campaignId: string;
  campaignName: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  revenue: number;
  roas?: number;
  cpa?: number;
  cr?: number;
}

/**
 * Direct has no ROAS field — it is computed here as Revenue / Cost (GoalsRoi is ROI,
 * a different number). `revenueReported` gates ROAS: with revenue missing account-wide,
 * a 0 would masquerade as "кампания не окупается" instead of "выручка не передаётся".
 */
function toEfficiency(row: ReportRow, revenueReported: boolean): CampaignEfficiency {
  const clicks = row.m.Clicks ?? 0;
  const cost = row.m.Cost ?? 0;
  const conversions = row.m.Conversions ?? 0;
  const revenue = row.m.Revenue ?? 0;
  return compact({
    campaignId: row.dims.CampaignId ?? "",
    campaignName: row.dims.CampaignName ?? "",
    impressions: row.m.Impressions ?? 0,
    clicks,
    cost: money(cost),
    conversions,
    revenue: money(revenue),
    roas: revenueReported ? roundOpt(div(revenue, cost), 3) : undefined,
    cpa: roundOpt(div(cost, conversions), 2),
    cr: roundOpt(div(conversions, clicks), 3),
  }) as CampaignEfficiency;
}

/** Revenue arrives as an empty cell / "--" (→ 0) when Metrika sends no goal value. */
function hasRevenue(rows: readonly ReportRow[]): boolean {
  return rows.some((row) => (row.m.Revenue ?? 0) > 0);
}

function efficiencyFindings(
  items: readonly CampaignEfficiency[],
  revenueReported: boolean,
  minRoas: number | undefined,
): RankedFinding[] {
  const findings: RankedFinding[] = [];
  if (items.length === 0) {
    findings.push({ rank: SEVERITY.INFO, text: EMPTY_SLICE_NOTE });
    return findings;
  }
  if (!revenueReported) {
    findings.push({
      rank: SEVERITY.HIGH,
      text: "Выручка (Revenue) нулевая или пустая ВО ВСЕХ строках отчёта, поэтому ROAS не рассчитан (а не равен нулю). Обычная причина — в Яндекс Метрике у целей не задана ценность или доход не передаётся в Директ; пока это не починено, оценивать кампании по ROAS нельзя, используйте CPA и CR.",
    });
  }
  const noConversions = items.filter((i) => i.cost > 0 && i.conversions === 0);
  if (noConversions.length > 0) {
    const burned = money(noConversions.reduce((s, i) => s + i.cost, 0));
    findings.push({
      rank: SEVERITY.HIGH,
      text: `${noConversions.length} кампаний потратили ${burned} и не дали ни одной конверсии: ${noConversions.slice(0, DEFAULT_EXAMPLES).map((i) => `${i.campaignName} (${i.campaignId})`).join(", ")}.`,
    });
  }
  if (revenueReported && minRoas !== undefined) {
    const below = items.filter((i) => i.roas !== undefined && i.roas < minRoas);
    if (below.length > 0) {
      findings.push({
        rank: SEVERITY.HIGH,
        text: `${below.length} кампаний с ROAS ниже порога ${minRoas}: ${below.slice(0, DEFAULT_EXAMPLES).map((i) => `${i.campaignName} (${i.campaignId}) — ROAS ${i.roas}`).join(", ")}.`,
      });
    }
  }
  if (revenueReported) {
    const leaders = topBy(items.filter((i) => (i.roas ?? 0) > 0), (i) => i.roas ?? 0, (i) => i.cost, ROAS_LEADERS);
    if (leaders.length > 0) {
      findings.push({
        rank: SEVERITY.MEDIUM,
        text: `Лидеры по ROAS: ${leaders.map((i) => `${i.campaignName} (${i.campaignId}) — ROAS ${i.roas}, расход ${i.cost}`).join("; ")} — точка роста, сюда можно переносить бюджет.`,
      });
    }
  }
  return findings;
}

export function computeEfficiencyAudit(
  rows: readonly ReportRow[],
  opts: { topN: number; period: string; minRoas?: number },
): Record<string, unknown> {
  const revenueReported = hasRevenue(rows);
  const items = rows.map((row) => toEfficiency(row, revenueReported));
  const totals = {
    campaigns: items.length,
    impressions: items.reduce((s, i) => s + i.impressions, 0),
    clicks: items.reduce((s, i) => s + i.clicks, 0),
    cost: money(items.reduce((s, i) => s + i.cost, 0)),
    conversions: items.reduce((s, i) => s + i.conversions, 0),
    revenue: money(items.reduce((s, i) => s + i.revenue, 0)),
  };
  return compact({
    audit: "campaign_efficiency",
    period: opts.period,
    revenueAvailable: revenueReported,
    totals: compact({
      ...totals,
      roas: revenueReported ? roundOpt(div(totals.revenue, totals.cost), 3) : undefined,
      cpa: roundOpt(div(totals.cost, totals.conversions), 2),
      cr: roundOpt(div(totals.conversions, totals.clicks), 3),
    }),
    campaignsShown: Math.min(items.length, opts.topN),
    campaigns: topBy(items, (i) => i.cost, (i) => i.conversions, opts.topN),
    findings: renderFindings(efficiencyFindings(items, revenueReported, opts.minRoas)),
  });
}
