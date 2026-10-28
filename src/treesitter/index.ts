import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { extname } from 'path';
import type Parser from 'tree-sitter';

type Language = Parameters<Parser['setLanguage']>[0];

const require = createRequire(import.meta.url);

// Native modules load only when AST retrieval is requested.
let ParserClass: typeof Parser | undefined;
const grammars = new Map<string, Language>();

function grammarForExt(ext: string): Language | null {
  if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'].includes(ext)) return null;
  ParserClass ??= require('tree-sitter') as typeof Parser;
  if (!grammars.has(ext)) {
    if (ext === '.py') grammars.set(ext, require('tree-sitter-python') as Language);
    else {
      const ts = require('tree-sitter-typescript') as { typescript: Language; tsx: Language };
      grammars.set(ext, ext === '.tsx' || ext === '.jsx' ? ts.tsx : ts.typescript);
    }
  }
  return grammars.get(ext)!;
}

export type QueryType = 'functions' | 'classes' | 'imports' | 'interfaces' | 'types';

export interface AstNode {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
}

export interface ParsedFile {
  tree: Parser.Tree;
  content: string;
}

export function parseFile(filePath: string): ParsedFile | null {
  const ext = extname(filePath).toLowerCase();
  const grammar = grammarForExt(ext);
  if (!grammar) return null;

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const parser = new ParserClass!();
  parser.setLanguage(grammar);
  const tree = parser.parse(content);
  return tree ? { tree, content } : null;
}

export function queryNodes(tree: Parser.Tree, queryType: QueryType): AstNode[] {
  const results: AstNode[] = [];
  visitNode(tree.rootNode, queryType, results);
  return results;
}

function visitNode(node: Parser.SyntaxNode, queryType: QueryType, out: AstNode[]): void {
  const match = matchNode(node, queryType);
  if (match) out.push(match);

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) visitNode(child, queryType, out);
  }
}

function matchNode(node: Parser.SyntaxNode, queryType: QueryType): AstNode | null {
  const type: string = node.type;

  switch (queryType) {
    case 'functions':
      // Named function declarations
      if (type === 'function_declaration' || type === 'function_definition') {
        return namedNode(node, 'function');
      }
      // Class methods
      if (type === 'method_definition' || type === 'method_signature') {
        return namedNode(node, 'method');
      }
      // const foo = () => {} or const foo = function() {}
      if (type === 'lexical_declaration' || type === 'variable_declaration') {
        return findArrowFunction(node);
      }
      return null;

    case 'classes':
      if (type === 'class_declaration' || type === 'class_definition') {
        return namedNode(node, 'class');
      }
      return null;

    case 'imports':
      if (type === 'import_statement') {
        return importNode(node);
      }
      // Python: import_from_statement
      if (type === 'import_from_statement') {
        return {
          kind: 'import',
          name: node.text.split('\n')[0].trim(),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        };
      }
      return null;

    case 'interfaces':
      if (type === 'interface_declaration') {
        return namedNode(node, 'interface');
      }
      return null;

    case 'types':
      if (type === 'type_alias_declaration') {
        return namedNode(node, 'type');
      }
      return null;
  }
}

function namedNode(node: Parser.SyntaxNode, kind: string): AstNode | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  return {
    kind,
    name: nameNode.text,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function findArrowFunction(declNode: Parser.SyntaxNode): AstNode | null {
  for (let i = 0; i < declNode.childCount; i++) {
    const child = declNode.child(i);
    if (child?.type !== 'variable_declarator') continue;
    const value = child.childForFieldName('value');
    if (!value) continue;
    if (value.type === 'arrow_function' || value.type === 'function') {
      const nameNode = child.childForFieldName('name');
      if (!nameNode) continue;
      return {
        kind: 'arrow_function',
        name: nameNode.text,
        startLine: declNode.startPosition.row + 1,
        endLine: declNode.endPosition.row + 1,
      };
    }
  }
  return null;
}

function importNode(node: Parser.SyntaxNode): AstNode {
  const sourceNode = node.childForFieldName('source');
  const source = sourceNode ? sourceNode.text.replace(/['"]/g, '') : '?';
  // Extract what's being imported from the import clause
  let clauseText = '';
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'import_clause') {
      clauseText = child.text;
      break;
    }
  }
  const name = clauseText ? `${clauseText} from '${source}'` : `'${source}'`;
  return {
    kind: 'import',
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}
