// Run: node packages/chat-runtime/examples/ask-in-node.ts
import { createServer } from 'node:http';
import { createChatRuntime } from '@az/chat-runtime/runtime.ts';
import { nodeModelBridge } from '@az/chat-runtime/node-bridge.ts';

// A stand-in provider on this machine that speaks the completions shape, so the example runs offline.
// Point `url` at a real provider instead, and read its key from the environment.
const provider = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const say = (content: string) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  say('We ship within two working days.\n\n');
  say('cta "Contact us" /contact\n');
  say('cta "Wire money" https://elsewhere.example\n');
  res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 800, completion_tokens: 30 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const { port } = provider.address() as { port: number };

const chat = createChatRuntime({
  model: nodeModelBridge({ url: `http://127.0.0.1:${port}/v1`, key: process.env.MODEL_KEY ?? '', model: 'default' }),
  instructions: { appName: 'Acme Lamps', components: ['cta'], destinations: ['/contact'], content: { notes: ['Orders ship within two working days.'] } },
  checker: { components: ['cta'], destinations: ['/contact'] },
  budget: { tokensPerDay: 50_000 },
});

// The checker's events: prose, the link to a page the app allows, and nothing for the one it does not.
for await (const e of chat.ask('first-conversation', 'How fast do you ship?')) {
  if (e.type === 'text') console.log(`text  ${JSON.stringify(e.s)}`);
  if (e.type === 'block') console.log(`block ${JSON.stringify(e.block)}`);
  if (e.type === 'done') console.log(`done  ${e.left} questions left; kept as ${JSON.stringify(e.text)}`);
}
console.log((await chat.list()).map((c) => c.title));
provider.close();
