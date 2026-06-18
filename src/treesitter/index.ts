import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { extname } from 'path';

const require = createRequire(import.meta.url);

// Lazy-loaded to avoid startup cost
let _Parser: any = null;
let _tsGrammar: any = null;
let _tsxGrammar: any = null;
let _pyGrammar: any = null;

function getParser(grammar: any): any {
  if (!_Parser) {
    _Parser = require('tree-sitter');
    const ts = require('tree-sitter-typescript');
    _tsGrammar = ts.typescript;
    _tsxGrammar = ts.tsx;
    _pyGrammar = require('tree-sitter-python');
  }
  const parser = new _Parser();
  parser.setLanguage(grammar);
  return parser;
}

function grammarForExt(ext: string): any | null {
  if (!_Parser) {
    // Force init
    getParser(null);
  }
  switch (ext) {
    case '.ts': return _tsGrammar;
    case '.tsx': return _tsxGrammar;
    case '.js': case '.jsx': case '.mjs': case '.cjs': return _tsGrammar;
    case '.py': return _pyGrammar;
    default: return null;
  }
}

export type QueryType = 'functions' | 'classes' | 'imports' | 'interfaces' | 'types';

export interface AstNode {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
}

export interface ParsedFile {
  tree: any;
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

  const parser = getParser(grammar);
  const tree = parser.parse(content);
  return { tree, content };
}

export function queryNodes(tree: any, queryType: QueryType): AstNode[] {
  const results: AstNode[] = [];
  visitNode(tree.rootNode, queryType, results);
  return results;
}

function visitNode(node: any, queryType: QueryType, out: AstNode[]): void {
  const match = matchNode(node, queryType);
  if (match) out.push(match);

  for (let i = 0; i < node.childCount; i++) {
    visitNode(node.child(i), queryType, out);
  }
}

function matchNode(node: any, queryType: QueryType): AstNode | null {
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

function namedNode(node: any, kind: string): AstNode | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  return {
    kind,
    name: nameNode.text,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function findArrowFunction(declNode: any): AstNode | null {
  for (let i = 0; i < declNode.childCount; i++) {
    const child = declNode.child(i);
    if (child.type !== 'variable_declarator') continue;
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

function importNode(node: any): AstNode {
  const sourceNode = node.childForFieldName('source');
  const source = sourceNode ? sourceNode.text.replace(/['"]/g, '') : '?';
  // Extract what's being imported from the import clause
  let clauseText = '';
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'import_clause') {
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
