import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { CodexChatSession } from './codex-chat-session.mjs';

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.isRunning = true;
    this.requests = [];
    this.turn = 0;
    this.failNextTurnStart = false;
    this.tools = [{
      type: 'namespace',
      name: 'makewatch',
      description: 'Make & Watch tools',
      tools: [{
        type: 'function',
        name: 'project_snapshot',
        description: 'Read project',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      }],
    }];
  }
  async start() {}
  dynamicToolSpecs() { return this.tools; }
  readOnlyThreadSecurityParams() { return { permissions: ':read-only' }; }
  readOnlyTurnSecurityParams() { return { permissions: ':read-only' }; }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'chat-thread-1' } };
    if (method === 'thread/delete' || method === 'turn/interrupt') return {};
    if (method === 'turn/start') {
      if (this.failNextTurnStart) {
        this.failNextTurnStart = false;
        throw new Error('simulated chat turn/start failure');
      }
      this.turn += 1;
      const turnId = `chat-turn-${this.turn}`;
      queueMicrotask(() => {
        this.emit('item/completed', { threadId: params.threadId, turnId, item: { type: 'agentMessage', text: `reply ${this.turn}` } });
        this.emit('turn/completed', { threadId: params.threadId, turn: { id: turnId, status: 'completed', items: [] } });
      });
      return { turn: { id: turnId, status: 'inProgress' } };
    }
    throw new Error(`unexpected ${method}`);
  }
}

const client = new FakeClient();
const chat = new CodexChatSession(client);
const threadId = await chat.createThread();
assert.equal(threadId, 'chat-thread-1');

const threadStart = client.requests.find((request) => request.method === 'thread/start');
assert.ok(threadStart, 'chat must create a Codex thread');
assert.equal(threadStart.params.approvalPolicy, 'never');
assert.equal(threadStart.params.permissions, ':read-only');
assert.equal(Object.prototype.hasOwnProperty.call(threadStart.params, 'sandbox'), false);
assert.deepEqual(threadStart.params.dynamicTools, client.tools, 'chat thread must advertise only host-provided Make & Watch dynamic tools');

assert.equal(await chat.send(threadId, 'first message'), 'reply 1');
assert.equal(await chat.send(threadId, 'second message'), 'reply 2');
const turns = client.requests.filter((request) => request.method === 'turn/start');
assert.equal(turns.length, 2);
assert.equal(turns[0].params.threadId, turns[1].params.threadId, 'multi-turn chat must keep one Codex thread');
assert.equal(turns[0].params.approvalPolicy, 'never');
assert.equal(turns[0].params.permissions, ':read-only');
assert.equal(Object.prototype.hasOwnProperty.call(turns[0].params, 'sandboxPolicy'), false);
assert.equal(Object.prototype.hasOwnProperty.call(turns[0].params, 'dynamicTools'), false, 'dynamic tools are thread capabilities and must not be redundantly sent on every turn');

const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
client.failNextTurnStart = true;
await assert.rejects(chat.send(threadId, 'failing message'), /simulated chat turn\/start failure/);
await new Promise((resolvePromise) => setImmediate(resolvePromise));
process.off('unhandledRejection', onUnhandled);
assert.equal(unhandled.length, 0, 'chat turn/start rejection must never terminate the bridge through an orphaned promise');

await chat.deleteThread(threadId);
assert.ok(client.requests.some((request) => request.method === 'thread/delete'));

console.log('codex chat-session check: passed');
