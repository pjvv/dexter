import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { fetchHistoricalKeyRatios, fetchKeyRatiosSnapshot } from './providers/yahoo.js';

const KeyRatiosInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch key ratios for. For example, 'AAPL' for Apple."),
});

export const getKeyRatios = new DynamicStructuredTool({
  name: 'get_key_ratios',
  description:
    'Fetches the latest financial metrics snapshot for a company, including valuation ratios (P/E, P/B, P/S, EV/EBITDA, PEG), profitability (margins, ROE, ROA), liquidity (current/quick ratios), leverage (debt/equity), per-share metrics (EPS, book value), and growth rates (revenue, earnings).',
  schema: KeyRatiosInputSchema,
  func: async (input) => {
    const { data, url } = await fetchKeyRatiosSnapshot(input.ticker);
    return formatToolResult(data.snapshot, [url]);
  },
});

const HistoricalKeyRatiosInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "The stock ticker symbol to fetch historical key ratios for. For example, 'AAPL' for Apple."
    ),
  period: z
    .enum(['annual', 'quarterly', 'ttm'])
    .default('ttm')
    .describe(
      "The reporting period. 'annual' for yearly, 'quarterly' for quarterly, and 'ttm' maps to annual with the most recent period treated as trailing twelve months."
    ),
  limit: z
    .number()
    .default(4)
    .describe('The number of past financial statements to retrieve.'),
});

export const getHistoricalKeyRatios = new DynamicStructuredTool({
  name: 'get_historical_key_ratios',
  description: `Retrieves historical key ratios for a company — margins, growth rates, and per-share metrics derived from reported income statements. Useful for trend analysis and historical performance evaluation.`,
  schema: HistoricalKeyRatiosInputSchema,
  func: async (input) => {
    const { data, url } = await fetchHistoricalKeyRatios(input);
    return formatToolResult(data.financial_metrics, [url]);
  },
});
