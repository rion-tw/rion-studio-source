export class BusyIdTracker {
  private readonly activeIds = new Set<string>();

  constructor(private readonly onChange: (ids: ReadonlySet<string>) => void) {}

  begin(id: string): (() => void) | undefined {
    return this.beginMany([id]);
  }

  beginMany(ids: Iterable<string>): (() => void) | undefined {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.some((id) => this.activeIds.has(id))) {
      return undefined;
    }

    uniqueIds.forEach((id) => this.activeIds.add(id));
    this.emitChange();
    let isFinished = false;

    return () => {
      if (isFinished) {
        return;
      }

      isFinished = true;
      uniqueIds.forEach((id) => this.activeIds.delete(id));
      this.emitChange();
    };
  }

  private emitChange(): void {
    this.onChange(new Set(this.activeIds));
  }
}

export class LatestRequestGate {
  private version = 0;

  begin(): number {
    this.version += 1;
    return this.version;
  }

  invalidate(): void {
    this.version += 1;
  }

  isCurrent(request: number): boolean {
    return this.version === request;
  }
}
