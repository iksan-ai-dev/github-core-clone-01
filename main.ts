// main.ts — the entry <-> env lifecycle.
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 in a
//      trial). Without it there is nothing to talk to, so exit 1 at once.
//   2. Build one ForgeStore, create the server, listen on an ephemeral
//      port. Never bind 8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": <the bound port>}. The env
//      records the address the request came from plus that port as the
//      entry's base URL and dials it from then on. The first register
//      wins: a 409 means another entry already registered, and this
//      process keeps waiting like any other. 400/405 are contract errors
//      and end the program; anything else is retried, since the env may
//      still be starting.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The
//      env answers at once ({"done": false} while the suite runs), so
//      this is a poll with a short backoff, never a held request. A
//      failed or slow poll is retried the same way; the process never
//      exits before the env says done.
//   5. Close the server and exit 0. The harness then stops the env,
//      whose export is what the scorer reads.
//
// Auth for the suite's calls is the token in MAKEFUN_SHOP_TOKEN, read
// per request by the surfaces themselves; the viewer login is the
// store's default ("adaiversen", the scenario viewer). No model is
// called, no clock is read, no randomness is used anywhere in the entry.

import { ForgeStore } from "./store.ts";
import { createApp } from "./app.ts";

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (ENV_URL === "") {
  process.stderr.write("[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n");
  process.exit(1);
}

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the env accepts it (200, or 409: first register already won). */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("register answered HTTP ")) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** One store, one server on an ephemeral port; register it, then wait for the env. */
async function main(): Promise<void> {
  const store = new ForgeStore();
  const server = createApp(store);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the server did not bind an ephemeral TCP port");
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write("[entry] registered; waiting for the env to say done\n");

  await waitForDone();
  server.close();
  process.stdout.write("[entry] done\n");
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
