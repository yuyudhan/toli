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
