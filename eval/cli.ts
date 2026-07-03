import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { downloadTasks } from './swe_bench.js';
import { runEval } from './run.js';
import { scoreResults, printReport } from './score.js';

interface CliArgs {
  tasks: number;
  outputDir: string;
  resume: boolean;
  modelId: string;
  concurrency: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    tasks: 50,
    outputDir: './eval-results',
    resume: false,
    modelId: 'claude-sonnet-4-6',
    concurrency: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--tasks':
        args.tasks = Number(argv[++i]) || args.tasks;
        break;
      case '--output':
        args.outputDir = argv[++i] ?? args.outputDir;
        break;
      case '--resume':
        args.resume = true;
        break;
      case '--model':
        args.modelId = argv[++i] ?? args.modelId;
        break;
      case '--concurrency':
        args.concurrency = Number(argv[++i]) || args.concurrency;
        break;
      case '-h':
      case '--help':
        console.log(`Usage: npx tsx eval/cli.ts [flags]

  --tasks <n>         number of tasks to run (default: 50)
  --output <dir>      per-task JSON output dir (default: ./eval-results)
  --resume            skip tasks that already have a result file
  --model <id>        model to use (default: claude-sonnet-4-6)
  --concurrency <n>   tasks in flight at once (default: 3)`);
        process.exit(0);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = resolve(args.outputDir);
  mkdirSync(outputDir, { recursive: true });

  console.log(`[eval] downloading up to ${args.tasks} SWE-bench Verified tasks…`);
  const tasks = await downloadTasks(args.tasks);
  console.log(`[eval] loaded ${tasks.length} tasks`);

  if (tasks.length === 0) {
    console.error('[eval] no tasks loaded; aborting.');
    process.exit(1);
  }

  console.log(
    `[eval] running with model=${args.modelId} concurrency=${args.concurrency} ` +
      `resume=${args.resume} output=${outputDir}`,
  );

  const results = await runEval(tasks, {
    outputDir,
    resume: args.resume,
    modelId: args.modelId,
    concurrency: args.concurrency,
  });

  const summary = scoreResults(results);
  printReport(summary, results);

  const summaryPath = resolve(outputDir, 'summary.json');
  writeFileSync(
    summaryPath,
    JSON.stringify({ summary, results }, null, 2),
    'utf-8',
  );
  console.log(`\n[eval] wrote summary → ${summaryPath}`);
}

main().catch((err) => {
  console.error(`[eval] fatal: ${(err as Error).message}`);
  process.exit(1);
});
