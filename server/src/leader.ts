// Makes sure only one server process runs the game and the payouts.
//
// During a zero-downtime update two containers run side by side for a few
// seconds, sharing the data volume. The new one waits here as a standby until
// the old one lets go of the lock file (or stops refreshing it).

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Leader {
  private readonly id = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private held = false;

  constructor(
    private readonly file: string,
    /** A lock not refreshed for this long belongs to a dead process. */
    private readonly staleMs = 8000,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  private read(): { id: string; at: number } | null {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as { id: string; at: number };
    } catch {
      return null;
    }
  }

  private write() {
    const tmp = `${this.file}.${this.id}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ id: this.id, at: Date.now() }));
    fs.renameSync(tmp, this.file);
  }

  private tryTake(): boolean {
    const cur = this.read();
    if (cur && cur.id !== this.id && Date.now() - cur.at < this.staleMs) return false;
    this.write();
    return this.read()?.id === this.id;
  }

  /** Resolves once this process owns the lock. `cancelled` lets a stopping process give up. */
  async acquire(onWait: () => void, cancelled: () => boolean): Promise<boolean> {
    let told = false;
    while (!this.tryTake()) {
      if (cancelled()) return false;
      if (!told) {
        told = true;
        onWait();
      }
      await sleep(250);
    }
    this.held = true;
    return true;
  }

  /** Keeps the lock fresh. Calls `onLost` if another process somehow took it, so this one can stop at once. */
  keep(onLost: () => void) {
    this.timer = setInterval(() => {
      const cur = this.read();
      if (cur && cur.id !== this.id) {
        this.held = false;
        if (this.timer) clearInterval(this.timer);
        onLost();
        return;
      }
      try {
        this.write();
      } catch {
        /* disk hiccup: try again next second */
      }
    }, 1000);
  }

  /** Hands over. The process must do nothing with the database after this. */
  release() {
    if (this.timer) clearInterval(this.timer);
    if (!this.held) return;
    this.held = false;
    try {
      if (this.read()?.id === this.id) fs.unlinkSync(this.file);
    } catch {
      /* already gone */
    }
  }
}
