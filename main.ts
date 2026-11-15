// main.ts — the entry's lifecycle, per the trial contract.
//
// Bind an ephemeral port on the loopback, tell the environment where it is
// (POST $MAKEFUN_ENV_URL/register {"port": N}), serve until the environment
// answers GET $MAKEFUN_ENV_URL/done with {"done": true}, then exit 0.
// Run without an environment URL (a developer run), it just serves.

import { createForge } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const { server } = createForge(token);

async function register(port: number): Promise<void> {
  try {
    await fetch(`${envUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
  } catch {
    // The poll below is the contract that matters; a lost register is
    // retried by the environment's own boot gate on its side.
  }
}

async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const answer = await fetch(`${envUrl}/done`);
      const body = (await answer.json()) as { done?: unknown };
      if (body.done === true) return;
    } catch {
      // Not up yet, or a transient failure: keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (envUrl === '') {
    console.log(`anvil-forge listening on 127.0.0.1:${port}`);
    return;
  }
  void (async () => {
    await register(port);
    await waitForDone();
    server.close(() => process.exit(0));
    // If a stray connection holds the server open, still exit promptly.
    setTimeout(() => process.exit(0), 2000).unref();
  })();
});
