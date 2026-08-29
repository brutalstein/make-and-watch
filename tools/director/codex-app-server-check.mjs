import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { CodexAppServerClient } from './codex-app-server.mjs';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.killed = false;
    this.pid = 4242;
    this.buffer = '';
    this.requests = [];

    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk) => {
      this.buffer += chunk;
      while (true) {
        const newline = this.buffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        this.#handle(JSON.parse(line));
      }
    });
    this.stdin.on('finish', () => this.#close(0));
  }

  kill() {
    this.killed = true;
    this.#close(0);
    return true;
  }

  #close(code) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    queueMicrotask(() => this.emit('close', code, null));
  }

  #send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  #handle(message) {
    this.requests.push(message);
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;

    if (message.method === 'initialize') {
      this.#send({ id: message.id, result: { userAgent: 'fake', platformFamily: 'windows', platformOs: 'windows' } });
      return;
    }
    if (message.method === 'account/read') {
      this.#send({
        id: message.id,
        result: {
          account: { type: 'chatgpt', email: 'must-not-leak@example.com', planType: 'plus' },
          requiresOpenaiAuth: true,
        },
      });
      return;
    }
    if (message.method === 'account/login/start') {
      this.#send({
        id: message.id,
        result: { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://chatgpt.com/fake-login' },
      });
      return;
    }
    if (message.method === 'thread/start') {
      this.#send({ id: message.id, result: { thread: { id: 'thread-1' } } });
      return;
    }
    if (message.method === 'turn/start') {
      this.#send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
      queueMicrotask(() => {
        const plan = {
          schemaVersion: 1,
          planId: 'fake-plan',
          title: 'Fake plan',
          summary: 'Protocol test',
          mode: 'assist',
          provider: 'codex',
          expectedProjectRevision: 7,
          steps: [{ id: 'fit', type: 'fitWorkflow' }],
        };
        this.#send({
          method: 'item/completed',
          params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'item-1', type: 'agentMessage', text: JSON.stringify(plan), phase: 'final_answer' } },
        });
        this.#send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
        });
      });
      return;
    }
    if (message.method === 'turn/interrupt' || message.method === 'thread/delete' || message.method === 'account/login/cancel') {
      this.#send({ id: message.id, result: {} });
      return;
    }

    this.#send({ id: message.id, error: { code: -32601, message: `unexpected test method ${message.method}` } });
  }
}

let fake = null;
const executable = { path: '/fake/codex', name: 'codex', discovery: 'test', commandShellRequired: false };
const client = new CodexAppServerClient({
  executable,
  processFactory: () => {
    fake = new FakeChild();
    return fake;
  },
});

const account = await client.accountRead();
assert.deepEqual(account, {
  account: { type: 'chatgpt', planType: 'plus' },
  requiresOpenaiAuth: true,
});
assert.equal(JSON.stringify(account).includes('must-not-leak'), false, 'account email must never escape the app-server boundary');

const alreadyConnected = await client.startChatGptLogin();
assert.equal(alreadyConnected.alreadyConnected, true, 'existing ChatGPT account should not start duplicate OAuth');

const plan = await client.runDirectorPlan('MAKEWATCH DIRECTOR MODE\nReturn a small plan.');
assert.equal(plan.provider, 'codex');
assert.equal(plan.expectedProjectRevision, 7);

const threadRequest = fake.requests.find((request) => request.method === 'thread/start');
assert.ok(threadRequest, 'Director planning must create a thread');
assert.equal(threadRequest.params.approvalPolicy, 'never');
assert.equal(threadRequest.params.sandbox, 'read-only', 'thread sandbox enum must use the documented wire value');

const turnRequest = fake.requests.find((request) => request.method === 'turn/start');
assert.ok(turnRequest, 'Director planning must use turn/start');
assert.equal(turnRequest.params.approvalPolicy, 'never');
assert.equal(turnRequest.params.sandboxPolicy.type, 'read-only', 'turn sandbox enum must use the documented wire value');
assert.equal(turnRequest.params.sandboxPolicy.access.type, 'restricted');
assert.ok(turnRequest.params.outputSchema, 'Director planning must send the schema through app-server');
assert.ok(fake.requests.some((request) => request.method === 'thread/delete'), 'completed Director threads must be deleted');

await client.shutdown();
console.log('codex app-server protocol check: passed');
