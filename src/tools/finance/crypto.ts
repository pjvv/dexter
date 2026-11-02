import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import {
  fetchCryptoPriceSnapshot,
  fetchCryptoPrices,
  searchTickers,
} from './providers/yahoo.js';

const CryptoPriceSnapshotInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "The crypto ticker symbol to fetch the price snapshot for. For example, 'BTC-USD' for Bitcoin."
    ),
});

export const getCryptoPriceSnapshot = new DynamicStructuredTool({
  name: 'get_crypto_price_snapshot',
  description: `Fetches the most recent price snapshot for a specific cryptocurrency, including the latest price, trading volume, and open/high/low/close data. Ticker format: use 'CRYPTO-USD' (e.g., 'BTC-USD').`,
  schema: CryptoPriceSnapshotInputSchema,
  func: async (input) => {
    const { data, url } = await fetchCryptoPriceSnapshot(input.ticker);
    return formatToolResult(data.snapshot, [url]);
  },
});

const CryptoPricesInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "The crypto ticker symbol to fetch aggregated prices for. For example, 'BTC-USD' for Bitcoin."
    ),
  interval: z
    .enum(['minute', 'day', 'week', 'month', 'year'])
    .default('day')
    .describe("The time interval for price data. 'minute' falls back to 'day' via Yahoo Finance."),
  start_date: z.string().describe('Start date in YYYY-MM-DD format. Required.'),
  end_date: z.string().describe('End date in YYYY-MM-DD format. Required.'),
});

export const getCryptoPrices = new DynamicStructuredTool({
  name: 'get_crypto_prices',
  description: `Retrieves historical price data for a cryptocurrency over a specified date range. Ticker format: 'CRYPTO-USD' (e.g., 'BTC-USD').`,
  schema: CryptoPricesInputSchema,
  func: async (input) => {
    const { data, url } = await fetchCryptoPrices({
      ticker: input.ticker,
      interval: input.interval,
      start_date: input.start_date,
      end_date: input.end_date,
    });
    return formatToolResult(data.prices, [url]);
  },
});

export const getCryptoTickers = new DynamicStructuredTool({
  name: 'get_available_crypto_tickers',
  description: `Searches for cryptocurrency tickers (e.g., 'BTC', 'ETH'). Returns tickers in 'CRYPTO-USD' form where applicable.`,
  schema: z.object({
    query: z.string().default('bitcoin').describe('Search term for the crypto. Defaults to "bitcoin".'),
  }),
  func: async (input) => {
    const { data, url } = await searchTickers(input.query || 'bitcoin');
    return formatToolResult(data.tickers, [url]);
  },
});
