import { parseArgs } from 'util';

export function parseCli(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'V' },
    'no-isolate': { type: 'boolean' }, 'allow-commands': { type: 'boolean' },
    headless: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'no-verify': { type: 'boolean' },
    commands: { type: 'boolean' }, continue: { type: 'boolean' }, 'no-open': { type: 'boolean' },
    json: { type: 'boolean' }, 'stream-json': { type: 'boolean' }, yes: { type: 'boolean', short: 'y' },
    model: { type: 'string' }, image: { type: 'string' }, budget: { type: 'string' },
    resume: { type: 'string' }, rollback: { type: 'string' },
  } });
  if (values.resume && values.rollback) throw new Error('Choose either --resume or --rollback.');
  if ((values.resume || values.rollback) && values['dry-run']) throw new Error('--dry-run cannot resume or roll back a session.');
  if (values['stream-json'] && values['dry-run']) throw new Error('Use --json with --dry-run.');
  const budget = values.budget === undefined ? undefined : Number(values.budget);
  if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) throw new Error('--budget must be a positive finite dollar amount.');
  return { values, positionals, budget };
}

export const HELP = `Anvil · a coding agent with a validation gate

Usage: anvilai "<request>" [workdir] [flags]

Commands:
  init [workdir]              Set up project rules and commands
  doctor [workdir]            Check runtime, model credentials, and tools
  verify [workdir] [--json]   Run project checks without an AI model
  history [id] [workdir]      Inspect sessions (--json for structured output)
  undo <file> [workdir]       Restore a file on the current session branch
  config list|get|set        Manage configuration
  memory summarize [workdir] Summarize older project memory

Flags:
  --model <id>         Select a model
  --no-isolate         Edit the current checkout instead of a dedicated Git worktree
  --allow-commands     Permit host shell commands and project checks for this run
  --dry-run           Explore and produce a plan without editing project files
  --headless          Auto-approve edits, deny shell commands unless explicitly allowed
  --stream-json       Headless mode with NDJSON events and a final result frame
  --json              JSON output for verify, history, or dry-run
  --budget <dollars>  Estimated model-usage ceiling (checked after each response)
  --no-verify         Skip project checks; reported as skipped, never passed
  --no-open           Keep the editor closed after completion
  --continue          Include the previous conversation
  --image <path>      Attach image context
  --resume <id>       Resume a workspace-bound recovery plan
  --rollback <id>     Return to the original branch, retaining the session branch
  --commands          List project slash commands
  -y, --yes           Accept defaults for init
  -h, --help          Show this help
  -V, --version       Show installed version
`;
