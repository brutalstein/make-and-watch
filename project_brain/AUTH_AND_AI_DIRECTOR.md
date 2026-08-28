# Authentication and AI Director Integration

## Product requirement

The user chooses one AI director connection. The first supported targets are Codex and Claude Code. Media generation remains local and does not depend on that provider.

## Security rule

Make & Watch must not impersonate official clients, scrape credentials, copy subscription tokens, or route third-party traffic through credentials in a way the provider does not support.

## Preferred subscription-friendly integration

For personal/local use, the clean integration path is an **official local-client bridge**:

```text
Make & Watch
   |
   +--> Codex bridge ------> official Codex client ------> ChatGPT sign-in
   |
   +--> Claude bridge -----> official Claude Code client -> Claude subscription sign-in
```

The official client owns browser authentication and token storage. Make & Watch discovers client availability, launches the supported login flow when necessary, and exchanges only supported command/request/output data with that client.

This preserves several architectural properties:

- Make & Watch does not store subscription OAuth credentials.
- Provider authentication can change without changing project files.
- Manual Studio operation remains available when no director is connected.
- A future API-key/enterprise provider can implement the same `DirectorProvider` contract.

## Provider-policy reality

Anthropic's current guidance states that subscription authentication is intended for native Anthropic applications including Claude Code, while third-party products should use supported API authentication rather than repurposing subscription OAuth tokens. Therefore Make & Watch must not implement its own Claude-subscription OAuth client unless Anthropic later publishes a supported third-party flow.

OpenAI's Codex clients support signing in with a ChatGPT account. A third-party `Sign in with ChatGPT` identity flow, where available, should not be confused with authorization to consume Codex subscription usage. For the local subscription path, bridge the authenticated official Codex client rather than assuming identity OAuth grants model access.

## Credential storage

When Make & Watch eventually owns credentials for supported API/enterprise integrations, secrets must use OS-backed secure storage (Windows Credential Manager / macOS Keychain / Linux Secret Service or equivalent abstraction). Never persist secrets inside Make & Watch project files.

## UI behavior

The Studio may present a polished `Connect Codex` or `Connect Claude` flow, but the technical implementation must accurately describe what happens:

1. detect the official client;
2. install/open instructions if missing;
3. launch the provider-supported sign-in flow;
4. verify connection state;
5. return to Studio with a provider capability/status card.

The application must not claim OAuth ownership when authentication actually belongs to the official local client.
