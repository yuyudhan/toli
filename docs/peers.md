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
