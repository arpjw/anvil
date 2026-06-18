import OpenAI from 'openai';
import { uiStream } from '../ui/stream.js';

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

      if (delta.content) textContent += delta.content;

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

    if (textContent) uiStream.push({ type: 'model_text', text: textContent });

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
      try { args = JSON.parse(tc.arguments) as Record<string, unknown>; } catch { /* malformed */ }

      if (tc.name === 'done') {
        const summary = (args.summary as string) ?? '';
        uiStream.push({ type: 'done', summary });
        break outer;
      }

      uiStream.push({ type: 'tool_call', name: tc.name, args: describeArgs(tc.arguments) });

      const { result, done } = await executeToolFn(tc.name, args);
      const preview = result.length > 120 ? result.slice(0, 120) + '...' : result;
      uiStream.push({ type: 'tool_result', name: tc.name, preview });

      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });

      if (done) break outer;
    }
  }

  if (iterations >= maxIterations) {
    uiStream.push({ type: 'error', message: 'Reached max iterations limit.' });
  }
}

export function describeArgs(raw: string): string {
  try {
    const args = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(args)
      .map(([k, v]) => {
        const val = typeof v === 'string' && v.length > 50 ? v.slice(0, 50) + '…' : String(v);
        return `${k}=${val}`;
      })
      .join(', ');
  } catch {
    return raw.slice(0, 80);
  }
}
