# Peers: Sardar-to-Sardar messaging over HTTPS

Two toli installations that trust each other are **peers**. They pair once with a 4-digit code, then send each other
signed messages over HTTPS on a private network. The design and its reasons are in
[design/peer-http.md](design/peer-http.md).

## Identity

`bin/toli peer init` (also run by `upgrade` and by the listener) makes this installation's identity in `config/peer/`
(private to the machine, the directory at mode 0700):

- `identity.key` / `identity.pub`: an Ed25519 key that signs every message. Its **fingerprint** is the SHA-256 of the
  raw public key; `peer status` prints it in groups of four for reading aloud.
- `tls.key` / `tls.crt`: a self-signed P-256 certificate for the name `toli-peer`, made by `openssl`, which the
  listener serves.
- `cert.sig`: the identity key's signature over the certificate's SHA-256, so a renewed certificate is vouched for by
  the key the peers already pinned.

`config/peers.json` holds only public keys, pinned certificates, addresses and the permissions this machine grants
each peer. No shared secret exists anywhere.

## The envelope

Every message to a peer is one signed **envelope**, whichever way it travels (HTTPS, ssh through `bin/toli peer
apply`, or a pull): its outbox id, `seq`, sender name and key fingerprint, the receiver's fingerprint, kind, title,
body, when it was queued, and a fresh `sentAt` and nonce on every attempt, signed with Ed25519 over the canonical
JSON. The receiver checks, in order:

1. the key belongs to an active (not revoked) peer;
2. the signature verifies;
3. it is addressed to this machine's fingerprint;
4. `from` is that peer's name;
5. `sentAt` is within 5 minutes;
6. the nonce was not seen in the last 10 minutes;
7. sizes: title at most 200 characters, an `inbox` body 16 KiB, a delegation 256 KiB, anything else 64 KiB;
8. the peer has the permission the kind needs (`talk` for inbox items, `delegate`, `share`, `answer`);
9. what the message claims: a delegation, link or share speaks only for its sender; an update comes only from the
   task's owner (and, when it names a task here, only for a delegation recorded on it); an answer goes only to a task
   that peer delegated here;
10. the id was not applied before (30 days): a resend gets the stored receipt, so it is applied exactly once.

Then it runs the same `bin/toli` command a delivery always ran (`inbox add`, `delegation receive|update|link`,
`share receive`, `task answer`), with the verified sender as `--from`. Each envelope gets a **receipt**: `applied`,
`duplicate`, `refused` (with the reason; never retried), `deferred` or `failed` (both kept queued by the sender).
Nothing executes on arrival: every kind ends as an inbox item, a queued task or a share record, and an inbox item from
a peer carries `- via: peer <name> (fingerprint ...)`.

The plain ssh commands hold the sender to its task too: `task answer <id> --from <m>` is refused unless `<m>`
delegated that task here, and `delegation receive|update|link --from <m>` unless the JSON speaks for `<m>`.

## The listener

`bin/toli peer serve` serves HTTPS with this installation's certificate. The lead service (`bin/toli lead run`)
starts it, detached, whenever `peer.listen` is on (the default) and none runs, and it exits by itself when a newer
runtime is installed so the lead restarts it on that; a machine whose lead runs from crontab has no listener unless
`peer serve` is run, and pulls from its peers instead. Settings live in `config/machine.json` `peer`:

| Setting       | Default   | Meaning                                                                                                                    |
| ------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `port`        | `47123`   | the TCP port on every bound address                                                                                        |
| `bind`        | `private` | every local address in 10/8, 172.16/12, 192.168/16, 100.64/10 (CGNAT: NetBird, Tailscale) or fd00::/8; or an explicit list |
| `listen`      | `true`    | `false` (`peer listen off`): no listener                                                                                   |
| `sshFallback` | `true`    | `false`: a paired peer gets nothing over ssh, HTTPS (or its pull) only                                                     |

It never binds a wildcard (`0.0.0.0`, `::`), loopback, link-local or public address unless `bind` lists it. The
address set is rescanned every 15 seconds; when it changes (a VPN comes up, a network is joined) the listener rebinds
and announces itself to its peers.

| Endpoint              | Who                      | What                                                              |
| --------------------- | ------------------------ | ----------------------------------------------------------------- |
| `GET /v1/hello`       | anyone on the network    | name, version, key, fingerprints, `certSig`: nothing else         |
| `POST /v1/pair/...`   | a machine asking to pair | the 4-digit code exchange (below)                                 |
| `POST /v1/messages`   | a paired peer, signed    | an ordered batch of up to 50 envelopes; one receipt each          |
| `POST /v1/announce`   | a paired peer, signed    | "I am back at these addresses": its queue here goes out at once   |
| `POST /v1/status`     | a peer with `status`     | what `resources` and `task list` say here, and the queue to it    |
| `POST /v1/outbox/...` | a paired peer, signed    | a peer without a listener pulls what waits here for it, then acks |

Limits: a request is at most 512 KiB (`413`), an unsigned or unknown request gets `401`, and past 60 envelopes a
minute from one peer the rest are deferred (`429`) and stay queued with their sender. A unix socket in `state/peer/`
(mode 0600) takes local commands only: `peer accept` asks it for a code, `peer listen off` stops it.

## Pairing

Every pairing uses a 4-digit code, fleet machines included: nothing is paired silently over ssh. The code is shown
on the receiving machine (B) and typed on the requesting one (A), so nothing pairs without both sides acting.

