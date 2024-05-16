import { Arg, Instruction, argEq } from "./asm";

type PatternString = [string, (Arg | null)[]];
export class PatternWatcher {
  private pattern: PatternString[];
  private matched: number;

  private storage: Instruction[] = [];

  private rejected: Instruction[] | null = null;
  private fulfilled: Instruction[] | null = null;

  private constructor(pattern: PatternString[]) {
    this.pattern = pattern;
    this.matched = 0;
  }

  static create(pattern: PatternString[]) {
    return new PatternWatcher(pattern);
  }

  restore() {
    this.matched = 0;
    this.storage = [];
    this.rejected = null;
    this.fulfilled = null;
  }

  isFinished() {
    return this.fulfilled !== null || this.rejected !== null;
  }

  private match(x: Instruction, y: PatternString): boolean {
    const [name, args] = y;
    if (x.name !== name) {
      return false;
    }
    if (x.args.length !== args.length) {
      return false;
    }

    for (let i = 0; i < x.args.length; ++i) {
      const vp = args[i];
      if (vp === null) {
        continue;
      }
      if (!argEq(vp, x.args[i])) {
        return false;
      }
    }

    return true;
  }

  submit(inst: Instruction): boolean {
    this.rejected = null;
    this.fulfilled = null;

    const current = this.pattern[this.matched];
    this.storage.push(inst);

    if (this.match(inst, current)) {
      ++this.matched;
    } else {
      this.rejected = this.storage;
      this.storage = [];
      this.matched = 0;
    }

    if (this.matched === this.pattern.length) {
      this.matched = 0;
      this.fulfilled = this.storage;
      this.storage = [];
      return true;
    }

    return false;
  }

  restoreRejected() {
    return this.rejected;
  }

  getFulfilled() {
    return this.fulfilled;
  }
}
