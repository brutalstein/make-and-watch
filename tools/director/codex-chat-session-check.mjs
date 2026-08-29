import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { CodexChatSession } from './codex-chat-session.mjs';

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.isRunning = true;
    this.requests = [];
    this.turn = 0;
  }
  async start() {}
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'chat-thread-1' } };
    if (method === 'thread/delete' || method === 'turn/interrupt') return {};
    if (method === 'turn/start') {
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
assert.equal(await chat.send(threadId, 'first message'), 'reply 1');
assert.equal(await chat.send(threadId, 'second message'), 'reply 2');
const turns = client.requests.filter((request) => request.method === 'turn/start');
assert.equal(turns.length, 2);
assert.equal(turns[0].params.threadId, turns[1].params.threadId, 'multi-turn chat must keep one Codex thread');
assert.equal(turns[0].params.approvalPolicy, 'never');
assert.equal(turns[0].params.sandboxPolicy.type, 'readOnly');
await chat.deleteThread(threadId);
assert.ok(client.requests.some((request) => request.method === 'thread/delete'));

console.log('codex chat-session check: passed');
