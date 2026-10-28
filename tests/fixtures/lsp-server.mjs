#!/usr/bin/env node
let buffer = Buffer.alloc(0);
const send = (message, fragmented = false) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  if (!fragmented) { process.stdout.write(frame); return; }
  const split = frame.indexOf(Buffer.from('錯')) + 1;
  process.stdout.write(frame.subarray(0, split));
  setTimeout(() => process.stdout.write(frame.subarray(split)), 10);
};
function handle(msg) {
  if (msg.method === 'initialize') send({ id: msg.id, result: { capabilities: {} } });
  if (msg.method === 'shutdown') send({ id: msg.id, result: null });
  if (msg.method === 'exit') process.exit(0);
  if (!['textDocument/didOpen', 'textDocument/didChange'].includes(msg.method)) return;
  const doc = msg.params.textDocument;
  const text = doc.text ?? msg.params.contentChanges[0].text;
  if (text === 'SILENT') return;
  if (text === 'EXIT') { process.exit(2); return; }
  const diagnostics = text === 'CLEAN' ? [] : [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: '錯誤: café 🚀' }];
  if (text === 'STALE') {
    send({ method: 'textDocument/publishDiagnostics', params: { uri: doc.uri, version: doc.version - 1, diagnostics: [] } });
  }
  setTimeout(() => send({ method: 'textDocument/publishDiagnostics', params: { uri: doc.uri, version: doc.version, diagnostics } }, text === 'UNICODE'), 30);
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const sep = buffer.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, sep).toString())[1]);
    if (buffer.length < sep + 4 + length) return;
    const msg = JSON.parse(buffer.subarray(sep + 4, sep + 4 + length).toString());
    buffer = buffer.subarray(sep + 4 + length); handle(msg);
  }
});
