# Safety

- Loopback bind only (`HMLAB_BIND` is the explicit opt-in the container uses); the compose file publishes `127.0.0.1` only (a test pins it).
- Host header must be a loopback name; writes must be same-origin.
- Netguard blocks every outbound connection (fetch, socket, DNS, UDP) with a self-test, and a test asserts zero attempts. The ONLY exception is Real mode (owner-run, off unless `HMLAB_REAL_*` is set in the lab's own `.env`): while Real is on, the host of `HMLAB_REAL_URL` (and the addresses that name resolves to) may be reached, https only, with redirects refused; choosing Mock closes it again, and an unconfigured or Mock-started lab opens nothing. The agent key is write-only: it is never returned, logged or put in a trace (the shared trace redacts it, and every answer is scrubbed of it). The Real call has a timeout, a bounded response and one call in flight.
- `POST /api/evaluate` accepts custom JSON but bounds it: body 8 KB, depth 6, 200 claims, 20 array items, 512-character values, 8 required claims, path shape checked by a fixed regex. Walks are iterative; there is no `eval`, `Function` or `vm`. Claim values are rendered as text only.
- Tokens are MOCK-ISSUED by this app and shown raw for education; there is no real credential, signature or key anywhere. No EC keygen is used.
- Story and posture text is data; hosts end in `.example`; ARNs use the obviously fake account id 000000000000.
- No tenant, credential or customer identifier ships. `customer.config.json` only sets four display strings and is git-ignored.
