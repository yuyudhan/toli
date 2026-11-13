// One doctor section, run off doctor's main thread (src/setup/doctor.ts runBounded): a section that blocks or leaves a
// handle open is terminated at its time limit instead of holding doctor up.
import { runSection } from "./doctor.ts";

declare const self: Worker;

self.onmessage = async (event: MessageEvent<string>) => {
    self.postMessage(await runSection(event.data));
};
