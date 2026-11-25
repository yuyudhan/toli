// `bin/toli peer listen on|off` and `peer set` (docs/peers.md "The listener", "Talking on the office network"): this
// machine's `peer` settings in config/machine.json.
import { Args } from "../core/args.ts";
import { out, ToliError } from "../core/util.ts";
import { bindAddresses, parseCidr } from "./bind.ts";
import { controlRequest } from "./server.ts";
import { introducerCap, isPermission, openNetworks, PERMISSIONS, peerSettings, updatePeerSettings } from "./store.ts";

/** `peer listen on|off`: keep the listener running (the lead service starts it) or stop it and keep it off. */
export async function listenCommand(argv: string[]): Promise<void> {
    const args = new Args(argv);
    args.maxPositional(1);
    const mode = args.pos(0, "on|off");
    if (mode !== "on" && mode !== "off") throw new ToliError("usage: toli peer listen on|off");
    updatePeerSettings((settings) => {
        settings.listen = mode === "on";
    });
    if (mode === "on") {
        out("peer listener on: the lead service starts it within 15 s (or run bin/toli peer serve)");
        return;
    }
    const answered = await controlRequest("/stop", {});
    out(answered === null ? "peer listener off (none was running)" : "peer listener off: stopped");
}

function onOff(value: string, flag: string): boolean {
    if (value !== "on" && value !== "off") throw new ToliError(`${flag} takes on or off`);
    return value === "on";
}

/** `--introducer-cap talk,status`: only the five permissions; `introduce` is never grantable through an introduction. */
function capList(value: string): string[] {
    const cap = value.split(",").map((entry) => entry.trim());
    if (!cap.every(isPermission)) throw new ToliError(`--introducer-cap takes ${PERMISSIONS.join(", ")}`);
    return cap;
}

/** `--open-networks 100.64.0.0/10,10.0.0.0/8` (IPv4 CIDRs), or `none`: pairing then always needs a code. */
function networkList(value: string): string[] {
    if (value === "none") return [];
    const networks = value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
    const bad = networks.find((entry) => parseCidr(entry) === null);
    if (bad !== undefined) throw new ToliError(`--open-networks: ${bad} is not an IPv4 CIDR (such as 100.64.0.0/10)`);
    return networks;
}

/** `peer set`: the listener's port, bind and interfaces, the ssh fallback, the introducer cap, the open networks. */
export function setCommand(argv: string[]): void {
    const args = new Args(argv, {
        values: ["port", "bind", "interfaces", "ssh-fallback", "introducer-cap", "open-networks"],
    });
    args.maxPositional(0);
    const port = args.str("port");
    const bind = args.str("bind");
    const interfaces = args.str("interfaces");
    const fallback = args.str("ssh-fallback");
    const capArg = args.str("introducer-cap");
    const networksArg = args.str("open-networks");
    if ([port, bind, interfaces, fallback, capArg, networksArg].every((value) => value === undefined))
        throw new ToliError(
            "peer set needs --port, --bind, --interfaces, --ssh-fallback, --introducer-cap or --open-networks",
        );
    const cap = capArg === undefined ? undefined : capList(capArg);
    const networks = networksArg === undefined ? undefined : networkList(networksArg);
    const portNumber = port === undefined ? undefined : Number(port);
    if (portNumber !== undefined && (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535))
        throw new ToliError("--port must be 1-65535");
    const bindList = bind === undefined || bind === "private" ? bind : bind.split(",").map((ip) => ip.trim());
    if (Array.isArray(bindList)) bindAddresses(bindList);
    // `--interfaces none` clears the list; names are kept as given (the interfaces may not exist yet).
    const named =
        interfaces === undefined
            ? undefined
            : interfaces === "none"
              ? []
              : interfaces
                    .split(",")
                    .map((name) => name.trim())
                    .filter((name) => name !== "");
    updatePeerSettings((settings) => {
        if (portNumber !== undefined) settings.port = portNumber;
        if (bindList !== undefined) settings.bind = bindList as "private" | string[];
        if (named !== undefined) settings.interfaces = named;
        if (fallback !== undefined) settings.sshFallback = onOff(fallback, "--ssh-fallback");
        if (cap !== undefined) settings.introducerCap = cap;
        if (networks !== undefined) settings.openNetworks = networks;
    });
    const now = peerSettings();
    out(
        `peer settings: port ${now.port}, bind ${Array.isArray(now.bind) ? now.bind.join(",") : now.bind}, interfaces ${now.interfaces.join(",") || "none"}, ssh fallback ${now.sshFallback ? "on" : "off"}, introducer cap ${introducerCap().join(", ") || "nothing"}, open networks ${openNetworks().join(", ") || "none"}`,
    );
}
