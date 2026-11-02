import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { fetchInsiderTrades } from './providers/yahoo.js';

const InsiderTradesInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch insider trades for. For example, 'AAPL' for Apple."),
  limit: z
    .number()
    .default(10)
    .describe('Maximum number of insider trades to return (default: 10). Increase this for longer historical windows when needed.'),
  filing_date: z
    .string()
    .optional()
    .describe('Exact filing date to filter by (YYYY-MM-DD).'),
  filing_date_gte: z
    .string()
    .optional()
    .describe('Filter for trades with filing date greater than or equal to this date (YYYY-MM-DD).'),
  filing_date_lte: z
    .string()
    .optional()
    .describe('Filter for trades with filing date less than or equal to this date (YYYY-MM-DD).'),
  filing_date_gt: z
    .string()
    .optional()
    .describe('Filter for trades with filing date greater than this date (YYYY-MM-DD).'),
  filing_date_lt: z
    .string()
    .optional()
    .describe('Filter for trades with filing date less than this date (YYYY-MM-DD).'),
  name: z
    .string()
    .optional()
    .describe("Filter by insider name substring (case-insensitive, e.g., 'Huang')."),
});

export const getInsiderTrades = new DynamicStructuredTool({
  name: 'get_insider_trades',
  description: `Retrieves insider trading transactions for a given company ticker. Insider trades include purchases and sales of company stock by executives, directors, and other insiders, sourced from SEC Form 4 filings. Use filing_date filters to narrow results by date range. Use the name parameter to filter by a specific insider.`,
  schema: InsiderTradesInputSchema,
  func: async (input) => {
    const { data, url } = await fetchInsiderTrades(input);
    return formatToolResult(data.insider_trades, [url]);
  },
});
