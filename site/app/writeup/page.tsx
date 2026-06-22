import Nav from '@/components/Nav';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Why Most Coding Agents Get Editing Wrong | Anvil',
  description:
    'A technical writeup on shadow workspaces, agentic context retrieval, and subagent isolation in coding agents.',
};

const containerStyle: React.CSSProperties = {
  maxWidth: '768px',
  margin: '0 auto',
  padding: '0 24px',
  width: '100%',
};

const proseStyle: React.CSSProperties = {
  fontSize: '17px',
  color: 'rgba(255,255,255,0.5)',
  lineHeight: 1.85,
  marginBottom: '24px',
  fontWeight: 400,
};

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: '20px',
  fontWeight: 500,
  color: '#ffffff',
  marginBottom: '20px',
  marginTop: '60px',
  letterSpacing: '-0.02em',
};

export default function Writeup() {
  return (
    <main>
      <Nav variant="writeup" />

      {/* Title block */}
      <div
        style={{
          ...containerStyle,
          paddingTop: '64px',
          paddingBottom: '48px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <h1
          style={{
            fontSize: 'clamp(26px, 5vw, 40px)',
            fontWeight: 600,
            color: '#ffffff',
            lineHeight: 1.15,
            letterSpacing: '-0.03em',
            marginBottom: '20px',
          }}
        >
          Why Most Coding Agents Get Editing Wrong
        </h1>
        <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.25)', fontFamily: 'var(--font-geist-mono)' }}>
          Arya Somu · June 2026
        </p>
      </div>

      {/* Body */}
      <article style={{ ...containerStyle, paddingTop: '56px', paddingBottom: '120px' }}>

        <h2 style={sectionHeadingStyle}>The Problem</h2>

        <p style={proseStyle}>
          Most coding agents fail on real codebases for reasons that have nothing to do with
          model quality. The first failure mode is wrong context. An agent that reads every
          file and hopes the relevant content appears in the context window works fine on a
          six-file project. On a production codebase, the files that need to change rarely
          share vocabulary with the task description. A request to rename a type named User
          to Account does not lexically overlap with the import statement in auth.ts. The
          agent retrieves the wrong files, fails to identify what needs to change, and
          produces a partial edit.
        </p>

        <p style={proseStyle}>
          The second failure mode is blind writes. The agent generates an edit, writes it
          directly to disk, and moves on. If the edit introduces a type error, the user
          discovers this when they compile. There is no feedback loop between the generation
          step and a validation step. The agent cannot distinguish between a correct edit
          and a broken one because it never checks. The file gets written either way.
        </p>

        <p style={proseStyle}>
          The third failure mode is no isolation between planning and execution. The executor
          reads the full codebase while applying edits, which means the context window fills
          with files that have nothing to do with the current change. As the executor
          processes file after file, quality degrades because the model is holding too much
          irrelevant state at once. By the fifth file in a ten-file edit, the model is
          working with half its context taken up by files it already finished.
        </p>

        <h2 style={sectionHeadingStyle}>The Shadow Workspace</h2>

        <p style={proseStyle}>
          {"Cursor's approach to the blind-write problem is the shadow workspace. They run a"}{' '}
          hidden VS Code window alongside the user&apos;s workspace. When the agent proposes
          an edit, it applies the change in the hidden window instead of the real file,
          collects LSP diagnostics from the language server running in that context, and only
          surfaces the change to the user if the diagnostics come back clean. This approach
          requires forking the editor. You need control over the rendering pipeline, the file
          system hooks, and the extension host. It is not something a plugin can replicate.
        </p>

        <p style={proseStyle}>
          Anvil implements a lighter version of the same idea. Instead of a hidden editor
          window, Anvil sends a textDocument/didChange notification to the language server
          with the proposed new file content. The server processes the change in memory and
          sends back a textDocument/publishDiagnostics notification. If the diagnostics array
          is empty, the edit commits to the real file. If there are errors, they return to
          the executor with instructions to correct the code. The loop runs up to three times
          before the agent gives up and reports the failure to the user.
        </p>

        <p style={proseStyle}>
          The critical implementation detail, which took real debugging to find, is the
          capability declaration in the initialize handshake. The JSON-RPC handshake at the
          start of an LSP session includes a list of capabilities the client supports. You
          have to declare textDocument/publishDiagnostics as a supported capability in that
          list. If you omit it, typescript-language-server assumes the client does not want
          push notifications and never sends them. The diagnostics call returns nothing.
          There is no error message. The silence is the failure.
        </p>

        <p style={proseStyle}>
          During the User-to-Account rename on a six-file TypeScript codebase, the executor
          proposed an edit to db.ts on the first attempt. The shadow workspace returned two
          type errors. The executor received the error list, corrected the code, and proposed
          a second version, which committed cleanly. The language server also flagged a
          pre-existing bug in the same file during the validation pass. A variable called all
          was being accessed with .size, but all was an array, not a Set. The executor fixed
          it as part of the same commit. The rename task produced a correct codebase plus one
          pre-existing bug fix.
        </p>

        <h2 style={sectionHeadingStyle}>Agentic Context Retrieval</h2>

        <p style={proseStyle}>
          Embedding-based retrieval assumes the query and the relevant document share enough
          vocabulary that their vector representations will be close in embedding space. This
          assumption holds on documentation and natural language corpora. It fails on
          codebases because the semantic gap between a task description and the code that
          needs to change is too large and too indirect. The request to rename User to
          Account shares no terms with{' '}
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '13px', color: 'rgba(255,255,255,0.7)' }}>
            {'import { User } from \'./types\''}
          </span>{' '}
          in auth.ts. You cannot close that gap with embeddings. The agent needs to navigate
          the codebase iteratively, the way a developer does: start with what is known,
          follow the references, and build up a picture.
        </p>

        <p style={proseStyle}>
          {"Anvil's"} retrieval layer has five tools. read_file provides direct file access
          with optional line ranges, so the agent can fetch only the lines it needs rather
          than reading every file in full. list_files handles directory traversal.
          text_search runs ripgrep for pattern matching across the codebase. find_symbol
          talks to the language server for definition lookup and reference tracking, which
          is how you discover that 19 places import a given type across 3 files. ast_search
          uses tree-sitter for structural queries, returning results like &ldquo;all interface
          declarations&rdquo; or &ldquo;all functions with a return type of User&rdquo;. The key
          design principle is that retrieval is iterative: the planner calls a tool, reads
          the result, decides what to look for next, and repeats. There is no one-shot
          lookup.
        </p>

        <p style={proseStyle}>
          On the rename task, the planner used ast_search to locate the User interface
          definition in types.ts. It then called find_symbol with User as the query and
          received 19 references spread across three files: types.ts, db.ts, and auth.ts.
          It called read_file with exact line ranges on the sections of those files that
          actually contained references. It found everything it needed in six tool calls
          and identified that main.ts and orders.ts required no changes, because those
          files referenced function names rather than the User type itself. The planner
          never read a whole file without a specific reason to do so.
        </p>

        <h2 style={sectionHeadingStyle}>Subagent Isolation</h2>

        <p style={proseStyle}>
          The system has three rules, and each one exists because a concrete failure mode
          follows from violating it. The Planner has no write access, which means it can
          explore the entire codebase without any risk of partial writes leaving the working
          tree in an inconsistent state. The Executor can only read files that appear in the
          plan, which prevents it from pulling in context from unrelated parts of the
          codebase and degrading edit quality. The Orchestrator is the only agent that
          modifies the todo list, which prevents race conditions when subagents run queries
          concurrently and would otherwise both try to update shared state.
        </p>

        <p style={proseStyle}>
          Before the Executor runs, the Orchestrator prints the full plan for user review:
          the goal, a context summary, the list of files to modify, the list of files to
          create, the step sequence, verification criteria, and a risks section noting
          anything that could go wrong or anything that was intentionally left unchanged.
          The user types y to proceed, n to abort, or revise to send feedback back to the
          Planner for another pass. Nothing is written to disk until the user has confirmed.
          This approval gate is the part of the system most coding agents skip, and it is
          the part that makes the system safe enough to run on code you care about.
        </p>

        <h2 style={sectionHeadingStyle}>What Editor-Level Access Would Unlock</h2>

        <p style={proseStyle}>
          The in-memory shadow workspace is a useful approximation but not a complete one.
          A real hidden editor window has the full project loaded into the language server
          with all its cross-file context, module resolution, and type checking state
          initialized from the start. The textDocument/didChange approach works for most
          edits, but occasionally misses diagnostics that depend on file system state the
          in-memory representation does not capture, particularly around module resolution
          for dynamically imported paths. Fixing this category of false negative requires
          owning the editor, not the file system.
        </p>

        <p style={proseStyle}>
          There are three other capabilities that require editor-level access. The first is
          inline diff rendering as edits stream in, so the user can watch changes appear
          character by character rather than seeing a completed diff at the end. The second
          is tab completion interception, which requires knowing the precise cursor position
          in real time and predicting what the user is about to type in context. The third
          is a dedicated apply model: Cursor trains a separate fine-tuned model specifically
          for applying diffs, distinct from the model that generates the edit plan.
          Generation and application are different enough tasks that they benefit from
          different training objectives, and the apply model improves commit accuracy
          measurably.
        </p>

        <h2 style={sectionHeadingStyle}>What I Learned</h2>

        <p style={proseStyle}>
          The hardest part of building Anvil was not the LLM integration. The Anthropic API
          is straightforward. Tool use, streaming, context management: none of it was
          surprising. The hard part was the LSP protocol: understanding the JSON-RPC framing,
          the initialize handshake, the capability negotiation, and especially the silent
          failure mode of publishDiagnostics. The interesting problems in coding agents are
          almost entirely in the scaffold around the model, not the model itself. Getting
          the model reliable, grounded feedback from the tools it is using, in a format it
          can act on, is where the real work is. The next step is building this at the editor
          level, where the feedback loop is tighter and the diagnostics are more accurate.
        </p>

      </article>
    </main>
  );
}