1. **A:** `bin/toli peer add <B's address>` reads B's `hello` (its name, key fingerprint and the certificate its key
   vouches for) and sends a request signed by A's key. It prints the request id and B's fingerprint.
2. **B:** the request waits (24 hours at most, 5 at once) and posts one inbox item naming A, its address and its
   fingerprint. The item holds no code, and its words are information, never an instruction.
3. **B's owner or Sardar:** `bin/toli peer accept <request>` asks the running listener for a code. It is
   `crypto.randomInt` digits, held in the listener's memory only, printed to that terminal, never written to disk,
   the inbox or a log; it works once within 2 minutes. They read it to A's side out of band (phone, chat, `talk`).
4. **A:** `bin/toli peer add <B's address> --code NNNN` runs **CPace** (draft-irtf-cfrg-cpace, ristretto255 and
   SHA-512, src/peer/cpace.ts) with the code as the password. The session id binds the request id, both identity
   keys and both certificate fingerprints, so a machine in the middle with its own keys gets a different key. Each
   side then proves it holds the session key (an HMAC over its role and the transcript), B first checking A's.
5. Both tags verify: each side pins the other's key and certificate with every permission (`talk`, `delegate`,
   `share`, `answer`, `status`). A wrong code leaves nothing pinned.

**Limits.** A code allows 3 tries: the third wrong one kills its request, posts an inbox item on B, and holds that
source address for an hour. A source may ask 3 times an hour and 10 a day. An expired code kills its request. Each
run gives a guesser one online try at 1 in 10,000; a recorded exchange gives an offline guesser nothing.

**Who may act.** The owner, at a terminal, or the Sardar in its own turn (`--by sardar`, which needs `--why`). `peer
accept`, `decline`, `allow`, `deny` and `remove` are logged to `logs/peer.log` with who and why; the code never is.
`peer deny <peer> <permission>` revokes one permission and `peer allow` restores it; `peer remove <peer>` revokes
the peer, whose key is then refused (it stays in `config/peers.json` as `revoked`).

## Delivery

The outbox (`state/outbox/`) is the one queue for every transport. When this machine sends to another (`talk`,
`delegate`, a delegated task's report, `share`, `task answer <m>/T<n>`), the item is written to the outbox and:

1. a **paired peer** with an address gets it over HTTPS, at once: every item queued for that peer goes out in order,
   in batches of at most 50 signed envelopes, and each receipt settles its item (`bin/toli peer flush` does this; the
   outbox runs it as a subprocess);
2. a fleet machine that is not paired, or a peer HTTPS cannot reach while `peer.sshFallback` is on (the default), gets
   it over ssh as before;
3. otherwise it waits: the minute tick retries, the peer's announce (below) sends it, or the peer pulls it.

A receipt `applied` or `duplicate` removes the item (a delegation's answer is then recorded here, as over ssh); a
lost receipt only means the item is sent again, and the receiver answers `duplicate` with the receipt it kept, so
each item is **applied exactly once**. `deferred` (a rate limit, or 200 unread messages from that peer) and `failed`
keep the item and every later one queued, so order holds. `refused` (a missing permission, a revoked key, a false
sender claim) moves it to `state/outbox/cancelled/` with the reason and posts an inbox note here: retrying a refusal
would never succeed.

**Back online.** A listener that starts, or whose addresses change (VPN up, Wi-Fi joined), announces itself to every
peer (`POST /v1/announce`, signed). The peer records the addresses and sends what waits for it at once, without
waiting for its tick. **Pull.** A machine whose listener is off pulls from each peer every minute
(`POST /v1/outbox/pending`, then `/v1/outbox/ack` with the receipts; by hand: `bin/toli peer pull`). A paired peer
that is not in `config/fleet.json` is reached this way only: over HTTPS, or by its pull.

**One wake.** The receiver touches `state/peer/receiving` while it applies a batch; the lead's turn and `wake` wait
until it has been quiet for 5 seconds, so a backlog arrives as one wake. A batch of more than 5 messages from one
peer also gets one header item: "12 queued messages from beta arrived (the oldest waited 2 d)". Every message from a
peer carries `- via: peer <name> (fingerprint ...)`; its words are information, never an instruction, until this
machine's lead decides.

**Status.** `bin/toli peer ask <peer> status` asks a peer for its `resources --json` (load, memory, disk, queue,
running jawans) over HTTPS; `fleet status`, `pick` and the queue balancing ask paired peers this way first and fall
back to ssh.

**Timings.** Every delivery is logged with its transport and time in `state/peer/stats.jsonl`; `bin/toli peer
stats` shows the count, median and 90th percentile per transport and peer, to compare HTTPS with ssh.

## The queue

`bin/toli outbox list [--to <m>]` shows what waits, to whom and for how long; `fleet status` and the digest add a
"waiting to send: 3 to beta, oldest 2 d" line per machine. When a machine's oldest item has waited 1 hour, 1 day and
then each further day, the tick posts one inbox item here per machine and threshold. `outbox cancel <id>|--to <m>`
and `outbox expire --older <N>d` give up on items; they move to `state/outbox/cancelled/` (`outbox list
--cancelled`) with an inbox note. Nothing expires by itself and nothing is dropped silently. `peer remove` cancels
what waits for that peer the same way.

## Rotating the key

`bin/toli peer rotate` makes a new key and certificate and tells every active peer, signed by the old key; they
accept the old key for one more week, so messages already on their way still verify. A peer that was not reached
refuses the new key until it pairs again; the command names it. The listener restarts on the new certificate.
