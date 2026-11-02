import YahooFinance from 'yahoo-finance2';
import { logger } from '../../../utils/logger.js';

// yahoo-finance2 v3 requires instantiation (v2 exported a singleton).
// Suppress both the one-time survey notice and the fundamentals-degradation
// warning: we already use fundamentalsTimeSeries for the affected fields.
const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
} as unknown as ConstructorParameters<typeof YahooFinance>[0]);

// Yahoo historically sometimes returns numeric fields as {raw, fmt, longFmt}
// objects. Recent versions already unwrap to plain numbers/strings, but we
// normalize defensively because the shape is version-sensitive.
function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && 'raw' in (value as Record<string, unknown>)) {
    return (value as { raw: unknown }).raw;
  }
  return value;
}

function num(value: unknown): number | null {
  const v = unwrap(value);
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dateStr(value: unknown): string | null {
  const v = unwrap(value);
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    // Yahoo sometimes returns seconds-since-epoch
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof v === 'string') {
    const parsed = new Date(v);
    return isNaN(parsed.getTime()) ? v.slice(0, 10) : parsed.toISOString().slice(0, 10);
  }
  return null;
}

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// quoteSummary helper with graceful module fallback
// ---------------------------------------------------------------------------

type QuoteSummaryModule =
  | 'assetProfile'
  | 'summaryDetail'
  | 'price'
  | 'financialData'
  | 'defaultKeyStatistics'
  | 'incomeStatementHistory'
  | 'incomeStatementHistoryQuarterly'
  | 'balanceSheetHistory'
  | 'balanceSheetHistoryQuarterly'
  | 'cashflowStatementHistory'
  | 'cashflowStatementHistoryQuarterly'
  | 'earnings'
  | 'earningsHistory'
  | 'earningsTrend'
  | 'calendarEvents'
  | 'insiderTransactions'
  | 'recommendationTrend'
  | 'secFilings';

