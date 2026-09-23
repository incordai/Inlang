/**
 * @az module mcp-server
 * Purpose: MCP over stdio: JSON-RPC framing, initialize, tools, resources.
 * Spec: docs/mcp.md
 * Exports: serve, handle, PROTOCOL_VERSIONS
 * Edit guide: imports Node built-ins only; stdout is the protocol, logs go to stderr.
 * Tests: packages/mcp/test/mcp.test.ts
 */

/**
 * `az mcp` — the Model Context Protocol over stdio.
 *
 * Newline-delimited JSON-RPC 2.0 (the MCP stdio transport): one message per
 * line on stdin, one per line on stdout, logs on stderr only. The protocol
 * surface a tool server needs is small — initialize, ping, tools/list,
 * tools/call, resources/list, resources/read — so it is implemented here
 * rather than taken from the reference SDK, which brings an HTTP server
 * stack a stdio server never uses (docs/stack-evaluation.md).
 */

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { sandbox } from './sandbox.ts';
import { isUserError, TOOLS, ToolFailure, validate, type Toolbox } from './tools.ts';

/** Protocol revisions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** JSON-RPC 2.0 error codes. */
const ERR = { parse: -32700, request: -32600, method: -32601, params: -32602, internal: -32603 } as const;

const GRAMMAR_URI = 'az://grammar';

export interface ServerOptions {
  readonly root: string;
  readonly toolbox: Toolbox;
  readonly version: string;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly log?: (line: string) => void;
}

type Id = string | number;
interface Request { jsonrpc: '2.0'; id?: Id; method: string; params?: Record<string, unknown> }

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Answer one parsed message; null for a notification. */
export function handle(
  msg: unknown, root: string, toolbox: Toolbox, version: string,
  log: (line: string) => void = () => {},
): unknown {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    // Batches were removed from the protocol (2025-06-18); refuse them too.
    return { jsonrpc: '2.0', id: null, error: { code: ERR.request, message: 'expected one JSON-RPC request object' } };
  }
  const req = msg as Request;
  const isNotification = !('id' in req);
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return isNotification ? null
      : { jsonrpc: '2.0', id: req.id ?? null, error: { code: ERR.request, message: 'not a JSON-RPC 2.0 request' } };
  }
  try {
    const result = dispatch(req, root, toolbox, version);
    return isNotification ? null : { jsonrpc: '2.0', id: req.id, result };
  } catch (e) {
    if (!(e instanceof RpcError)) log(`az mcp: ${(e as Error).stack ?? String(e)}`);
    if (isNotification) return null;
    const code = e instanceof RpcError ? e.code : ERR.internal;
    const message = e instanceof RpcError ? e.message : 'internal error';
    return { jsonrpc: '2.0', id: req.id, error: { code, message } };
  }
}

function dispatch(req: Request, root: string, toolbox: Toolbox, version: string): unknown {
  const params = req.params ?? {};
  switch (req.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked as string)
        ? asked : PROTOCOL_VERSIONS[0];
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'az', version },
        instructions: 'Tools for the az website compiler. Start with az_words and az_grammar, '
          + 'write a .az file, then az_check it. Read-only tools never run code from the project. '
          + 'az_build runs the project\'s own words (its words/ folder) as a build does — only call '
          + 'it on a project you trust. Tools marked WRITES FILES change the project; every path is '
          + 'confined to the project root. After editing an ejected word, restart this server.',
      };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return {};
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: TOOLS.map(({ name, description, inputSchema, annotations }) =>
          ({ name, description, inputSchema, annotations })),
      };
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) throw new RpcError(ERR.params, `unknown tool: ${String(params.name)}`);
      try {
        // The sandbox is built per call: a root deleted mid-session is then a
        // tool error the client reads, not an exception that left the
        // request unanswered.
        const data = tool.run(validate(tool, params.arguments), toolbox, sandbox(root));
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: false };
      } catch (e) {
        // A failure the client can act on is a tool RESULT with isError, so
        // the agent reads it (MCP); anything else is an internal error, and
        // its message stays in the server log rather than reaching the client.
        if (isUserError(e)) return { content: [{ type: 'text', text: e.message }], isError: true };
        throw e;
      }
    }
    case 'resources/list':
      return {
        resources: [{
          uri: GRAMMAR_URI, name: 'grammar', title: 'The .az grammar', mimeType: 'text/markdown',
          description: 'GRAMMAR.md: syntax, values, placement rules and diagnostics.',
        }],
      };
    case 'resources/read': {
      if (params.uri !== GRAMMAR_URI) throw new RpcError(ERR.params, `unknown resource: ${String(params.uri)}`);
      return { contents: [{ uri: GRAMMAR_URI, mimeType: 'text/markdown', text: toolbox.grammar() }] };
    }
    default:
      throw new RpcError(ERR.method, `method not found: ${req.method}`);
  }
}

/** Serve until stdin closes. */
export function serve(options: ServerOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const log = options.log ?? ((line) => process.stderr.write(line + '\n'));
  // Fail at start, not on the first call, when the root itself is unusable.
  sandbox(options.root);
  // stdout carries the protocol and nothing else. Any other write to it — a
  // console.log in a project's own word, run by az_build — would corrupt the
  // stream, so while serving it is redirected to stderr, and replies go
  // through the original writer captured here.
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const send = options.output
    ? (text: string) => { options.output?.write(text); }
    : (text: string) => { stdoutWrite(text); };
  if (!options.output) process.stdout.write = process.stderr.write.bind(process.stderr);
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: ERR.parse, message: 'parse error' } }) + '\n');
      return;
    }
    let reply: unknown;
    try {
      reply = handle(msg, options.root, options.toolbox, options.version, log);
    } catch (e) {
      log(`az mcp: ${(e as Error).stack ?? String(e)}`);
      return;
    }
    if (reply !== null) send(JSON.stringify(reply) + '\n');
  });
  return new Promise((done) => lines.once('close', () => {
    if (!options.output) process.stdout.write = stdoutWrite;
    done();
  }));
}

export { ToolFailure };
