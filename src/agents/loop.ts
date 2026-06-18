import OpenAI from 'openai';

export type ToolExecutorFn = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ result: string; done?: boolean }>;

export async function runStreamingLoop(
  client: OpenAI,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  tools: OpenAI.Chat.ChatCompletionTool[],
  executeToolFn: ToolExecutorFn,
  maxIterations = 20,
): Promise<void> {
  let iterations = 0;

  outer: while (iterations < maxIterations) {
    iterations++;

    const stream = await client.chat.completions.create({
      model: 'claude-sonnet-4-6',
      messages,
      tools,
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
          if (!toolCallMap[idx]) toolCallMap[idx] = { id: '', name: '', arguments: '' };
          if (tc.id) toolCallMap[idx].id = tc.id;
          if (tc.function?.name) toolCallMap[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCallMap[idx].arguments += tc.function.arguments;
        }
      }
    }

    if (textContent) process.stdout.write('\n');

    const toolCalls = Object.values(toolCallMap);
    if (toolCalls.length === 0 || finishReason === 'stop') break;

    messages.push({
      role: 'assistant',
      content: textContent || null,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.arguments) as Record<string, unknown>; } catch { /* malformed args */ }

      if (tc.name === 'done') {
        process.stdout.write(`\n[Anvil] Done: ${(args.summary as string) ?? ''}\n`);
        break outer;
      }

      process.stderr.write(`  [${tc.name}] ${describeArgs(tc.arguments)}\n`);

      const { result, done } = await executeToolFn(tc.name, args);
      const preview = result.length > 120 ? result.slice(0, 120) + '...' : result;
      process.stderr.write(`  → ${preview}\n`);

      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });

      if (done) break outer;
    }
  }

  if (iterations >= maxIterations) {
    process.stderr.write('\nReached max iterations limit.\n');
  }
}

export function describeArgs(raw: string): string {
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
