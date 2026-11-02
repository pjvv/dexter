import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { fetchNews } from './providers/yahoo.js';

const CompanyNewsInputSchema = z.object({
  ticker: z
    .string()
    .optional()
    .describe("The stock ticker symbol (e.g., 'AAPL'). Omit for broad market news."),
  limit: z
    .number()
    .default(5)
    .describe('Maximum number of news articles to return (default: 5, max: 10).'),
});

export const getCompanyNews = new DynamicStructuredTool({
  name: 'get_company_news',
  description:
    'Retrieves recent news headlines, including title, source, publication date, and URL. Pass a ticker for company-specific news, or omit the ticker for broad market news covering macro, rates, earnings, geopolitics, and more. Also useful when trying to explain broad price moves — omit the ticker to check for market-wide catalysts.',
  schema: CompanyNewsInputSchema,
  func: async (input) => {
    const { data, url } = await fetchNews({
      ticker: input.ticker,
      limit: Math.min(input.limit, 10),
    });
    return formatToolResult(data.news, [url]);
  },
});
