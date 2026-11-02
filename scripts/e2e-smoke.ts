import { config } from 'dotenv';
config({ path: new URL('../.env', import.meta.url).pathname, quiet: true });
import { Agent } from '../src/agent/index.js';

const query = process.argv.slice(2).join(' ') || `Do a thorough research report on CoreWeave (CRWV). Cover:
- Business model and customer concentration
- Revenue, margins, and free cash flow over available periods
- Balance sheet, especially debt load
- Analyst estimates and consensus view
- Key risks flagged in recent SEC filings
Be specific with numbers. Note where data is sparse because CoreWeave is young.`;

const model = process.env.DEXTER_MODEL ?? 'gemini-2.5-flash';

console.log(`\n▶ QUERY: ${query}\n▶ MODEL: ${model}\n`);

const agent = await Agent.create({ model, maxIterations: 12, memoryEnabled: false });

let answer = '';
const toolCalls: Array<{ tool: string; args: unknown }> = [];

for await (const event of agent.run(query)) {
  // Diagnostic: uncomment next line to print every event
  if (process.env.DEXTER_DEBUG) console.log('[evt]', event.type, JSON.stringify(event).slice(0, 300));
  switch (event.type) {
    case 'tool_start':
      console.log(`  • ${event.tool}(${JSON.stringify(event.args).slice(0, 200)})`);
      toolCalls.push({ tool: event.tool, args: event.args });
      break;
    case 'tool_end':
      console.log(`    ↳ ok (${String(event.result ?? '').replace(/\n/g, ' ').slice(0, 140)}…)`);
      break;
    case 'tool_error':
      console.log(`    ↳ ERROR ${event.tool}: ${event.error}`);
      break;
    case 'thinking':
      // Skip thinking to keep output focused.
      break;
    case 'answer_start':
      process.stdout.write('\n◆ ANSWER:\n\n');
      break;
    case 'answer_chunk':
      process.stdout.write(String(event.text ?? ''));
      answer += String(event.text ?? '');
      break;
    case 'done':
      console.log(`\n\n— done in ${event.totalTime}ms over ${event.iterations} iterations (${toolCalls.length} tool calls)`);
      if (!answer && event.answer) console.log(`◆ ANSWER:\n\n${event.answer}`);
      break;
  }
}
