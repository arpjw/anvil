import type OpenAI from 'openai';
import { readFile } from './read_file.js';
import { listFiles } from './list_files.js';
import { textSearch } from './text_search.js';
import { writeFile } from './write_file.js';
import { astSearch } from './ast_search.js';
import { findSymbol } from './find_symbol.js';
import { gitLog } from './git_log.js';
import { gitDiff } from './git_diff.js';
import { gitBlame } from './git_blame.js';

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
  {
    type: 'function',
    function: {
      name: 'ast_search',
      description:
        'Query the AST of source files to find structural elements without reading full file contents. ' +
        'Use this before read_file to locate specific constructs. ' +
        'Returns each match with its name and exact line range. ' +
        'Supports TypeScript, JavaScript, and Python.',
      parameters: {
        type: 'object',
        properties: {
          query_type: {
            type: 'string',
            enum: ['functions', 'classes', 'imports', 'interfaces', 'types'],
            description:
              'What to look for: ' +
              '"functions" = function/method/arrow-function declarations, ' +
              '"classes" = class declarations, ' +
              '"imports" = import statements, ' +
              '"interfaces" = TypeScript interface declarations, ' +
              '"types" = TypeScript type alias declarations',
          },
          path: {
            type: 'string',
            description: 'File or directory to search (relative to working directory)',
          },
          file_pattern: {
            type: 'string',
            description: 'Optional glob pattern to restrict to specific files, e.g. "*.ts"',
          },
        },
        required: ['query_type', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description: 'Show recent git commit history with file-change summaries. Use this to understand what changed recently in the project before making modifications.',
      parameters: {
        type: 'object',
        properties: {
          workdir: { type: 'string', description: 'Repository root directory' },
          limit: { type: 'number', description: 'Number of commits to show (default: 10)' },
        },
        required: ['workdir'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show the unified diff of current staged or unstaged changes. Use this when the request references "current changes", "what I just did", or "my edits".',
      parameters: {
        type: 'object',
        properties: {
          workdir: { type: 'string', description: 'Repository root directory' },
          mode: {
            type: 'string',
            enum: ['staged', 'unstaged', 'all'],
            description: 'Which changes to show (default: all)',
          },
        },
        required: ['workdir'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_blame',
      description: 'Show who last modified each line in a file range, including commit hash, author, date, and commit message. Use this to understand the history and intent behind a section of code.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Path to the file (absolute or relative to workdir)' },
          line_start: { type: 'number', description: '1-indexed first line of the range' },
          line_end: { type: 'number', description: '1-indexed last line of the range' },
          workdir: { type: 'string', description: 'Repository root (optional; used to resolve relative paths)' },
        },
        required: ['filepath', 'line_start', 'line_end'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Call this when the task is fully complete. Provide a concise summary of every change made.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'What was accomplished — files changed, what changed, any notable decisions.',
          },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_symbol',
      description:
        'Use the TypeScript language server to find the definition site and all references to a symbol. ' +
        'Far more precise than grep: resolves through imports and type aliases. ' +
        'Use this when you need to understand where a function/type/variable is defined and everywhere it is used.',
      parameters: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: 'The symbol name to look up (function name, class name, variable, type, etc.)',
          },
          file: {
            type: 'string',
            description: 'A file where the symbol is known to appear (relative to working directory)',
          },
        },
        required: ['symbol', 'file'],
      },
    },
  },
];

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workdir: string,
  sessionId: string,
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
      return writeFile(args.path as string, args.content as string, workdir, sessionId);
    case 'ast_search':
      return astSearch(
        args.query_type as 'functions' | 'classes' | 'imports' | 'interfaces' | 'types',
        args.path as string,
        workdir,
        args.file_pattern as string | undefined,
      );
    case 'find_symbol':
      return findSymbol(args.symbol as string, args.file as string, workdir);
    case 'git_log':
      return gitLog(
        (args.workdir as string | undefined) ?? workdir,
        args.limit as number | undefined,
      );
    case 'git_diff':
      return gitDiff(
        (args.workdir as string | undefined) ?? workdir,
        args.mode as 'staged' | 'unstaged' | 'all' | undefined,
      );
    case 'git_blame':
      return gitBlame(
        args.filepath as string,
        args.line_start as number,
        args.line_end as number,
        (args.workdir as string | undefined) ?? workdir,
      );
    default:
      return `Unknown tool: ${name}`;
  }
}
