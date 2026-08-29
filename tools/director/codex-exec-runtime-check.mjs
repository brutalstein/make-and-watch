import assert from 'node:assert/strict';

import {
  appendCompatibilityTranscript,
  extractUserMessage,
  parseCodexExecHelp,
  parseCodexLoginStatus,
  renderCompatibilityChatPrompt,
} from './codex-exec-runtime.mjs';

const login = parseCodexLoginStatus({ code: 0, stdout: 'Logged in using ChatGPT', stderr: '' });
assert.equal(login.authenticated, true);
assert.equal(login.authMethod, 'chatgpt');
assert.equal(parseCodexLoginStatus({ code: 1, stdout: 'Not logged in', stderr: '' }).authenticated, false);

const help = parseCodexExecHelp({
  code: 0,
  stdout: 'codex exec --sandbox MODE --output-last-message FILE --output-schema FILE',
  stderr: '',
});
assert.equal(help.chatAvailable, true);
assert.equal(help.planAvailable, true);

const extracted = extractUserMessage('header\n\nUser message:\n\nhello from Studio');
assert.equal(extracted, 'hello from Studio');

let transcript = [];
transcript = appendCompatibilityTranscript(transcript, 'user', 'first');
transcript = appendCompatibilityTranscript(transcript, 'assistant', 'reply');
for (let index = 0; index < 20; index += 1) transcript = appendCompatibilityTranscript(transcript, 'user', `message-${index}`);
assert.ok(transcript.length <= 10);
const rendered = renderCompatibilityChatPrompt('current turn', transcript);
assert.ok(rendered.includes('MAKEWATCH CODEX EXEC COMPATIBILITY CHAT'));
assert.ok(rendered.includes('current turn'));
assert.ok(rendered.length < 20_000);

console.log('codex exec compatibility check: passed');
