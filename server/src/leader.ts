// Makes sure only one server process runs the game and the payouts.
//
// During a zero-downtime update two containers run side by side for a few
// seconds, sharing the data volume. The new one waits here as a standby until
// the old one lets go of the lock file (or stops refreshing it).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Leader {
  private readonly id = randomUUID();
  /** Short name for this process in the journal (the container id under Docker). */
  private readonly who = os.hostname().slice(0, 12);
  private timer: NodeJS.Timeout | null = null;
  private held = false;

  constructor(
    private readonly file: string,
    /** A lock not refreshed for this long belongs to a dead process. */
    private readonly staleMs = 8000,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  /**
   * Appends one line to a small journal next to the lock. Every container on the
   * volume writes to it, so it shows exactly how each hand-over went.
   */
  note(event: string, extra: Record<string, unknown> = {}) {
    try {
      const file = `${this.file}.journal`;
      fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), who: this.who, event, ...extra })}\n`);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      if (lines.length > 200) fs.writeFileSync(file, `${lines.slice(-100).join('\n')}\n`);
    } catch {
      /* the journal is only a diagnostic */
    }
  }

  journal(last = 20): unknown[] {
    try {
      return fs
        .readFileSync(`${this.file}.journal`, 'utf8')
        .trim()
        .split('\n')
        .slice(-last)
        .map((l) => JSON.parse(l) as unknown);
    } catch {
      return [];
    }
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
    const started = Date.now();
    const first = this.read();
    let told = false;
    while (!this.tryTake()) {
      if (cancelled()) return false;
      if (!told) {
        told = true;
        this.note('standby', { lockAgeMs: first ? started - first.at : null });
        onWait();
      }
      await sleep(250);
    }
    this.held = true;
    // "handed over" = the previous server released the lock; "expired" = it just stopped refreshing it.
    const how = !first ? 'free' : !told ? 'stale at start' : fs.existsSync(`${this.file}.released`) ? 'handed over' : 'expired';
    this.note('active', { waitedMs: Date.now() - started, how });
    fs.rmSync(`${this.file}.released`, { force: true });
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
      fs.writeFileSync(`${this.file}.released`, String(Date.now()));
      if (this.read()?.id === this.id) fs.unlinkSync(this.file);
      this.note('released');
    } catch {
      /* already gone */
    }
  }
}
