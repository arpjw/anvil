import OpenAI from 'openai';
import { toolDefinitions, executeTool } from './tools/index.js';

const SYSTEM_PROMPT = `You are Anvil, a precise coding agent. Given a natural language request, you:
1. Use list_files and read_file to understand the codebase structure and relevant file contents
2. Use text_search to find patterns, usages, or symbols across files
3. Apply the minimal correct edit using write_file — write the complete updated file content

Be surgical. Read before you write. When writing, always include the full file content.`;

export async function runAgent(request: string, workdir: string): Promise<void> {
  if (!process.env.MOONSHOT_API_KEY) {
    throw new Error('MOONSHOT_API_KEY environment variable is not set');
  }

  const client = new OpenAI({
    baseURL: 'https://api.moonshot.cn/v1',
    apiKey: process.env.MOONSHOT_API_KEY,
  });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Working directory: ${workdir}\n\nRequest: ${request}` },
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 20;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const stream = await client.chat.completions.create({
      model: 'moonshot-v1-32k',
      messages,
      tools: toolDefinitions,
      tool_choice: 'auto',
      stream: true,
    });

    let textContent = '';
    const toolCallMap: Record<number, { id: string; name: string; arguments: string }> = {};
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;
      finishReason = choice.finish_reason ?? finishReason;

      if (delta.content) {
        process.stdout.write(delta.content);
        textContent += delta.content;
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallMap[idx]) {
            toolCallMap[idx] = { id: '', name: '', arguments: '' };
          }
          if (tc.id) toolCallMap[idx].id = tc.id;
          if (tc.function?.name) toolCallMap[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCallMap[idx].arguments += tc.function.arguments;
        }
      }
    }

    if (textContent) process.stdout.write('\n');

    const toolCalls = Object.values(toolCallMap);

    if (toolCalls.length === 0 || finishReason === 'stop') {
      break;
    }

    // Append assistant turn with tool calls
    messages.push({
      role: 'assistant',
      content: textContent || null,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    // Execute each tool call and append results
    for (const tc of toolCalls) {
      process.stderr.write(`  [${tc.name}] ${describeArgs(tc.arguments)}\n`);

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch {
        // malformed args — pass empty
      }

      const result = await executeTool(tc.name, args, workdir);

      const preview = result.length > 120 ? result.slice(0, 120) + '...' : result;
      process.stderr.write(`  → ${preview}\n`);

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result,
      });
    }
  }

  if (iterations >= MAX_ITERATIONS) {
    process.stderr.write('\nReached max iterations limit.\n');
  }
}

function describeArgs(raw: string): string {
  try {
    const args = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(args)
      .map(([k, v]) => {
        const val = typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '…' : String(v);
        return `${k}=${val}`;
      })
      .join(', ');
  } catch {
    return raw.slice(0, 80);
  }
}
