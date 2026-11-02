import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { fetchEarnings } from './providers/yahoo.js';

const EarningsInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch the latest earnings for. For example, 'AAPL' for Apple."),
});

export const getEarnings = new DynamicStructuredTool({
  name: 'get_earnings',
  description:
    'Fetches the most recent earnings snapshot for a company, including revenue and EPS actuals with estimate comparisons (revenue and EPS surprise) when available.',
  schema: EarningsInputSchema,
  func: async (input) => {
    const { data, url } = await fetchEarnings(input.ticker);
    return formatToolResult(data.earnings, [url]);
  },
});
