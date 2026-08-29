import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_TRANSCRIPT_MESSAGES = 10;
const MAX_TRANSCRIPT_CHARS = 10_000;
const MAX_USER_TRANSCRIPT_CHARS = 2_800;
const MAX_ASSISTANT_TRANSCRIPT_CHARS = 5_000;

function boundedText(value, maximum) {
  const text = String(value ?? '').trim();
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

export function parseCodexLoginStatus(result) {
  const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.replace(/[\r\n\t]+/g, ' ').trim();
  const signedOut = /not\s+logged|logged\s*out|sign\s*in\s+required|no\s+active/i.test(text);
  const chatgpt = /chatgpt/i.test(text);
  const authenticated = Number(result?.code) === 0 && !signedOut && (chatgpt || /logged\s+in|authenticated/i.test(text));
  return {
    authenticated,
    authMethod: authenticated && chatgpt ? 'chatgpt' : authenticated ? 'codex-cli' : '',
    detail: boundedText(text, 220),
  };
}

export function parseCodexExecHelp(result) {
  const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  const available = Number(result?.code) === 0;
  return {
    available,
    hasSandbox: text.includes('--sandbox'),
    hasOutputLastMessage: text.includes('--output-last-message'),
    hasOutputSchema: text.includes('--output-schema'),
    chatAvailable: available && text.includes('--sandbox') && text.includes('--output-last-message'),
    planAvailable: available && text.includes('--sandbox') && text.includes('--output-last-message') && text.includes('--output-schema'),
  };
}

export function extractUserMessage(prompt) {
  const marker = '\n\nUser message:\n\n';
  const index = String(prompt ?? '').lastIndexOf(marker);
  if (index < 0) return boundedText(prompt, MAX_USER_TRANSCRIPT_CHARS);
  return boundedText(String(prompt).slice(index + marker.length), MAX_USER_TRANSCRIPT_CHARS);
}

export function appendCompatibilityTranscript(transcript, role, text) {
  const maximum = role === 'assistant' ? MAX_ASSISTANT_TRANSCRIPT_CHARS : MAX_USER_TRANSCRIPT_CHARS;
  const next = [...(Array.isArray(transcript) ? transcript : []), { role, text: boundedText(text, maximum) }]
    .slice(-MAX_TRANSCRIPT_MESSAGES);
  while (next.reduce((sum, item) => sum + item.text.length, 0) > MAX_TRANSCRIPT_CHARS && next.length > 2) next.shift();
  return next;
}

export function renderCompatibilityChatPrompt(prompt, transcript) {
  const prior = Array.isArray(transcript) && transcript.length > 0
    ? transcript.map((item) => `${item.role === 'assistant' ? 'DIRECTOR' : 'USER'}: ${item.text}`).join('\n\n')
    : 'No prior compatibility transcript.';
  return [
    'MAKEWATCH CODEX EXEC COMPATIBILITY CHAT',
    'The richer Codex App Server transport is unavailable in this installed client, so continue this bounded conversation from the supplied transcript. Do not edit files or run commands. Respond only with the creative Director answer.',
    '',
    'Prior conversation:',
    prior,
    '',
    'Current bounded Director turn:',
    prompt,
  ].join('\n');
}

export class CodexExecRuntime {
  constructor({ executable, runBounded, schemaPath, cwd, timeoutMs = 120_000, maxOutputBytes = 2 * 1024 * 1024 } = {}) {
    if (!executable || typeof runBounded !== 'function' || !schemaPath || !cwd) {
      throw new Error('Codex exec runtime requires executable, runner, schema path and cwd');
    }
    this.executable = executable;
    this.runBounded = runBounded;
    this.schemaPath = schemaPath;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
  }

  async #run(prompt, { structured = false } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'makewatch-codex-'));
    const outputPath = join(directory, 'final.txt');
    const args = [
      'exec',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--output-last-message', outputPath,
    ];
    if (structured) args.push('--output-schema', this.schemaPath);
    args.push('-');

    try {
      const result = await this.runBounded(this.executable, args, {
        input: prompt,
        cwd: this.cwd,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        env: { MAKEWATCH_DIRECTOR_MODE: '1' },
        trackPlanChild: true,
      });
      if (result.code !== 0) {
        const detail = boundedText(result.stderr || result.stdout || `Codex exec exited with code ${result.code}`, 1200);
        throw new Error(detail);
      }
      const finalText = (await readFile(outputPath, 'utf8')).trim();
      if (!finalText) throw new Error('Codex exec completed without a final Director message');
      return finalText;
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async chat(prompt, transcript = []) {
    return this.#run(renderCompatibilityChatPrompt(prompt, transcript));
  }

  async plan(prompt) {
    const text = await this.#run(prompt, { structured: true });
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1 || !Array.isArray(parsed.steps)) {
      throw new Error('Codex exec compatibility result is not an AutopilotPlan v1 object');
    }
    return parsed;
  }
}
