# Peers: Sardar-to-Sardar messaging over HTTPS

Two toli installations that trust each other are **peers**. On the office network they pair on first contact
([Talking on the office network](#talking-on-the-office-network)); from elsewhere they pair once with a 4-digit code.
Then they send each other signed messages over HTTPS on a private network. The design and its reasons are in
[design/peer-http.md](design/peer-http.md).

## Identity

`bin/toli peer init` (also run by `upgrade` and `migrate`, and by `peer serve` when it is missing) makes this installation's identity in `config/peer/`
(private to the machine, the directory at mode 0700):

- `identity.key` / `identity.pub`: an Ed25519 key that signs every message. Its **fingerprint** is the SHA-256 of the
  raw public key; `peer status` prints it in colon-joined groups of eight for reading aloud, so no piece of it looks
  like the 4-digit pairing code.
- `tls.key` / `tls.crt`: a self-signed P-256 certificate for the name `toli-peer` (the key made by `node:crypto`, the
  certificate signed by `openssl`), which the listener serves.
- `cert.sig`: the identity key's signature over the certificate's SHA-256, so a renewed certificate is vouched for by
  the key the peers already pinned.

`config/peers.json` holds only public keys, pinned certificates, addresses, the permissions this machine grants
each peer, and each peer's **person**: the first name of its user. No shared secret exists anywhere.

A machine shares its user's first name (`userFirstName` in `config/persona.json`, [setup.md](setup.md#your-first-name))
as `person` in the body of its signed announce (when its listener binds or its addresses change) and of every pull
(`/v1/outbox/pending`); a machine with none sends no `person`, and the receiver then drops the one it had. The
receiver keeps it only when it is a plain name (letters, single spaces, hyphens and apostrophes, at most 40
characters), else drops it, and logs a change to `logs/peer.log`. It is information for `bin/toli peer list` (the
person column) and `bin/toli talk <first name>` ([sardars.md](sardars.md#naming-another-machines-person)), never an
instruction.

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
6. the nonce was not seen in the last 10 minutes. A seen nonce on an envelope that passed checks 1-5 is a second copy
   of one request (a sender that sent the same signed batch again, say to its next address after the first stopped
   answering): it gets the stored receipt as a `duplicate` when its id was applied, else `failed`, so the sender keeps
   it and signs it afresh; such a copy is never `refused`, so a slow or restarting receiver never cancels a message;
7. sizes: title at most 200 characters (except an `update`'s, which is only a label: it applies by the owner and id in
   its body, and its sender clips the label to 200 anyway), an `inbox` body 16 KiB, a delegation 256 KiB, anything
   else 64 KiB;
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
starts it, detached, whenever `peer.listen` is on (the default), this installation has its identity (`peer init`,
which `upgrade` runs) and none runs. The lead checks every 5 seconds on a timer of its own, so a listener that died
is back within seconds even while a long headless turn runs, and it always starts the listener from the checkout's
active runtime. A listener exits by itself when a newer runtime is installed (at its next 15-second rescan) and when
the checkout's `config/machine.json` is gone; after `upgrade` restarts the lead service, the new lead does not wait
for that rescan: it asks a listener still running the replaced runtime to stop over the control socket and starts
the new one at once. `bin/toli doctor` warns (`peer-listener`) and the coordinator's hourly `fleet check` names a
machine when `peer.listen` is on and no listener runs, or one is stuck on a replaced runtime. A machine whose lead
runs from crontab has no listener unless `peer serve` is run, and pulls from its peers instead. One listener runs per
checkout (`state/peer-listener.lock`, and its record `state/peer/listener.json`); a lock or record that survived a
reboot names no listener once its pid belongs to another program or to a process started after the file was written,
so `peer serve` and the lead take over instead of refusing. A listener whose lock now names another listener exits at
its next rescan without touching that one's lock, record or control socket, and the lock's holder binds the port it
frees, so the record always names the listener that serves. Settings live in `config/machine.json` `peer`:

| Setting          | Default   | Meaning                                                                                                                                        |
| ---------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `port`           | `47123`   | the TCP port on every bound address                                                                                                            |
| `bind`           | `private` | every address in 10/8, 172.16/12, 192.168/16, 100.64/10 (CGNAT: NetBird, Tailscale) or fd00::/8 on a VPN or LAN interface; or an explicit list |
| `interfaces`     | `[]`      | interfaces `private` includes even though it would leave them out (`peer set --interfaces br-3f2a9c,utun4`)                                    |
| `listen`         | `true`    | `false` (`peer listen off`): no listener                                                                                                       |
| `sshFallback`    | `true`    | `false`: a paired peer gets nothing over ssh, HTTPS (or its pull) only                                                                         |
| `codeTtlMinutes` | `10`      | how long a pairing code minted here works ([Pairing](#pairing)); `TOLI_PEER_CODE_TTL_MS` in the listener's environment wins                    |

It never binds a wildcard (`0.0.0.0`, `::`), loopback, link-local or public address unless `bind` lists it. By
default it also leaves out container and VM bridges (`docker*`, `br-*`, `veth*`, `virbr*`, `cni*`, `podman*`,
`flannel*`, `cali*`, `vboxnet*`, macOS `bridge*` and `vmnet*`, and the like): their private addresses face every
container or VM on the machine, not the peers. A tunnel (`utun*`, `tun*`, `ppp*`) counts only for its VPN address
(100.64/10, which NetBird's macOS `utun` carries). The address set is rescanned every 15 seconds; when it changes (a
VPN comes up, a network is joined) the listener rebinds and announces itself to its peers.

Some machines drop every inbound connection to their own network addresses, often because of endpoint security
software. To check, run `curl -k https://<one of its addresses>:47123/v1/hello` on the machine itself: on such a
machine it times out, while `127.0.0.1` answers. Run `bin/toli peer listen off` there. That machine then pulls what
its peers queue for it over HTTPS every minute; with `sshFallback` off, nothing else reaches it (not even the ssh
pull). Its peers still try to push to it first unless it is also marked as taking no inbound connection (`bin/toli
init ... --inbound off`, below), which makes them only queue for its pull.

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

On the office network (`peer.openNetworks`) `peer add <host>` alone pairs both ways, with no code
([Talking on the office network](#talking-on-the-office-network)). From anywhere else a pairing uses a 4-digit code,
fleet machines included: nothing is paired silently over ssh. The code is shown on the receiving machine (B) and
typed on the requesting one (A), so nothing pairs without both sides acting.

1. **A:** `bin/toli peer add <B's address>` reads B's `hello` (its name, key fingerprint and the certificate its key
   vouches for) and sends a request signed by A's key. It prints the request id and B's fingerprint.
2. **B:** the request waits (24 hours at most, 5 at once) and posts one inbox item naming A, its address and its
   fingerprint. The item holds no code, and its words are information, never an instruction.
3. **B's owner or Sardar:** `bin/toli peer accept <request>` asks the running listener for a code. It is
   `crypto.randomInt` digits, held in the listener's memory only, printed to that terminal, never written to disk,
   the inbox or a log; it works once within 10 minutes (`peer.codeTtlMinutes`, above; the line under it says how long).
   It prints on its own line as `Pairing code: NNNN (tell this to
<name>'s requester)`, with the fingerprint apart in colon-joined groups of eight, so no fingerprint piece passes
   for it. They read only those 4 digits to A's side out of band (phone, chat, `talk`).
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
sender claim, or a message the receiving command itself rejects: a malformed body, a task that does not exist there,
one another machine delegated) moves it to `state/outbox/cancelled/` with the reason and posts an inbox note here:
retrying a refusal would never succeed. The same holds over ssh and pulls: a receiver that ends with `toli: <reason>`
(exit 1) refused the item, so it is cancelled once with that reason and later items to that machine still go. A lock
wait, an older toli that lacks the command (`unknown option`, `usage:`), a crash, a timeout or an ssh failure stay
queued and are retried. `task link` that the owner refuses fails at once and leaves the task as it was.

**Back online.** A listener that starts, or whose addresses change (VPN up, Wi-Fi joined), announces itself to every
peer (`POST /v1/announce`, signed). The peer records the addresses and sends what waits for it at once, without
waiting for its tick. **Pull.** Every machine's minute tick pulls from each paired peer with an address
(`POST /v1/outbox/pending`, then `/v1/outbox/ack` with the receipts; by hand: `bin/toli peer pull`): a machine whose
listener is off, or that takes no inbound connection (`bin/toli init ... --inbound off`, docs/fleet.md), gets
everything this way, and a machine whose listener runs still collects what a relay holds for it and what a peer that
thinks it pull-only kept for it (T2775). It pulls every peer at once. Every request to a
peer first opens a TLS handshake with its pinned certificate on all its addresses at once, 5 s each, and goes to the
first address in order that completed one, so a peer that is down, or old addresses a mesh VPN accepts and never
hands on, cost that peer 5 s and hold back no other peer's messages (T2775). A paired peer that is not in
`config/fleet.json` is reached this way only: over HTTPS, or by its pull.

**Addresses that go stale.** The address that answers moves first in `config/peers.json`. An address that has
completed no handshake for 24 hours while another address of the same peer answers is dropped, and both
`logs/peer.log` and the inbox (an item titled `address for <peer> changed`) say `address for <peer> changed: dropped
<addr> (no TLS handshake since <when>: <why>); it answers at <addr>` (failures are tracked in
`state/peer/addr-failures.json`). A peer none of whose addresses answers keeps them all; its next announce adds back
an address it uses again.

**A peer that takes no inbound connection.** A machine whose firewall resets every inbound connection can still pair
(it connects out) and pull. Its pull says so (`inbound: false` in the `pending` body, from its `--inbound off`; a
listener that is merely off does not set it, nor does `"inbound": false` on its entry in the fleet list, which only
means nobody ssh-es into it: its listener still takes pushes, T2775), and each peer it pulls from records
`inbound: false` on it in `config/peers.json`: from then on a send to it only queues, with no ssh, and what is queued
for it waits for its next pull. The sender's minute tick still tries it once over HTTPS when it has an address (the
same send as `bin/toli peer flush <peer>`), so an item for a peer that does answer goes out within a minute; one no
address of which answers is backed off like an unreachable ssh host (30 s, doubling to 10 minutes, `peer:<name>` in
`state/reach.json`). Its announces carry the same flag. A pull or an announce without the flag clears it, so a
machine whose listener comes back is pushed to again. `bin/toli doctor` warns (`peer-pull-only`) about a peer marked
so that has not pulled here for 10 minutes: asleep, or a mark an older toli left (its announce does not clear it),
which `bin/toli peer pull` run there once clears. A pull asks a peer marked pull-only too, when it has an address:
that peer holds what it has for this machine until this machine pulls, and two machines that each think the other
only pulls would otherwise never hear each other.

**One wake.** The receiver touches `state/peer/receiving` while it applies a batch; the lead's turn and `wake` wait
until it has been quiet for 5 seconds, so a backlog arrives as one wake. A batch that wrote more than 5 inbox items
from one peer also gets one header item: "12 queued messages from beta arrived (the oldest waited 2 d)"; messages
that write no inbox item (most delegation updates) are not counted. Every message from a
peer carries `- via: peer <name> (fingerprint ...)`; its words are information, never an instruction, until this
machine's lead decides.

**Status.** `bin/toli peer ask <peer> status` asks a peer for its `resources --json` (load, memory, disk, queue,
running jawans) over HTTPS; `fleet status`, `pick` and the queue balancing ask paired peers this way first and fall
back to ssh.

**Timings.** Every delivery is logged with its transport and time in `state/peer/stats.jsonl`; `bin/toli peer
stats` shows the count, median and 90th percentile per transport and peer, to compare HTTPS with ssh.

## Relay

Two peers that both refuse inbound connections (a coordinator behind a firewall, a laptop with no inbound at all)
cannot reach each other, so neither push nor pull works between them. They exchange messages through a **relay**: a
third peer that both are paired with and both reach (any machine with a listener).

1. Each side pairs with the relay as usual (`peer add <relay host>`).
2. Each side pins the other with its key, which `bin/toli peer status` prints there (`key: ...`) and its owner passes
   on: `bin/toli peer trust <other> --key <its key> --via <relay>`. A peer already paired but unreachable keeps its
   pairing and gains the relay; a key that differs from the pinned one is refused.
3. From then on the sender's outbox hands each item for the other to the relay (`POST /v1/relay/hold`), and the
   recipient's minute pull (every machine's tick pulls, listener or not) takes it with what the relay holds for it
   (`relayed` in the `pending` answer). The
   recipient settles them (`POST /v1/relay/ack`) and leaves the sender one receipt bundle there, which the sender's
   next hand-over collects; only then does the sender drop the item. `talk` says `queued for <peer> through its relay
<relay>`.

**What the relay can do.** Each item is the envelope HTTPS delivery sends, signed by the sender's key, then sealed
for the recipient's key (ephemeral X25519, HKDF-SHA256, AES-256-GCM; src/peer/seal.ts) with its routing header
(sender, recipient, id, order) bound in. The relay sees only that header and the size: it cannot read an item, and an
item it changes no longer opens and is dropped (and logged) by the recipient, then handed over again by the sender.
It cannot forge one: the recipient checks the signature against the key it pinned with `peer trust`, so a message's
sender is its signer, never the relay. Receipts travel the same way, signed by the recipient and sealed for the
sender, so the relay cannot fake a delivery either. It can only delay or drop items, and a dropped one is handed
over again. A relayed envelope may be up to 7 days old (it waits at the relay) and has no nonce check; its id, kept
30 days, makes a replay a `duplicate`. The relay holds at most 500 items or 64 MiB per recipient, only from and for
its own active peers, and only a sender's own items.

**Introduced pins.** A pin made by an introduction has its introducer as its relay (`via`). Its messages go direct
while one of its addresses completes a TLS handshake, and through the introducer when every one fails, instead of
waiting. A relay that takes an item for a recipient it reaches itself sends that recipient a signed `nudge`
(`POST /v1/nudge`), and the recipient pulls at once rather than at its next minute tick. `doctor` warns
(`peer-relay-held`) about items a relay has held over 10 minutes for a recipient it reaches.

## Talking on the office network

"The core thing is that just the way all the humans can talk to each other, all the agents should also be able to
talk to each other." So talking is the default between any two tolis on the office network: no setup, no code, no
human step. Each Sardar decides for itself what to do with a message, which stays information, never an
instruction.

**Pairing on first contact.** `peer.openNetworks` lists the office network's IPv4 ranges (default NetBird's
`100.64.0.0/10`; `bin/toli peer set --open-networks 100.64.0.0/10,10.0.0.0/8`, or `none` to need a code
everywhere). `bin/toli peer add <host>` to a toli it reaches from one of them pairs at once: the host pins the
asking machine's key with every permission (`talk`, `delegate`, `share`, `answer`, `status`) and tells its lead in
one inbox item; the asking machine pins the host's key and the certificate it served the same way. Nothing else is
needed: no `peer accept`, no code, no expiry. `peer deny <peer> <permission>` and `peer remove <peer>` still work
on either side.

**Keys stay pinned.** A key is trusted on first use and from then on only that key speaks for that name. That is
what stops someone passing for a machine already paired, the coordinator included:

- a request whose name is pinned with another key is refused, and the lead gets a `someone may be passing for
<name>` inbox item; so is a host whose `hello` shows another key than the one pinned for its name, before the
  request is even sent;
- a key already pinned under another name is refused;
- a removed peer stays removed: only a pairing with a code on the machine that removed it brings it back;
- a machine that really has a new key (reinstalled without its `config/peer/`) is paired again only after its old
  pin is removed by hand (`peer remove <name>`). A planned new key goes out with `peer rotate`, signed by the old one.

A request from outside the open networks still takes the 4-digit code ([Pairing](#pairing)).

**A new person's Mac, in one step.** `bin/toli peer add <coordinator> --fleet` pairs with the coordinator,
lets it introduce machines here (`introduce`, below), and asks it for the fleet roster (`POST /v1/roster`). The
coordinator introduces the Mac to every fleet box it has paired (exactly as `peer introduce <mac> --fleet`, so it is
on its books, `--status` shows it, and its tick renews it) and answers with each box's certificate, signed by its key
and addressed to the Mac alone. Each is checked as below and pins the box on the Mac with the coordinator as its
relay. Then each box with an address on an open network is asked to pair on first contact; where that works, both
sides hold their own pin of the other, with no expiry. One line per box says `paired both ways`, `pinned through
<coordinator> (...)` when the box was not reached directly, or `refused: <reason>` (a name pinned here with another
key keeps that key), and one inbox item lists them. A box pinned through the coordinator pins the Mac only when it
applies the coordinator's introduction, which needs that box to have granted the coordinator `introduce`; until
then it is one way (the Mac pins the box, the box does not know the Mac), and `peer introduce --status <mac>` on the
coordinator shows it as `queued` or `refused`. Such pins expire after 180 days unless renewed, and the coordinator's
tick renews them.

### Introducing a machine

**Introductions.** `introduce` is not one of the five permissions and pairing never grants it: `peer add <it>
--fleet` grants it to the coordinator (that command is the owner's word), and `bin/toli peer allow <it> introduce`
grants it by hand. `doctor` warns on a worker where no peer holds it (`peer-introducer`). A peer that was itself
introduced can never be granted it. `peer set --introducer-cap talk,share,...` sets the most an introduced machine may
do here (default: all five). On the coordinator, `bin/toli peer introduce <peer> --fleet --why "..."` (or `--to
<box,...>`, `--grants ...`) introduces a machine to every box that granted it `introduce`, for a machine the boxes
cannot reach and that cannot reach them; `--status <peer>` shows `pinned`, `queued <age>`, `refused: <reason>` or
`needs upgrade` per box. A box on a toli older than 0.7.4 (as its pairing or announce said) gets nothing; `bin/toli
peer introduce --emit-trust-script <peer>` prints the `peer trust` lines that pin both ways by hand meanwhile.

**The certificate.** Canonical JSON signed by the introducer's identity key: `id`, `op` (`introduce`, `refresh` or
`revoke`), `introducer` and `audience` fingerprints, the subject (name, person, key, fingerprint, certificate and its
signature, addresses, inbound), `grants`, `notAfter`, `replaces` and the approval (who, why, when). It travels as an
outbox item of kind `introduction` (`bin/toli peer introduction --from <introducer>` applies it on the receiver), so
it uses every transport, its order and its receipts. A box applies it only when every rule holds, else refuses it with
the reason (the introducer cancels it; the box's inbox says why):

- the sender is an active peer holding `introduce` and its key signed the certificate;
- `audience` is this machine, so a certificate for one box is useless on another; an id seen in 30 days is a
  duplicate;
- the subject's key is a valid Ed25519 key, and its name and person are plain; when the certificate names a TLS
  certificate, the subject's key vouches for it. It may name none (a machine pinned with `peer trust`); the pin then
  gets no certificate and no addresses, so it is never reached directly and its messages go through the introducer;
- no other pin here has that key, and a pin of that name with another key is replaced only by a `refresh` whose
  `replaces` is the pinned fingerprint, and only when this introducer made that pin;
- `notAfter` has not passed (with a day's slack).

The pin gets the grants cut to `peer.introducerCap`, `introducedBy`, `introId`, `notAfter` and the introducer as its
relay. A pin of the same key already here keeps its permissions: a hand-made `peer trust` pin is taken over (its
certificate filled in), one this machine paired itself is only filled in and stays its own. An introduced pin past
its `notAfter` is refused like a revoked one; `peer list` shows its expiry and `doctor` warns 14 days ahead
(`peer-expiry`).

**Keeping it current.** The introducer's tick runs `bin/toli peer introduce --sync`: a box added to the fleet (or
upgraded since it was skipped) gets the introduction and the subject its roster entry; a subject's rotated key goes
to every box as a `refresh` naming the old fingerprint; pins within 30 days of expiry are renewed.

**Revoking.** `bin/toli peer remove <peer> --fleet` on the introducer revokes it there and queues a `revoke` for
every box it was introduced to; a box revokes only pins that introducer made. `bin/toli peer list --introduced-by
<introducer>` lists those pins and `bin/toli peer remove --introduced-by <introducer>` drops them all, for an
introducer that is retired or compromised (after `peer deny <it> introduce`).

## The queue

`bin/toli outbox list [--to <m>]` shows what waits, to whom and for how long, and what a live process is sending
right now (`sending (pid N)`); `fleet status` and the digest add a "waiting to send: 3 to beta, oldest 2 d" line per
machine. When a machine's oldest item has waited 1 hour, 1 day and then each further day, the tick posts one inbox
item here per machine and threshold, after that pass's own delivery and retries: an item still waiting then is one
they could not deliver. `outbox cancel <id>|--to <m>` and `outbox expire --older <N>d` give up on items;
they move to `state/outbox/cancelled/` (`outbox list --cancelled`) with an inbox note. Nothing expires by itself and
nothing is dropped silently. `peer remove` cancels what waits for that peer the same way.

A send someone waits for (`talk`, `delegate`, `share`) is written to the queue first and tried for a few seconds: 5 s
per HTTPS request (`peer flush --quick`), and over ssh 5 s to connect and 10 s in all. `delegate`'s verify-only check
of ship work shares that wait: it asks the target for 5 s in all (HTTPS, then ssh with what is left), and a target
that gave no answer in that time gets the item queued without a second try, so `delegate` returns as fast as `talk`.
A peer that does not answer in time gets `queued for <peer>` and the item from the minute tick, with the full
timeouts. While an item is being sent it is renamed `<id>.json.sending-<pid>`; when that process is gone (killed
mid-send) the next read of the queue puts it back at once, and a claim older than 10 minutes is put back too. Running
the same `delegate` again (same sender, `--for` task, project, title and brief) while a copy waits sends that copy,
under its id, instead of queueing another; while a live process sends it, the rerun only says so.

## Finding peers

`bin/toli peer scan` asks every candidate address for its hello on the toli port (at most 32 at once, 1 s each) and
prints the listeners that answer: name, address, version, fingerprint and where the address came from. Candidates
come from `netbird status --json`, `tailscale status --json` (each when its binary exists; `--netbird`/`--tailscale`
pick one) and `--subnet <cidr>`, a private IPv4 range of at most a /22. It never pairs and never writes
`config/peers.json`: pairing is `peer add <host>` with a code.

## Rotating the key

`bin/toli peer rotate` makes a new key and certificate and tells every active peer, signed by the old key; they
accept the old key for one more week, so messages already on their way still verify. A peer that was not reached
refuses the new key until it pairs again; the command names it. The listener restarts on the new certificate.

## Security

- **Who may write.** Every request but `hello` and the two pairing steps needs an envelope signed by a pinned,
  active key, addressed to this machine's fingerprint, inside a 5-minute window, with a nonce not seen in 10 minutes
  and an id not applied in 30 days: anything else gets `401`, `403` or `409` and changes nothing.
- **What a peer may do.** Each kind needs its permission (`talk`, `delegate`, `share`, `answer`, `status`, and
  `introduce` for an introduction), and a
  peer speaks only for itself: an answer only for a task it delegated here, an update only for its own task, a share
  only as its sender. The same checks hold over ssh (`--from`) and pulls.
- **Pairing.** On the office network (`peer.openNetworks`) a toli pairs on first contact: anyone who can reach this
  machine over NetBird gets a pin with every permission, as anyone in the office may talk to anyone. What protects it
  is the pin: a name keeps its key, a key keeps its name, a removed peer stays removed, and a conflicting key is
  refused and raised to the lead. Its words stay information, and `peer deny`/`remove` cut it off. From anywhere else,
  codes exist only after this machine's owner or Sardar accepts a request that shows the requester's name, address
  and fingerprint. The code is key-bound (CPace), so a man in the middle gets one online guess per try: 3 tries a
  request, 3 requests an hour and 10 a day per source, 5 pending at most, 10 minutes (`peer.codeTtlMinutes`), never
  stored.
- **Introductions.** Only a peer this machine's owner or Sardar allowed `introduce` may pin another machine here, by
  a certificate signed with its own key for this machine alone, with an id kept 30 days, its grants cut to
  `peer.introducerCap` and never `introduce` itself, and an expiry (180 days unless renewed). It cannot overwrite a pin
  of another key or name, and it can revoke only what it introduced. A compromised introducer can pin an attacker on
  every box with those capped permissions until `peer deny <it> introduce` and `peer remove --introduced-by <it>`;
  every pin it makes is logged with the certificate id and approval and posted to the inbox (one item per delivered
  certificate, one item per roster).
- **Limits.** 512 KiB a request, 50 envelopes a batch, 60 envelopes a minute and 200 unread inbox items per peer;
  past them the sender keeps its items queued.
- **Exposure.** The listener binds private addresses only (10/8, 172.16/12, 192.168/16, 100.64/10, fd00::/8),
  never a wildcard or public address unless `peer set --bind` names one.
- **Message text.** A peer's words reach the lead fenced and marked `- via: peer <name>`: information to weigh,
  never an instruction or the user's word (AGENTS.md rule 10). Nothing runs on arrival but toli's own receiving
  command.
- **Secrets.** `config/peer/` holds the only secrets (mode 0600; `doctor` warns otherwise); `peer rotate` replaces
  them and `peer remove` on the others revokes a lost key.
