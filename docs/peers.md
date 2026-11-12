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
