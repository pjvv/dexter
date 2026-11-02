import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { fetchStockPriceSnapshot, fetchStockPrices, searchTickers } from './providers/yahoo.js';

export const STOCK_PRICE_DESCRIPTION = `
Fetches current stock price snapshots for equities, including open, high, low, close prices, volume, and market cap. Powered by Yahoo Finance.
`.trim();

const StockPriceInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch current price for. For example, 'AAPL' for Apple."),
});

export const getStockPrice = new DynamicStructuredTool({
  name: 'get_stock_price',
  description:
    'Fetches the current stock price snapshot for an equity ticker, including open, high, low, close prices, volume, and market cap.',
  schema: StockPriceInputSchema,
  func: async (input) => {
    const { data, url } = await fetchStockPriceSnapshot(input.ticker);
    return formatToolResult(data.snapshot, [url]);
  },
});

const StockPricesInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch historical prices for. For example, 'AAPL' for Apple."),
  interval: z
    .enum(['day', 'week', 'month', 'year'])
    .default('day')
    .describe("The time interval for price data. Defaults to 'day'."),
  start_date: z.string().describe('Start date in YYYY-MM-DD format. Required.'),
  end_date: z.string().describe('End date in YYYY-MM-DD format. Required.'),
});

export const getStockPrices = new DynamicStructuredTool({
  name: 'get_stock_prices',
  description:
    'Retrieves historical price data for a stock over a specified date range, including open, high, low, close prices and volume.',
  schema: StockPricesInputSchema,
  func: async (input) => {
    const { data, url } = await fetchStockPrices({
      ticker: input.ticker,
      interval: input.interval,
      start_date: input.start_date,
      end_date: input.end_date,
    });
    return formatToolResult(data.prices, [url]);
  },
});

const StockTickerSearchInputSchema = z.object({
  query: z
    .string()
    .default('')
    .describe('Optional search term (company name or partial ticker). Empty string lists a default sample.'),
});

export const getStockTickers = new DynamicStructuredTool({
  name: 'get_available_stock_tickers',
  description:
    'Searches the available stock tickers by company name or symbol. Useful when the user asks "what ticker is X?".',
  schema: StockTickerSearchInputSchema,
  func: async (input) => {
    const query = input.query?.trim() || 'stock';
    const { data, url } = await searchTickers(query);
    return formatToolResult(data.tickers, [url]);
  },
});
