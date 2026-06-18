import type OpenAI from 'openai';
import { readFile } from './read_file.js';
import { listFiles } from './list_files.js';
import { textSearch } from './text_search.js';
import { writeFile } from './write_file.js';

export const toolDefinitions: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Supports optional line range.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to working directory or absolute)' },
          start_line: { type: 'number', description: '1-indexed first line to read (optional)' },
          end_line: { type: 'number', description: '1-indexed last line to read (optional)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories recursively. Skips node_modules, .git, dist.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list' },
          pattern: { type: 'string', description: 'Glob pattern to filter files, e.g. "*.ts"' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'text_search',
      description: 'Search for a regex pattern in files using ripgrep. Returns file:line:match format.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory or file to search in' },
          file_pattern: { type: 'string', description: 'Glob pattern to restrict which files are searched, e.g. "*.ts"' },
          case_sensitive: { type: 'boolean', description: 'Case-sensitive search (default: false)' },
          max_results: { type: 'number', description: 'Maximum number of matches per file' },
        },
        required: ['pattern', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, replacing it entirely. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to working directory or absolute)' },
          content: { type: 'string', description: 'Complete new content of the file' },
        },
        required: ['path', 'content'],
      },
    },
  },
];

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workdir: string,
): Promise<string> {
  switch (name) {
    case 'read_file':
      return readFile(
        args.path as string,
        workdir,
        args.start_line as number | undefined,
        args.end_line as number | undefined,
      );
    case 'list_files':
      return listFiles(args.path as string, workdir, args.pattern as string | undefined);
    case 'text_search':
      return textSearch(args.pattern as string, args.path as string, workdir, {
        filePattern: args.file_pattern as string | undefined,
        caseSensitive: args.case_sensitive as boolean | undefined,
        maxResults: args.max_results as number | undefined,
      });
    case 'write_file':
      return writeFile(args.path as string, args.content as string, workdir);
    default:
      return `Unknown tool: ${name}`;
  }
}
