import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { fetchFilings } from './providers/yahoo.js';

// Types for filing item metadata (kept for backwards compatibility with read-filings.ts)
export interface FilingItemType {
  name: string;
  title: string;
  description: string;
}

export interface FilingItemTypes {
  '10-K': FilingItemType[];
  '10-Q': FilingItemType[];
}

// Static item-type catalog. Yahoo Finance doesn't expose a filings/items
// metadata endpoint, so this is a curated subset covering the sections the
// LLM is most likely to reference.
const STATIC_FILING_ITEM_TYPES: FilingItemTypes = {
  '10-K': [
    { name: 'Item-1', title: 'Business', description: 'Overview of the company and its operations.' },
    { name: 'Item-1A', title: 'Risk Factors', description: 'Material risks the company faces.' },
    { name: 'Item-2', title: 'Properties', description: 'Material physical properties.' },
    { name: 'Item-3', title: 'Legal Proceedings', description: 'Material pending legal proceedings.' },
    { name: 'Item-5', title: 'Market for Equity', description: 'Market data on the company\'s equity.' },
    { name: 'Item-7', title: 'MD&A', description: "Management's discussion and analysis of operations." },
    { name: 'Item-7A', title: 'Market Risk', description: 'Quantitative and qualitative market-risk disclosures.' },
    { name: 'Item-8', title: 'Financial Statements', description: 'Audited financial statements.' },
  ],
  '10-Q': [
    { name: 'Part-1,Item-1', title: 'Financial Statements', description: 'Unaudited quarterly financial statements.' },
    { name: 'Part-1,Item-2', title: 'MD&A', description: "Management's discussion and analysis." },
    { name: 'Part-1,Item-3', title: 'Market Risk', description: 'Market-risk disclosures.' },
    { name: 'Part-2,Item-1A', title: 'Risk Factors', description: 'Updates to risk factors.' },
  ],
};

export async function getFilingItemTypes(): Promise<FilingItemTypes> {
  return STATIC_FILING_ITEM_TYPES;
}

const FilingsInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch filings for. For example, 'AAPL' for Apple."),
  filing_type: z
    .array(z.enum(['10-K', '10-Q', '8-K']))
    .optional()
    .describe(
      "Optional list of filing types to filter by. Use one or more of '10-K', '10-Q', or '8-K'. If omitted, returns most recent filings of ANY type."
    ),
  limit: z
    .number()
    .default(10)
    .describe(
      'Maximum number of filings to return (default: 10). Returns the most recent N filings matching the criteria.'
    ),
});

export const getFilings = new DynamicStructuredTool({
  name: 'get_filings',
  description: `Retrieves metadata for SEC filings for a company (accession numbers, filing types, and document URLs). Filings are sourced from Yahoo Finance, which links directly to SEC EDGAR. To read actual filing text, use the web_fetch tool with the filing's URL.`,
  schema: FilingsInputSchema,
  func: async (input) => {
    const { data, url } = await fetchFilings(input);
    return formatToolResult(data.filings, [url]);
  },
});

// ---------------------------------------------------------------------------
// Filing item retrieval
//
// Yahoo Finance does not expose section-by-section filing text. These tools
// now return a structured pointer with the SEC filing URL so the agent can
// `web_fetch` it. This preserves the tool surface (read-filings.ts still
// routes to these tools) while explicitly signalling the new workflow.
// ---------------------------------------------------------------------------

const FilingItemsInputSchema = z.object({
  ticker: z.string().describe("The stock ticker symbol. For example, 'AAPL' for Apple."),
  accession_number: z
    .string()
    .describe('The SEC accession number or filing identifier. Obtained from get_filings.'),
  items: z
    .array(z.string())
    .optional()
    .describe(
      'Optional list of specific item names. Hint only — the fetch is done on the full filing and the reader must search for the sections.'
    ),
});

async function pointerPayload(
  ticker: string,
  accessionNumber: string,
  filingType: '10-K' | '10-Q' | '8-K',
  items: string[] | undefined,
): Promise<string> {
  const t = ticker.trim().toUpperCase();
  const { data } = await fetchFilings({ ticker: t, filing_type: [filingType], limit: 20 });
  const match = data.filings.find(
    (f) => String(f.accession_number ?? '').includes(accessionNumber) || String(f.url ?? '').includes(accessionNumber),
  );
  const url = (match?.url as string | undefined)
    ?? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&ticker=${encodeURIComponent(t)}&type=${encodeURIComponent(filingType)}&dateb=&owner=include&count=40`;

  return formatToolResult(
    {
      instructions:
        `This filing's sections are not pre-extracted. Use the web_fetch tool on the URL below to retrieve the full ${filingType} text, then locate the requested item(s).`,
      ticker: t,
      filing_type: filingType,
      accession_number: accessionNumber,
      items_requested: items ?? 'all',
      fetch_with_web_fetch: url,
    },
    [url],
  );
}

export const get10KFilingItems = new DynamicStructuredTool({
  name: 'get_10K_filing_items',
  description: `Returns a pointer to a 10-K annual report. The section text is NOT extracted — the agent should call web_fetch on the returned URL and locate the requested items (Item-1 Business, Item-1A Risk Factors, Item-7 MD&A, etc.) within the fetched content.`,
  schema: FilingItemsInputSchema,
  func: async (input) => pointerPayload(input.ticker, input.accession_number, '10-K', input.items),
});

export const get10QFilingItems = new DynamicStructuredTool({
  name: 'get_10Q_filing_items',
  description: `Returns a pointer to a 10-Q quarterly report. The section text is NOT extracted — the agent should call web_fetch on the returned URL and locate the requested items within the fetched content.`,
  schema: FilingItemsInputSchema,
  func: async (input) => pointerPayload(input.ticker, input.accession_number, '10-Q', input.items),
});

const Filing8KItemsInputSchema = z.object({
  ticker: z.string().describe("The stock ticker symbol. For example, 'AAPL' for Apple."),
  accession_number: z
    .string()
    .describe('The SEC accession number or filing identifier. Obtained from get_filings.'),
});

export const get8KFilingItems = new DynamicStructuredTool({
  name: 'get_8K_filing_items',
  description: `Returns a pointer to an 8-K current report. The event description is NOT extracted — the agent should call web_fetch on the returned URL.`,
  schema: Filing8KItemsInputSchema,
  func: async (input) => pointerPayload(input.ticker, input.accession_number, '8-K', undefined),
});
