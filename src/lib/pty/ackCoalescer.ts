// Coalesces parsed-byte ACKs into one IPC call per animation frame instead
// of one per xterm write batch — backpressure totals are unchanged, only
// invoke frequency drops.

import { onNextFrame } from "../layout/frameScheduler";

export class AckCoalescer {
  private pendingBytes = 0;
  private scheduled = false;

  constructor(
    private readonly flush: (bytes: number) => void,
    private readonly schedule: (cb: () => void) => void = onNextFrame,
  ) {}

  add(bytes: number): void {
    this.pendingBytes += bytes;
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      const n = this.pendingBytes;
      if (n > 0) {
        this.pendingBytes = 0;
        this.flush(n);
      }
    });
  }

  // Unmount path: account for every byte immediately.
  dispose(): void {
    const n = this.pendingBytes;
    this.pendingBytes = 0;
    if (n > 0) this.flush(n);
  }
}
