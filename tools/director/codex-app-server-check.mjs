import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { CodexAppServerClient } from './codex-app-server.mjs';

class FakeChild extends EventEmitter {
  constructor({ profilesSupported = true } = {}) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.killed = false;
    this.pid = 4242;
    this.buffer = '';
    this.requests = [];
    this.serverResponses = [];
    this.profilesSupported = profilesSupported;
    this.failNextTurnStart = false;

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

  sendServerRequest(message) {
    this.#send(message);
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
    if (Object.prototype.hasOwnProperty.call(message, 'id') && typeof message.method !== 'string') {
      this.serverResponses.push(message);
      return;
    }
    this.requests.push(message);
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;

    if (message.method === 'initialize') {
      this.#send({ id: message.id, result: { userAgent: 'fake', platformFamily: 'windows', platformOs: 'windows' } });
      return;
    }
    if (message.method === 'permissionProfile/list') {
      if (!this.profilesSupported) {
        this.#send({ id: message.id, error: { code: -32601, message: 'method not found: permissionProfile/list' } });
        return;
      }
      this.#send({
        id: message.id,
        result: {
          data: [
            { id: ':read-only', description: null, allowed: true },
            { id: ':workspace', description: null, allowed: true },
          ],
          nextCursor: null,
        },
      });
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
      if (this.failNextTurnStart) {
        this.failNextTurnStart = false;
        this.#send({ id: message.id, error: { code: -32602, message: 'simulated turn/start failure' } });
        return;
      }
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

const executable = { path: '/fake/codex', name: 'codex', discovery: 'test', commandShellRequired: false };
let fake = null;
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
assert.equal(client.readOnlyPermissionMode, 'profile', 'modern App Server should use named permission profiles');

const initializeRequest = fake.requests.find((request) => request.method === 'initialize');
assert.equal(initializeRequest?.params?.capabilities?.experimentalApi, true, 'permission profiles and dynamic tools require experimentalApi capability opt-in');
const profileRequest = fake.requests.find((request) => request.method === 'permissionProfile/list');
assert.ok(profileRequest, 'App Server startup must discover permission profiles');
const normalizedRuntimeCwd = profileRequest.params.cwd.replaceAll('\\', '/');
assert.equal(normalizedRuntimeCwd.endsWith('tools/director/runtime'), true, 'permission profile discovery must use the Director runtime cwd on every platform');

const alreadyConnected = await client.startChatGptLogin();
assert.equal(alreadyConnected.alreadyConnected, true, 'existing ChatGPT account should not start duplicate OAuth');

const plan = await client.runDirectorPlan('MAKEWATCH DIRECTOR MODE\nReturn a small plan.');
assert.equal(plan.provider, 'codex');
assert.equal(plan.expectedProjectRevision, 7);

const threadRequest = fake.requests.find((request) => request.method === 'thread/start');
assert.ok(threadRequest, 'Director planning must create a thread');
assert.equal(threadRequest.params.approvalPolicy, 'never');
assert.equal(threadRequest.params.permissions, ':read-only', 'modern thread/start must select the built-in read-only permission profile');
assert.equal(Object.prototype.hasOwnProperty.call(threadRequest.params, 'sandbox'), false, 'permissions and legacy sandbox must never be sent together');
assert.equal(Object.prototype.hasOwnProperty.call(threadRequest.params, 'dynamicTools'), false, 'plan-preview threads must not receive mutation tools');

const turnRequest = fake.requests.find((request) => request.method === 'turn/start');
assert.ok(turnRequest, 'Director planning must use turn/start');
assert.equal(turnRequest.params.approvalPolicy, 'never');
assert.equal(turnRequest.params.permissions, ':read-only', 'modern turn/start must keep the read-only permission profile');
assert.equal(Object.prototype.hasOwnProperty.call(turnRequest.params, 'sandboxPolicy'), false, 'permissions and sandboxPolicy must never be sent together');
assert.ok(turnRequest.params.outputSchema, 'Director planning must send the schema through app-server');
assert.ok(fake.requests.some((request) => request.method === 'thread/delete'), 'completed Director threads must be deleted');

const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
fake.failNextTurnStart = true;
await assert.rejects(client.runDirectorPlan('simulate rejected turn/start'), /simulated turn\/start failure/);
await new Promise((resolvePromise) => setImmediate(resolvePromise));
process.off('unhandledRejection', onUnhandled);
assert.equal(unhandled.length, 0, 'rejected turn/start must not leave an orphaned completion rejection');

await client.shutdown();

let toolFake = null;
const toolCalls = [];
const dynamicTools = [{
  type: 'namespace',
  name: 'makewatch',
  description: 'test namespace',
  tools: [{
    type: 'function',
    name: 'project_snapshot',
    description: 'test tool',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  }],
}];
const toolClient = new CodexAppServerClient({
  executable,
  dynamicTools,
  dynamicToolHandler: async (call) => {
    toolCalls.push(call);
    if (call.tool === 'fail') throw new Error('simulated tool failure');
    return JSON.stringify({ projectRevision: 11, nodes: [] });
  },
  processFactory: () => {
    toolFake = new FakeChild();
    return toolFake;
  },
});
await toolClient.accountRead();
assert.deepEqual(toolClient.dynamicToolSpecs(), dynamicTools, 'configured dynamic tool specs must remain available to chat threads');

toolFake.sendServerRequest({
  id: 9001,
  method: 'item/tool/call',
  params: {
    threadId: 'thread-tools',
    turnId: 'turn-tools',
    callId: 'call-tools',
    namespace: 'makewatch',
    tool: 'project_snapshot',
    arguments: {},
  },
});
await new Promise((resolvePromise) => setImmediate(resolvePromise));
assert.equal(toolCalls.length, 1);
assert.equal(toolCalls[0].namespace, 'makewatch');
assert.equal(toolCalls[0].tool, 'project_snapshot');
const toolResponse = toolFake.serverResponses.find((response) => response.id === 9001);
assert.equal(toolResponse?.result?.success, true, 'successful host tool execution must return an App Server tool result');
assert.equal(toolResponse.result.contentItems[0].type, 'inputText');
assert.equal(JSON.parse(toolResponse.result.contentItems[0].text).projectRevision, 11);

toolFake.sendServerRequest({
  id: 9002,
  method: 'workspace/write-file',
  params: {},
});
await new Promise((resolvePromise) => setImmediate(resolvePromise));
const rejectedServerRequest = toolFake.serverResponses.find((response) => response.id === 9002);
assert.equal(rejectedServerRequest?.error?.code, -32601, 'all non-tool server requests must remain fail-closed');
await toolClient.shutdown();

let legacyFake = null;
const legacyClient = new CodexAppServerClient({
  executable,
  processFactory: () => {
    legacyFake = new FakeChild({ profilesSupported: false });
    return legacyFake;
  },
});
await legacyClient.accountRead();
assert.equal(legacyClient.readOnlyPermissionMode, 'legacy', 'older App Server builds should fall back without restricted access fields');
await legacyClient.runDirectorPlan('legacy compatibility plan');
const legacyThread = legacyFake.requests.find((request) => request.method === 'thread/start');
const legacyTurn = legacyFake.requests.find((request) => request.method === 'turn/start');
assert.equal(legacyThread.params.sandbox, 'read-only');
assert.equal(Object.prototype.hasOwnProperty.call(legacyThread.params, 'permissions'), false);
assert.deepEqual(legacyTurn.params.sandboxPolicy, { type: 'readOnly' });
assert.equal(Object.prototype.hasOwnProperty.call(legacyTurn.params.sandboxPolicy, 'access'), false, 'deprecated readOnly.access must never be emitted');
await legacyClient.shutdown();

console.log('codex app-server protocol check: passed');
