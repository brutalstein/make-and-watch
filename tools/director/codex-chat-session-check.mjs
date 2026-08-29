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
    if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] } };
    if (method === 'thread/read') return { thread: { id: params.threadId, turns: params.includeTurns ? [{ id: 'old-turn' }] : [] } };
    if (method === 'thread/unarchive') return { thread: { id: params.threadId } };
    if (method === 'thread/delete' || method === 'thread/archive' || method === 'thread/unsubscribe'
        || method === 'thread/name/set' || method === 'turn/interrupt') return {};
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
assert.equal(Object.prototype.hasOwnProperty.call(threadStart.params, 'ephemeral'), false, 'Director chat threads must be persistent for archive/resume');
assert.deepEqual(threadStart.params.dynamicTools, client.tools, 'chat thread must advertise only host-provided Make & Watch dynamic tools');

assert.equal(await chat.send(threadId, 'first message'), 'reply 1');
assert.equal(await chat.send(threadId, 'second message'), 'reply 2');
const turns = client.requests.filter((request) => request.method === 'turn/start');
assert.equal(turns.length, 2);
assert.equal(turns[0].params.threadId, turns[1].params.threadId, 'multi-turn chat must keep one Codex thread');
assert.equal(client.requests.filter((request) => request.method === 'thread/resume').length, 0, 'freshly started attached thread must not pay a redundant resume round-trip');

await chat.nameThread(threadId, 'Mira continuity');
const nameRequest = client.requests.find((request) => request.method === 'thread/name/set');
assert.equal(nameRequest.params.name, 'Mira continuity');
const read = await chat.readThread(threadId, true);
assert.equal(read.id, threadId);

await chat.unsubscribeThread(threadId);
assert.ok(client.requests.some((request) => request.method === 'thread/unsubscribe'));

// Simulate a process/UI session returning later: a fresh chat wrapper must resume the
// exact persisted thread instead of creating a new one or replaying the transcript.
const resumedChat = new CodexChatSession(client);
assert.equal(await resumedChat.send(threadId, 'after restart'), 'reply 3');
const resumeRequest = client.requests.find((request) => request.method === 'thread/resume');
assert.ok(resumeRequest, 'stored Director sessions must use the official thread/resume path');
assert.equal(resumeRequest.params.threadId, threadId);
assert.equal(resumeRequest.params.excludeTurns, true, 'resume should avoid retransmitting old turns when supported');
assert.equal(resumeRequest.params.permissions, ':read-only');

await resumedChat.archiveThread(threadId);
assert.ok(client.requests.some((request) => request.method === 'thread/archive'));
await resumedChat.unarchiveThread(threadId);
assert.ok(client.requests.some((request) => request.method === 'thread/unarchive'));

const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
client.failNextTurnStart = true;
await assert.rejects(resumedChat.send(threadId, 'failing message'), /simulated chat turn\/start failure/);
await new Promise((resolvePromise) => setImmediate(resolvePromise));
process.off('unhandledRejection', onUnhandled);
assert.equal(unhandled.length, 0, 'chat turn/start rejection must never terminate the bridge through an orphaned promise');

const deletesBeforeShutdown = client.requests.filter((request) => request.method === 'thread/delete').length;
await resumedChat.shutdown();
assert.equal(
  client.requests.filter((request) => request.method === 'thread/delete').length,
  deletesBeforeShutdown,
  'bridge/session shutdown must never delete persisted Director conversations',
);

await resumedChat.deleteThread(threadId);
assert.equal(client.requests.filter((request) => request.method === 'thread/delete').length, deletesBeforeShutdown + 1, 'hard delete must remain explicit');

console.log('codex chat-session check: passed');
