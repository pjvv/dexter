import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import {
  fetchAllFinancials,
  fetchBalanceSheets,
  fetchCashFlowStatements,
  fetchIncomeStatements,
} from './providers/yahoo.js';

const FinancialStatementsInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "The stock ticker symbol to fetch financial statements for. For example, 'AAPL' for Apple."
    ),
  period: z
    .enum(['annual', 'quarterly', 'ttm'])
    .describe(
      "The reporting period for the financial statements. 'annual' for yearly, 'quarterly' for quarterly, and 'ttm' for trailing twelve months."
    ),
  limit: z
    .number()
    .default(4)
    .describe(
      'Maximum number of report periods to return (default: 4). Returns the most recent N periods based on the period type. Increase this for longer historical analysis when needed.'
    ),
  report_period_gt: z
    .string()
    .optional()
    .describe('Filter for financial statements with report periods after this date (YYYY-MM-DD).'),
  report_period_gte: z
    .string()
    .optional()
    .describe(
      'Filter for financial statements with report periods on or after this date (YYYY-MM-DD).'
    ),
  report_period_lt: z
    .string()
    .optional()
    .describe('Filter for financial statements with report periods before this date (YYYY-MM-DD).'),
  report_period_lte: z
    .string()
    .optional()
    .describe(
      'Filter for financial statements with report periods on or before this date (YYYY-MM-DD).'
    ),
});

type FundamentalsInput = z.infer<typeof FinancialStatementsInputSchema>;

export const getIncomeStatements = new DynamicStructuredTool({
  name: 'get_income_statements',
  description: `Fetches a company's income statements, detailing its revenues, expenses, net income, etc. over a reporting period. Useful for evaluating a company's profitability and operational efficiency.`,
  schema: FinancialStatementsInputSchema,
  func: async (input: FundamentalsInput) => {
    const { data, url } = await fetchIncomeStatements(input);
    return formatToolResult(data.income_statements, [url]);
  },
});

export const getBalanceSheets = new DynamicStructuredTool({
  name: 'get_balance_sheets',
  description: `Retrieves a company's balance sheets, providing a snapshot of its assets, liabilities, shareholders' equity, etc. at a specific point in time. Useful for assessing a company's financial position.`,
  schema: FinancialStatementsInputSchema,
  func: async (input: FundamentalsInput) => {
    const { data, url } = await fetchBalanceSheets(input);
    return formatToolResult(data.balance_sheets, [url]);
  },
});

export const getCashFlowStatements = new DynamicStructuredTool({
  name: 'get_cash_flow_statements',
  description: `Retrieves a company's cash flow statements, showing how cash is generated and used across operating, investing, and financing activities. Useful for understanding a company's liquidity and solvency.`,
  schema: FinancialStatementsInputSchema,
  func: async (input: FundamentalsInput) => {
    const { data, url } = await fetchCashFlowStatements(input);
    return formatToolResult(data.cash_flow_statements, [url]);
  },
});

export const getAllFinancialStatements = new DynamicStructuredTool({
  name: 'get_all_financial_statements',
  description: `Retrieves all three financial statements (income statements, balance sheets, and cash flow statements) for a company in a single API call. This is more efficient than calling each statement type separately when you need all three for comprehensive financial analysis.`,
  schema: FinancialStatementsInputSchema,
  func: async (input: FundamentalsInput) => {
    const { data, url } = await fetchAllFinancials(input);
    return formatToolResult(data.financials, [url]);
  },
});