async function quoteSummary(
  ticker: string,
  modules: QuoteSummaryModule[],
): Promise<Record<string, unknown>> {
  try {
    const result = await yahooFinance.quoteSummary(ticker, { modules });
    return (result ?? {}) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[Yahoo Finance] quoteSummary(${ticker}, [${modules.join(',')}]) — ${message}`);
    throw new Error(`[Yahoo Finance] quoteSummary failed for ${ticker}: ${message}`);
  }
}

function summaryUrl(ticker: string): string {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`;
}

// ---------------------------------------------------------------------------
// Fundamentals — income / balance / cashflow
//
// Yahoo's quoteSummary financial statement modules (incomeStatementHistory
// etc.) have been heavily degraded since Nov 2024 — most line items return
// zeros. We use `fundamentalsTimeSeries` instead, which Yahoo actively
// maintains. The raw series has one row per period-end date with prefixed
// field names (e.g. `annualTotalRevenue`); we rename to the FinancialDatasets-
// style keys the formatters expect.
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function applyDateFilters(
  rows: Rec[],
  filters: { gt?: string; gte?: string; lt?: string; lte?: string },
): Rec[] {
  return rows.filter((row) => {
    const period = typeof row.report_period === 'string' ? row.report_period : null;
    if (!period) return true;
    if (filters.gt && !(period > filters.gt)) return false;
    if (filters.gte && !(period >= filters.gte)) return false;
    if (filters.lt && !(period < filters.lt)) return false;
    if (filters.lte && !(period <= filters.lte)) return false;
    return true;
  });
}

interface FundamentalsOptions {
  ticker: string;
  period: 'annual' | 'quarterly' | 'ttm';
  limit: number;
  report_period_gt?: string;
  report_period_gte?: string;
  report_period_lt?: string;
  report_period_lte?: string;
}

type FTSModule = 'financials' | 'balance-sheet' | 'cash-flow';

const INCOME_FIELDS = [
  'TotalRevenue',
  'CostOfRevenue',
  'GrossProfit',
  'OperatingExpense',
  'OperatingIncome',
  'InterestExpense',
  'TaxProvision',
  'NetIncome',
  'EBIT',
  'EBITDA',
  'ResearchAndDevelopment',
  'SellingGeneralAndAdministration',
  'BasicEPS',
  'DilutedEPS',
] as const;

const BALANCE_FIELDS = [
  'TotalAssets',
  'TotalLiabilitiesNetMinorityInterest',
  'StockholdersEquity',
  'CashAndCashEquivalents',
  'CashCashEquivalentsAndShortTermInvestments',
  'Receivables',
  'Inventory',
  'CurrentAssets',
  'CurrentLiabilities',
  'LongTermDebt',
  'CurrentDebt',
  'TotalDebt',
  'Goodwill',
  'GoodwillAndOtherIntangibleAssets',
  'RetainedEarnings',
  'ShareIssued',
] as const;

const CASHFLOW_FIELDS = [
  'OperatingCashFlow',
  'CapitalExpenditure',
  'FreeCashFlow',
  'InvestingCashFlow',
  'FinancingCashFlow',
  'CashDividendsPaid',
  'RepurchaseOfCapitalStock',
  'IssuanceOfDebt',
  'RepaymentOfDebt',
] as const;

function prefixFor(period: 'annual' | 'quarterly' | 'ttm'): 'annual' | 'quarterly' | 'trailing' {
  if (period === 'quarterly') return 'quarterly';
  if (period === 'ttm') return 'trailing';
  return 'annual';
}

// yahoo-finance2's wrapper around fundamentalsTimeSeries only accepts
// bare period-type strings ("annual"/"quarterly"/"trailing") and returns a
// small default field set — not enough to build full statements. We bypass
// the wrapper and hit Yahoo's public timeseries endpoint directly so we can
// request the specific fields we need.
const YAHOO_TIMESERIES_BASE =
  'https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries';

interface YahooTimeseriesPoint {
  asOfDate?: string;
  periodType?: string;
  reportedValue?: { raw?: number };
}

async function fundamentalsSeries(
  ticker: string,
  period: 'annual' | 'quarterly' | 'ttm',
  _module: FTSModule,
  fields: readonly string[],
): Promise<Rec[]> {
  const prefix = prefixFor(period);
  const prefixedFields = fields.map((f) => `${prefix}${f}`);
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - 60 * 60 * 24 * 365 * 12;
  const url = new URL(`${YAHOO_TIMESERIES_BASE}/${encodeURIComponent(ticker)}`);
  url.searchParams.set('symbol', ticker);
  url.searchParams.set('type', prefixedFields.join(','));
  url.searchParams.set('period1', String(period1));
  url.searchParams.set('period2', String(period2));

  let payload: unknown;
  try {
    const response = await fetch(url.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DexterAgent/1.0)' },
    });
    if (!response.ok) {
      logger.error(
        `[Yahoo Finance] timeseries(${ticker}, ${period}) — ${response.status} ${response.statusText}`,
      );
      return [];
    }
    payload = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[Yahoo Finance] timeseries(${ticker}, ${period}) — ${message}`);
    return [];
  }

  const results =
    ((payload as Rec | undefined)?.timeseries as Rec | undefined)?.result;
  if (!Array.isArray(results)) return [];

  // Yahoo returns one `result` entry per field. We collapse them into
  // per-period rows keyed by `asOfDate`.
  const byDate = new Map<string, Rec>();
  for (const entry of results as Rec[]) {
    for (const field of prefixedFields) {
      const points = entry[field];
      if (!Array.isArray(points)) continue;
      for (const point of points as YahooTimeseriesPoint[]) {
        const asOf = point?.asOfDate;
        if (!asOf) continue;
        const row = byDate.get(asOf) ?? { date: asOf };
        row[field] = point.reportedValue?.raw ?? null;
        byDate.set(asOf, row);
      }
    }
  }

  return Array.from(byDate.values());
}

function seriesToRows(
  series: Rec[],
  fields: readonly string[],
  prefix: 'annual' | 'quarterly' | 'trailing',
  rename: Record<string, string>,
): Rec[] {
  return series
    .map((row) => {
      const period = typeof row.date === 'string' ? row.date : dateStr(row.date);
      if (!period) return null;
      const out: Rec = {
        report_period: period,
        fiscal_year: Number(period.slice(0, 4)),
      };
      for (const field of fields) {
        const raw = row[`${prefix}${field}`];
        const key = rename[field] ?? field.charAt(0).toLowerCase() + field.slice(1);
        out[key] = num(raw);
      }
      return out;
    })
    .filter((r): r is Rec => r !== null)
    // Sort newest-first so [0] is the most recent period.
    .sort((a, b) => String(b.report_period).localeCompare(String(a.report_period)));
}

const INCOME_RENAME: Record<string, string> = {
  TotalRevenue: 'revenue',
  CostOfRevenue: 'cost_of_revenue',
  GrossProfit: 'gross_profit',
  OperatingExpense: 'operating_expenses',
  OperatingIncome: 'operating_income',
  InterestExpense: 'interest_expense',
  TaxProvision: 'income_tax_expense',
  NetIncome: 'net_income',
  EBIT: 'ebit',
  EBITDA: 'ebitda',
  ResearchAndDevelopment: 'research_and_development',
  SellingGeneralAndAdministration: 'selling_general_and_administrative',
  BasicEPS: 'basic_earnings_per_share',
  DilutedEPS: 'earnings_per_share',
};

const BALANCE_RENAME: Record<string, string> = {
  TotalAssets: 'total_assets',
  TotalLiabilitiesNetMinorityInterest: 'total_liabilities',
  StockholdersEquity: 'shareholders_equity',
  CashAndCashEquivalents: 'cash_and_equivalents',
  CashCashEquivalentsAndShortTermInvestments: 'cash_and_short_term_investments',
  Receivables: 'receivables',
  Inventory: 'inventory',
  CurrentAssets: 'current_assets',
  CurrentLiabilities: 'current_liabilities',
  LongTermDebt: 'long_term_debt',
  CurrentDebt: 'short_term_debt',
  TotalDebt: 'total_debt',
  Goodwill: 'goodwill',
  GoodwillAndOtherIntangibleAssets: 'intangible_assets',
  RetainedEarnings: 'retained_earnings',
  ShareIssued: 'shares_issued',
};

const CASHFLOW_RENAME: Record<string, string> = {
  OperatingCashFlow: 'operating_cash_flow',
  CapitalExpenditure: 'capital_expenditure',
  FreeCashFlow: 'free_cash_flow',
  InvestingCashFlow: 'net_cash_flow_from_investing',
  FinancingCashFlow: 'net_cash_flow_from_financing',
  CashDividendsPaid: 'dividends_and_other_cash_distributions',
  RepurchaseOfCapitalStock: 'stock_repurchases',
  IssuanceOfDebt: 'issuance_of_debt',
  RepaymentOfDebt: 'repayment_of_debt',
};

export async function fetchIncomeStatements(
  opts: FundamentalsOptions,
): Promise<{ data: { income_statements: Rec[] }; url: string }> {
  const ticker = normalizeTicker(opts.ticker);
  const series = await fundamentalsSeries(ticker, opts.period, 'financials', INCOME_FIELDS);
  const rows = seriesToRows(series, INCOME_FIELDS, prefixFor(opts.period), INCOME_RENAME);
  const filtered = applyDateFilters(rows, {
    gt: opts.report_period_gt,
    gte: opts.report_period_gte,
    lt: opts.report_period_lt,
    lte: opts.report_period_lte,
  }).slice(0, opts.limit);
  return { data: { income_statements: filtered }, url: summaryUrl(ticker) };
}

export async function fetchBalanceSheets(
  opts: FundamentalsOptions,
): Promise<{ data: { balance_sheets: Rec[] }; url: string }> {
  const ticker = normalizeTicker(opts.ticker);
  const series = await fundamentalsSeries(ticker, opts.period, 'balance-sheet', BALANCE_FIELDS);
  const rows = seriesToRows(series, BALANCE_FIELDS, prefixFor(opts.period), BALANCE_RENAME);
  const filtered = applyDateFilters(rows, {
    gt: opts.report_period_gt,
    gte: opts.report_period_gte,
    lt: opts.report_period_lt,
    lte: opts.report_period_lte,
  }).slice(0, opts.limit);
  return { data: { balance_sheets: filtered }, url: summaryUrl(ticker) };
}

export async function fetchCashFlowStatements(
  opts: FundamentalsOptions,
): Promise<{ data: { cash_flow_statements: Rec[] }; url: string }> {
  const ticker = normalizeTicker(opts.ticker);
  const series = await fundamentalsSeries(ticker, opts.period, 'cash-flow', CASHFLOW_FIELDS);
  const rows = seriesToRows(series, CASHFLOW_FIELDS, prefixFor(opts.period), CASHFLOW_RENAME);
  // Preserve the alternate field name the formatters look for.
  for (const r of rows) {
    if (r.operating_cash_flow !== undefined) {
      r.net_cash_flow_from_operations = r.operating_cash_flow;
    }
  }
  const filtered = applyDateFilters(rows, {
    gt: opts.report_period_gt,
    gte: opts.report_period_gte,
    lt: opts.report_period_lt,
    lte: opts.report_period_lte,
  }).slice(0, opts.limit);
  return { data: { cash_flow_statements: filtered }, url: summaryUrl(ticker) };
}

export async function fetchAllFinancials(
  opts: FundamentalsOptions,
): Promise<{
  data: { financials: { income_statements: Rec[]; balance_sheets: Rec[]; cash_flow_statements: Rec[] } };
  url: string;
}> {
  const [income, balance, cash] = await Promise.all([
    fetchIncomeStatements(opts),
    fetchBalanceSheets(opts),
    fetchCashFlowStatements(opts),
  ]);
  return {
    data: {
      financials: {
        income_statements: income.data.income_statements,
        balance_sheets: balance.data.balance_sheets,
        cash_flow_statements: cash.data.cash_flow_statements,
      },
    },
    url: summaryUrl(normalizeTicker(opts.ticker)),
  };
}

// ---------------------------------------------------------------------------
// Key ratios — snapshot + historical
// ---------------------------------------------------------------------------

export async function fetchKeyRatiosSnapshot(ticker: string): Promise<{
  data: { snapshot: Rec };
  url: string;
}> {
  const t = normalizeTicker(ticker);
  const summary = await quoteSummary(t, [
    'summaryDetail',
    'financialData',
    'defaultKeyStatistics',
    'price',
  ]);
  const summaryDetail = (summary.summaryDetail ?? {}) as Rec;
  const financialData = (summary.financialData ?? {}) as Rec;
  const keyStats = (summary.defaultKeyStatistics ?? {}) as Rec;
  const price = (summary.price ?? {}) as Rec;

  const snapshot: Rec = {
    ticker: t,
    market_cap: num(price.marketCap ?? summaryDetail.marketCap),
    enterprise_value: num(keyStats.enterpriseValue),
    pe_ratio: num(summaryDetail.trailingPE ?? keyStats.trailingPE),
    forward_pe_ratio: num(summaryDetail.forwardPE ?? keyStats.forwardPE),
    pb_ratio: num(keyStats.priceToBook),
    ps_ratio: num(keyStats.priceToSalesTrailing12Months ?? summaryDetail.priceToSalesTrailing12Months),
    peg_ratio: num(keyStats.pegRatio),
    ev_to_ebitda: num(keyStats.enterpriseToEbitda),
    ev_to_revenue: num(keyStats.enterpriseToRevenue),
    eps: num(keyStats.trailingEps),
    forward_eps: num(keyStats.forwardEps),
    book_value_per_share: num(keyStats.bookValue),
    beta: num(keyStats.beta ?? summaryDetail.beta),
    gross_margin: num(financialData.grossMargins),
    operating_margin: num(financialData.operatingMargins),
    net_margin: num(financialData.profitMargins ?? keyStats.profitMargins),
    revenue_growth_rate: num(financialData.revenueGrowth),
    earnings_growth_rate: num(financialData.earningsGrowth),
    earnings_quarterly_growth: num(keyStats.earningsQuarterlyGrowth),
    roe: num(financialData.returnOnEquity),
    roa: num(financialData.returnOnAssets),
    debt_to_equity: num(financialData.debtToEquity),
    current_ratio: num(financialData.currentRatio),
    quick_ratio: num(financialData.quickRatio),
    dividend_yield: num(summaryDetail.dividendYield),
    payout_ratio: num(summaryDetail.payoutRatio),
    total_cash: num(financialData.totalCash),
    total_debt: num(financialData.totalDebt),
    total_revenue: num(financialData.totalRevenue),
    ebitda: num(financialData.ebitda),
    free_cash_flow: num(financialData.freeCashflow),
    operating_cash_flow: num(financialData.operatingCashflow),
    shares_outstanding: num(keyStats.sharesOutstanding),
    fifty_two_week_high: num(summaryDetail.fiftyTwoWeekHigh),
    fifty_two_week_low: num(summaryDetail.fiftyTwoWeekLow),
  };

  return { data: { snapshot }, url: summaryUrl(t) };
}

// Historical ratios require computation from historical statements.
// We approximate by deriving margins/growth from income statements.
export async function fetchHistoricalKeyRatios(opts: {
  ticker: string;
  period: 'annual' | 'quarterly' | 'ttm';
  limit: number;
}): Promise<{ data: { financial_metrics: Rec[] }; url: string }> {
  const ticker = normalizeTicker(opts.ticker);
  const period = opts.period === 'ttm' ? 'annual' : opts.period;
  const { data: incomeData } = await fetchIncomeStatements({
    ticker,
    period,
    limit: opts.limit,
  });
  const rows = incomeData.income_statements;

  const metrics: Rec[] = rows.map((row, i) => {
    const revenue = num(row.revenue);
    const gross = num(row.gross_profit);
    const op = num(row.operating_income);
    const net = num(row.net_income);
    const eps = num(row.earnings_per_share);
    const prevRevenue = num(rows[i + 1]?.revenue);
    const prevNet = num(rows[i + 1]?.net_income);

    return {
      report_period: row.report_period,
      fiscal_year: row.fiscal_year,
      revenue,
      net_income: net,
      eps,
      gross_margin: revenue && gross !== null ? gross / revenue : null,
      operating_margin: revenue && op !== null ? op / revenue : null,
      net_margin: revenue && net !== null ? net / revenue : null,
      revenue_growth_rate: prevRevenue && revenue !== null ? revenue / prevRevenue - 1 : null,
      earnings_growth_rate: prevNet && net !== null ? net / prevNet - 1 : null,
    };
  });

  return { data: { financial_metrics: metrics }, url: summaryUrl(ticker) };
}

// ---------------------------------------------------------------------------
// Analyst estimates
// ---------------------------------------------------------------------------

export async function fetchAnalystEstimates(opts: {
  ticker: string;
  period: 'annual' | 'quarterly';
}): Promise<{ data: { analyst_estimates: Rec[] }; url: string }> {
  const ticker = normalizeTicker(opts.ticker);
  const summary = await quoteSummary(ticker, ['earningsTrend']);
  const trend = (summary.earningsTrend as Rec | undefined)?.trend as Rec[] | undefined;

  if (!trend || trend.length === 0) {
    return { data: { analyst_estimates: [] }, url: summaryUrl(ticker) };
  }

  // Yahoo period codes: 0q (current quarter), +1q (next quarter), 0y (current year), +1y (next year)
  const wantedPrefix = opts.period === 'quarterly' ? 'q' : 'y';
  const relevant = trend.filter((t) => {
    const code = String(t.period ?? '');
    return code.endsWith(wantedPrefix);
  });

  const estimates: Rec[] = relevant.map((t) => {
    const earnings = (t.earningsEstimate ?? {}) as Rec;
    const revenue = (t.revenueEstimate ?? {}) as Rec;
    return {
      report_period: dateStr(t.endDate) ?? null,
      period_code: t.period,
      estimated_revenue_avg: num(revenue.avg),
      estimated_revenue_low: num(revenue.low),
      estimated_revenue_high: num(revenue.high),
      estimated_eps_avg: num(earnings.avg),
      estimated_eps_low: num(earnings.low),
      estimated_eps_high: num(earnings.high),
      number_of_analysts: num(earnings.numberOfAnalysts),
      growth: num(earnings.growth),
    };
  });

  return { data: { analyst_estimates: estimates }, url: summaryUrl(ticker) };
}

// ---------------------------------------------------------------------------
// Earnings snapshot
// ---------------------------------------------------------------------------

export async function fetchEarnings(ticker: string): Promise<{
  data: { earnings: Rec };
  url: string;
}> {
  const t = normalizeTicker(ticker);
  const summary = await quoteSummary(t, ['earnings', 'earningsHistory', 'financialData']);
  const earnings = (summary.earnings as Rec | undefined) ?? {};
  const history = ((summary.earningsHistory as Rec | undefined)?.history as Rec[] | undefined) ?? [];
  const financial = (summary.financialData as Rec | undefined) ?? {};

  const mostRecent: Rec = (history[history.length - 1] ?? {}) as Rec;

  const actualEps = num(mostRecent.epsActual);
  const estimateEps = num(mostRecent.epsEstimate);

  const snapshot: Rec = {
    ticker: t,
    report_period: dateStr(mostRecent.quarter) ?? null,
    revenue: num(financial.totalRevenue),
    eps: actualEps,
    eps_estimate: estimateEps,
    eps_surprise:
      actualEps !== null && estimateEps !== null && estimateEps !== 0
        ? (actualEps - estimateEps) / Math.abs(estimateEps)
        : null,
    surprise_percent: num(mostRecent.surprisePercent),
    earnings_date: dateStr((earnings as Rec)?.earningsChart ?? null),
  };

  return { data: { earnings: snapshot }, url: summaryUrl(t) };
}

// ---------------------------------------------------------------------------
// Insider trades
// ---------------------------------------------------------------------------

export async function fetchInsiderTrades(opts: {
  ticker: string;
  limit: number;
  filing_date?: string;
  filing_date_gt?: string;
  filing_date_gte?: string;
  filing_date_lt?: string;
  filing_date_lte?: string;
  name?: string;
}): Promise<{ data: { insider_trades: Rec[] }; url: string }> {
  const ticker = normalizeTicker(opts.ticker);
  const summary = await quoteSummary(ticker, ['insiderTransactions']);
  const transactions =
    ((summary.insiderTransactions as Rec | undefined)?.transactions as Rec[] | undefined) ?? [];

  let rows: Rec[] = transactions.map((t) => {
    const startDate = dateStr(t.startDate);
    return {
      full_name: t.filerName ?? null,
      officer_title: t.filerRelation ?? null,
      transaction_type: t.transactionText ?? null,
      shares: num(t.shares),
      price_per_share: num(t.value)
        && num(t.shares)
        ? (num(t.value) as number) / (num(t.shares) as number)
        : null,
      transaction_value: num(t.value),
      filing_date: startDate,
      transaction_date: startDate,
    };
  });

  if (opts.filing_date) rows = rows.filter((r) => r.filing_date === opts.filing_date);
  if (opts.filing_date_gt) rows = rows.filter((r) => (r.filing_date as string | null) && (r.filing_date as string) > opts.filing_date_gt!);
  if (opts.filing_date_gte) rows = rows.filter((r) => (r.filing_date as string | null) && (r.filing_date as string) >= opts.filing_date_gte!);
  if (opts.filing_date_lt) rows = rows.filter((r) => (r.filing_date as string | null) && (r.filing_date as string) < opts.filing_date_lt!);
  if (opts.filing_date_lte) rows = rows.filter((r) => (r.filing_date as string | null) && (r.filing_date as string) <= opts.filing_date_lte!);
  if (opts.name) {
    const needle = opts.name.toLowerCase();
    rows = rows.filter((r) => String(r.full_name ?? '').toLowerCase().includes(needle));
  }

  return { data: { insider_trades: rows.slice(0, opts.limit) }, url: summaryUrl(ticker) };
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

export async function fetchNews(opts: {
  ticker?: string;
  limit: number;
}): Promise<{ data: { news: Rec[] }; url: string }> {
  const query = opts.ticker ? normalizeTicker(opts.ticker) : 'markets';
  try {
    const results = (await yahooFinance.search(query, {
      newsCount: Math.min(opts.limit, 10),
      quotesCount: 0,
    })) as unknown as { news?: Rec[] };
    const raw = (results.news ?? []) as Rec[];
    const articles: Rec[] = raw.slice(0, opts.limit).map((n) => ({
      title: n.title,
      source: n.publisher,
      date: dateStr(n.providerPublishTime),
      url: n.link,
      uuid: n.uuid,
    }));
    const url = opts.ticker
      ? `https://finance.yahoo.com/quote/${encodeURIComponent(query)}/news`
      : 'https://finance.yahoo.com/news/';
    return { data: { news: articles }, url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[Yahoo Finance] news search failed: ${message}`);
    throw new Error(`[Yahoo Finance] news search failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Stock prices
// ---------------------------------------------------------------------------

export async function fetchStockPriceSnapshot(ticker: string): Promise<{
  data: { snapshot: Rec };
  url: string;
}> {
  const t = normalizeTicker(ticker);
  try {
    const quote = (await yahooFinance.quote(t)) as unknown as Rec;
    const snapshot: Rec = {
      ticker: t,
      price: num(quote.regularMarketPrice),
      close: num(quote.regularMarketPrice),
      open: num(quote.regularMarketOpen),
      high: num(quote.regularMarketDayHigh),
      low: num(quote.regularMarketDayLow),
      previous_close: num(quote.regularMarketPreviousClose),
      volume: num(quote.regularMarketVolume),
      market_cap: num(quote.marketCap),
      day_change: num(quote.regularMarketChange),
      day_change_percent: num(quote.regularMarketChangePercent),
      currency: quote.currency,
      exchange: quote.fullExchangeName,
      time: dateStr(quote.regularMarketTime),
    };
    return { data: { snapshot }, url: summaryUrl(t) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[Yahoo Finance] quote(${t}) — ${message}`);
    throw new Error(`[Yahoo Finance] quote failed for ${t}: ${message}`);
  }
}

type PriceInterval = 'day' | 'week' | 'month' | 'year';

const INTERVAL_MAP: Record<PriceInterval, '1d' | '1wk' | '1mo' | '3mo'> = {
  day: '1d',
  week: '1wk',
  month: '1mo',
  // Yahoo does not offer '1y' for chart. Use quarterly and note the approximation.
  year: '3mo',
};

export async function fetchStockPrices(opts: {
  ticker: string;
  interval: PriceInterval;
  start_date: string;
  end_date: string;
}): Promise<{ data: { prices: Rec[] }; url: string }> {
  const ticker = normalizeTicker(opts.ticker);
  try {
    const rows = (await yahooFinance.chart(ticker, {
      period1: opts.start_date,
      period2: opts.end_date,
      interval: INTERVAL_MAP[opts.interval],
    })) as unknown as { quotes?: Rec[] };
    const quotes = (rows.quotes ?? []) as Rec[];
    const prices: Rec[] = quotes.map((q) => ({
      date: dateStr(q.date),
      open: num(q.open),
      high: num(q.high),
      low: num(q.low),
      close: num(q.close),
      adjusted_close: num(q.adjclose),
      volume: num(q.volume),
    }));
    return {
      data: { prices },
      url: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/history`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[Yahoo Finance] chart(${ticker}) — ${message}`);
    throw new Error(`[Yahoo Finance] historical prices failed for ${ticker}: ${message}`);
  }
}

// Ticker search — used in place of the old 'available tickers' endpoint
export async function searchTickers(query: string): Promise<{ data: { tickers: Rec[] }; url: string }> {
  try {
    const result = (await yahooFinance.search(query, { quotesCount: 10, newsCount: 0 })) as unknown as {
      quotes?: Rec[];
    };
    const tickers: Rec[] = (result.quotes ?? []).map((q) => ({
      ticker: (q as Rec).symbol,
      name: (q as Rec).shortname ?? (q as Rec).longname,
      exchange: (q as Rec).exchDisp,
      type: (q as Rec).typeDisp ?? (q as Rec).quoteType,
    }));
    return { data: { tickers }, url: `https://finance.yahoo.com/lookup?s=${encodeURIComponent(query)}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[Yahoo Finance] search(${query}) — ${message}`);
    throw new Error(`[Yahoo Finance] ticker search failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Crypto — yahoo-finance2 supports '<SYMBOL>-USD' directly
// ---------------------------------------------------------------------------

function toYahooCrypto(ticker: string): string {
  const t = ticker.trim().toUpperCase();
  // Convert BTC-USD form — Yahoo already accepts this as-is.
  return t;
}

export async function fetchCryptoPriceSnapshot(ticker: string): Promise<{
  data: { snapshot: Rec };
  url: string;
}> {
  return fetchStockPriceSnapshot(toYahooCrypto(ticker));
}

export async function fetchCryptoPrices(opts: {
  ticker: string;
  interval: 'minute' | 'day' | 'week' | 'month' | 'year';
  start_date: string;
  end_date: string;
}): Promise<{ data: { prices: Rec[] }; url: string }> {
  // Yahoo chart does not support minute granularity over arbitrary ranges — fall back to day.
  const interval = opts.interval === 'minute' ? 'day' : opts.interval;
  return fetchStockPrices({
    ticker: toYahooCrypto(opts.ticker),
    interval,
    start_date: opts.start_date,
    end_date: opts.end_date,
  });
}

// ---------------------------------------------------------------------------
// SEC filings — Yahoo provides links; Dexter's read_filings tool uses web_fetch
// for the actual section text.
// ---------------------------------------------------------------------------

export async function fetchFilings(opts: {
  ticker: string;
  filing_type?: string[];
  limit: number;
}): Promise<{ data: { filings: Rec[] }; url: string }> {
  const ticker = normalizeTicker(opts.ticker);
  const summary = await quoteSummary(ticker, ['secFilings']);
  const filings = ((summary.secFilings as Rec | undefined)?.filings as Rec[] | undefined) ?? [];

  const wanted = opts.filing_type?.map((t) => t.toUpperCase());

  let rows: Rec[] = filings.map((f) => ({
    accession_number: f.edgarUrl
      ? String(f.edgarUrl).split('/').filter(Boolean).pop() ?? null
      : null,
    filing_type: f.type,
    filed_at: dateStr(f.date),
    title: f.title,
    url: (() => {
      if (f.edgarUrl) return f.edgarUrl;
      const exhibits = Array.isArray(f.exhibits) ? (f.exhibits as Rec[]) : [];
      return exhibits[0]?.url ?? null;
    })(),
    exhibits: Array.isArray(f.exhibits)
      ? (f.exhibits as Rec[]).map((e) => ({ type: e.type, url: e.url }))
      : [],
  }));

  if (wanted && wanted.length > 0) {
    rows = rows.filter((r) => wanted.includes(String(r.filing_type ?? '').toUpperCase()));
  }

  return {
    data: { filings: rows.slice(0, opts.limit) },
    url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&ticker=${encodeURIComponent(ticker)}&type=&dateb=&owner=include&count=40`,
  };
}
