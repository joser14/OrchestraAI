// Tool-call rescue: tool calls Qwen3 wrote inside its thinking become real tool calls; nothing else changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rescueToolCalls, patchReply, startOllamaProxy, UPSTREAM } from '../src/ollamaproxy.ts';

test('the exact failure seen on 2026-10-14: a tool call inside unclosed thinking', () => {
  const calls = rescueToolCalls('<tool_call>\n{"name": "team_sleep", "arguments": {"minutes": 20}}\n</tool_call>');
  assert.deepEqual(calls, [{ function: { name: 'team_sleep', arguments: { minutes: 20 } } }]);
});

test('several calls, string arguments, bad JSON and unclosed blocks', () => {
  const t = 'thinking... <tool_call>{"name":"team_brief","arguments":{}}</tool_call> then <tool_call>{"name":"team_assign","arguments":"{\\"worker\\":\\"worker\\",\\"job\\":\\"x\\"}"}</tool_call> <tool_call>{broken}</tool_call> <tool_call>{"name":"team_post"';
  assert.deepEqual(rescueToolCalls(t).map((c) => c.function.name), ['team_brief', 'team_assign']);
  assert.deepEqual(rescueToolCalls(t)[1].function.arguments, { worker: 'worker', job: 'x' });
});

test('a reply that already has tool calls, or none written anywhere, is left alone', () => {
  const real = { message: { role: 'assistant', content: '', thinking: '<tool_call>{"name":"a","arguments":{}}</tool_call>', tool_calls: [{ function: { name: 'b', arguments: {} } }] } };
  assert.equal(patchReply(real).reply, real);
  const plain = { message: { role: 'assistant', content: 'Hello', thinking: 'let me think' } };
  assert.equal(patchReply(plain).rescued, 0);
});

test('streamed through the proxy: the rescued call arrives before the final chunk', async () => {
  // a fake Ollama on the upstream port is not possible while the real one runs, so point the proxy at a stub
  const stub = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ model: 'm', message: { role: 'assistant', content: '', thinking: '<tool_call>\n{"name": "team_brief", ' }, done: false }) + '\n');
    res.write(JSON.stringify({ model: 'm', message: { role: 'assistant', content: '', thinking: '"arguments": {}}\n</tool_call>' }, done: false }) + '\n');
    res.end(JSON.stringify({ model: 'm', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n');
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  const saved = { ...UPSTREAM }; UPSTREAM.port = (stub.address() as any).port;
  const proxy = startOllamaProxy(() => {}, 0);   // a free port: the running service may hold the real one
  await new Promise((r) => setTimeout(r, 100));
  try {
    const text = await (await fetch(`http://127.0.0.1:${(proxy.address() as any).port}/api/chat`, { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [] }) })).text();
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 4);
    assert.deepEqual(lines[2].message.tool_calls, [{ function: { name: 'team_brief', arguments: {} } }]);
    assert.equal(lines[3].done, true);
  } finally { proxy.close(); stub.close(); UPSTREAM.port = saved.port; }
});
