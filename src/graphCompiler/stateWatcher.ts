import { Arg, Instruction, RegisterArg, argEq } from "../common/asm";
import { VALUE_SIZE, Value } from "../common/types";
import { $do, $l, $m, $r, $s, shape } from "../common/utils";

export const MAX_REGS = 4;
export const VALUABLE_REGS = ["ebx", "ecx", "esi", "edi", "edx"];
export class StateWatcher {
  private static stack_bp = 69;

  private statistic: Record<number, number> = {};
  private usings: Record<number, number> = {};

  private registers: Record<string, null | Value> = {
    ebx: null,
    ecx: null,
    esi: null,
    edi: null,
    eax: null,
    edx: null,
    esp: null,
    ebp: null,
  };
  private stack: (Value | null)[] = shape(100, () => null);
  private memory: Record<string, Value> = {};

  private calledFunctions = new Set<string>();
  private usedRegisters = new Set<string>();
  private building = true;
  private minStackAddr = StateWatcher.stack_bp;
  private locks = new Map<string, number>();

  private localSize: number;

  constructor(size: number) {
    this.localSize = size;
  }

  /////////////////////////////////////////////////////////////////////////////////////////

  static numToVal(n: number): Value {
    return {
      type: "Variable",
      value: n,
      contains: null,
      incites: [],
    };
  }

  static inspectSnapshot(
    snap: Record<string, number>,
    find: (x: number) => Value | undefined,
  ): [Arg, Value][] {
    const info: [Arg, Value][] = [];
    for (const key in snap) {
      const val = find(snap[key]) ?? StateWatcher.numToVal(snap[key]);
      if (key.startsWith("glob_")) {
        info.push([$m(key.substring(5)), val]);
        continue;
      }
      if (key.startsWith("stack_")) {
        const offset = parseInt(key.substring(6));
        info.push([$s(offset * VALUE_SIZE), val]);
        continue;
      }

      if (VALUABLE_REGS.includes(key)) {
        info.push([$r(key), val]);
      }
    }

    return info;
  }

  static fromSnapshot(
    size: number,
    snap: Record<string, number>,
    find: (x: number) => Value | undefined,
  ) {
    const loc = new StateWatcher(size);
    loc.build();
    for (const key in snap) {
      const val = find(snap[key]) ?? StateWatcher.numToVal(snap[key]);
      if (key.startsWith("ignore_")) {
        continue;
      }
      if (key.startsWith("glob_")) {
        loc.set($m(key.substring(5)), val);
        continue;
      }
      if (key.startsWith("stack_")) {
        const idx = parseInt(key.substring(6)) * VALUE_SIZE;
        loc.set($s(idx), val);
        continue;
      }

      loc.set($r(key), val);
    }
    loc.work();
    return loc;
  }

  /////////////////////////////////////////////////////////////////////////////////////////

  update(snap: Record<string, number>) {
    this.build();
    for (const key in snap) {
      const val = StateWatcher.numToVal(snap[key]);
      if (key.startsWith("glob_")) {
        this.set($m(key.substring(5)), val);
        continue;
      }
      if (key.startsWith("stack_")) {
        const idx = parseInt(key.substring(6)) * VALUE_SIZE;
        this.set($s(idx), val);
        continue;
      }

      this.set($r(key), val);
    }
    this.work();
  }

  build() {
    this.building = true;
  }

  work() {
    this.building = false;
  }

  calledFunc(name: Arg) {
    if (name.type === "MemoryArg") {
      this.calledFunctions.add(name.location);
    }
  }

  /////////////////////////////////////////////////////////////////////////////////////////

  private incVal(x: Value | null | undefined) {
    if (x === null || x === undefined || x.type !== "Variable") {
      return;
    }
    if (!(x.value in this.statistic)) {
      this.statistic[x.value] = 0;
    }
    this.statistic[x.value] += 1;
  }

  private decVal(x: Value | null | undefined) {
    if (x === null || x === undefined || x.type !== "Variable") {
      return;
    }
    if (!(x.value in this.statistic)) {
      this.statistic[x.value] = 1;
    }
    this.statistic[x.value] -= 1;
    if (
      this.statistic[x.value] === 0 &&
      x.value in this.usings &&
      this.usings[x.value] > 0
    ) {
      console.error(x);
      throw new Error("U killed useful value!");
    }
  }

  private getValStat(x: Value | null | undefined) {
    if (x === null || x === undefined || x.type !== "Variable") {
      return 0;
    }
    if (!(x.value in this.statistic)) {
      this.statistic[x.value] = 0;
    }
    return this.statistic[x.value];
  }

  private freeRegisterTicker = -1;
  private findFreeRegisterFrom(included: string[]): Arg | null {
    const availableRegisters: string[] = [];
    for (const r in this.registers) {
      if (!included.includes(r)) {
        continue;
      }
      if (this.locks.has(`REG_${r}`)) {
        continue;
      }
      const v = this.registers[r];
      if (v === null) {
        availableRegisters.push(r);
        continue;
      }
      if (!this.isUseFull(v)) {
        availableRegisters.push(r);
        continue;
      }
      const s = this.getValStat(v);
      if (s > 1) {
        availableRegisters.push(r);
        continue;
      }
    }
    if (!availableRegisters.length) {
      return null;
    }

    this.freeRegisterTicker += 1;
    return $r(
      availableRegisters[this.freeRegisterTicker % availableRegisters.length],
    );
  }

  private findNotLockedRegister(included: string[]): Arg {
    const availableRegisters: string[] = [];
    for (const r of included) {
      if (this.locks.has(`REG_${r}`)) {
        continue;
      }
      availableRegisters.push(r);
    }
    if (!availableRegisters.length) {
      throw new Error("All registers are locked!");
    }

    return $r(availableRegisters[0]);
  }

  private findFreeRegister(): Arg | null {
    return this.findFreeRegisterFrom(["ebx", "ecx", "esi", "edi"]);
  }

  private findFreeBase(): Arg | null {
    return this.findFreeRegisterFrom(["eax, ebx", "ecx", "edx"]);
  }

  private findFreeMemory(): Arg {
    let i = StateWatcher.stack_bp - 1 - this.localSize;
    while (i > 0) {
      const e = this.stack[i];
      const idx = (i - StateWatcher.stack_bp) * VALUE_SIZE;
      if (this.locks.has(`STACK_${idx}`)) {
        --i;
        continue;
      }
      if (e) {
        if (!this.isUseFull(e)) {
          return $s(idx);
        }
        const s = this.getValStat(e);
        if (s > 1) {
          return $s(idx);
        }
      } else {
        break;
      }
      --i;
    }

    return $s((i - StateWatcher.stack_bp) * VALUE_SIZE);
  }

  private findFreeSpot(): Arg {
    const reg = this.findFreeRegister();
    if (reg) {
      return reg;
    }
    return this.findFreeMemory();
  }

  /////////////////////////////////////////////////////////////////////////////////////////

  public snip = false;

  getInfo(): [number, Set<string>] {
    return [
      Math.abs(this.minStackAddr - StateWatcher.stack_bp) * VALUE_SIZE,
      this.usedRegisters,
    ];
  }

  isUseFull(v: Value) {
    if (v.type !== "Variable") {
      return false;
    }
    if (!(v.value in this.usings)) {
      return false;
    }
    return this.usings[v.value] > 0;
  }

  hasOthers(v: Value) {
    if (v.value in this.statistic) {
      return this.statistic[v.value] > 1;
    }
    return false;
  }

  lock(v: Arg) {
    let name = "";
    if (v.type === "RegisterArg") {
      name = `REG_${v.value}`;
    }
    if (v.type === "StackArg") {
      name = `STACK_${v.position}`;
    }

    const record = this.locks.get(name);
    if (record !== undefined) {
      this.locks.set(name, record + 1);
    } else {
      this.locks.set(name, 1);
    }
  }

  unlock(v: Arg) {
    let name = "";
    if (v.type === "RegisterArg") {
      name = `REG_${v.value}`;
    }
    if (v.type === "StackArg") {
      name = `STACK_${v.position}`;
    }
    let record = this.locks.get(name) ?? 0;
    --record;
    if (record <= 0) {
      this.locks.delete(name);
    } else {
      this.locks.set(name, record);
    }
  }

  willBeUseLess(v: Value) {
    if (v.type !== "Variable") {
      return true;
    }
    if (!(v.value in this.usings)) {
      return true;
    }
    return this.usings[v.value] <= 1;
  }

  willBeUseLess2(v: Value, c: number) {
    if (v.type !== "Variable") {
      return true;
    }
    if (!(v.value in this.usings)) {
      return true;
    }
    return this.usings[v.value] <= c;
  }

  getUseFullMemory(): Arg[] {
    return Object.entries(this.memory)
      .filter(([, v]) => this.isUseFull(v))
      .map(([k]) => $m(k));
  }

  selectRegister(a: Arg, b: Arg): [Arg, Arg] {
    if (a.type === "RegisterArg") {
      return [a, b];
    }
    if (b.type === "RegisterArg") {
      return [b, a];
    }
    return [a, b];
  }

  doMove(x: Arg, y: Arg, e?: Value): Instruction[] {
    if (argEq(x, y)) {
      return [];
    }

    if (x.type === "LiteralArg") {
      this.move(x, y, e);
      return [$do("movl", x, y)];
    }

    if (x.type === "RegisterArg" || y.type === "RegisterArg") {
      this.move(x, y, e);
      return [$do("movl", x, y)];
    }

    const inst: Instruction[] = [];

    this.lock(x);
    this.lock(y);
    this.invalidate(y);

    const reg = this.allocateRegister() ?? this.allocateNotLockedRegister();
    const place = this.save(reg as RegisterArg, y);
    if (place) {
      this.move(reg, place);
      inst.push($do("movl", reg, place));
    }

    this.move(x, reg, e);
    inst.push($do("movl", x, reg));
    this.move(reg, y, e);
    inst.push($do("movl", reg, y));

    this.unlock(x);
    this.unlock(y);

    return inst;
  }

  banish(v: Value): Instruction[] {
    const a = this.tryGetLocation(v);
    if (!a) {
      return [];
    }
    if (a.type === "RegisterArg") {
      const b = this.allocateMemory();
      const move = this.doMove(a, b, v);
      this.invalidate(a);
      return move;
    }
    return [];
  }

  shouldISaveRegister(a: RegisterArg) {
    const v = this.getValue(a);
    if (v === null) {
      return false;
    }
    if (!this.isUseFull(v)) {
      return false;
    }
    const s = this.getValStat(v);
    if (s > 1) {
      return false;
    }
    return true;
  }

  hasFreeRegister() {
    return (
      this.findFreeRegisterFrom(["eax", "ebx", "ecx", "edx", "esi", "edi"]) !==
      null
    );
  }

  isLocked(a: Arg) {
    if (a.type === "RegisterArg") {
      return this.locks.has(`REG_${a.value}`);
    }
    if (a.type === "StackArg") {
      return this.locks.has(`STACK_${a.position}`);
    }
    return false;
  }

  canISaveUse2(a: Arg, c: number) {
    const v = this.getValue(a);
    if (v === null) {
      return true;
    }
    if (this.willBeUseLess2(v, c)) {
      return true;
    }
    const s = this.getValStat(v);
    if (s > 1) {
      return true;
    }
    return false;
  }

  canISaveUse(a: Arg, rightNotAllow = false) {
    if (a.type === "LiteralArg") {
      return false;
    }
    if (a.type === "MemoryArg") {
      return false;
    }
    if (rightNotAllow && a.type === "StackArg") {
      return false;
    }
    const v = this.getValue(a);
    if (v === null) {
      return true;
    }
    if (!this.isUseFull(v)) {
      return true;
    }
    const s = this.getValStat(v);
    if (s > 1 && a.type === "RegisterArg") {
      return true;
    }
    return false;
  }

  canISaveUse3(a: Arg) {
    if (a.type === "LiteralArg") {
      return false;
    }
    if (a.type === "MemoryArg") {
      return false;
    }
    const v = this.getValue(a);
    if (v === null) {
      return true;
    }
    if (!this.isUseFull(v)) {
      return true;
    }
    const s = this.getValStat(v);
    if (s > 1) {
      return true;
    }
    return false;
  }

  forgetValue(v: Value) {
    delete this.usings[v.value];
    delete this.statistic[v.value];
  }

  shouldUse(v: Value, times: number) {
    if (v.type === "Variable") {
      this.usings[v.value] = times;
    }
  }

  used(v: Value) {
    if (v.type === "Variable" && v.value in this.usings) {
      this.usings[v.value] -= 1;
    }
  }

  chooseCommutativeDest(a: Arg, b: Arg): [Arg, Arg] | null {
    if (a.type === "LiteralArg" && b.type === "RegisterArg") {
      const v = this.getValue(b)!;
      if (this.willBeUseLess(v)) {
        return [b, a];
      }
    }
    if (a.type === "RegisterArg" && b.type === "LiteralArg") {
      const v = this.getValue(a)!;
      if (this.willBeUseLess(v)) {
        return [a, b];
      }
    }
    if (a.type === "LiteralArg" || b.type === "LiteralArg") {
      return null;
    }

    const va = this.getValue(a)!;
    const vb = this.getValue(b)!;

    if (a.type !== "RegisterArg" && b.type !== "RegisterArg") {
      return null;
    }

    if (this.willBeUseLess(va) && a.type !== "MemoryArg") {
      return [a, b];
    }
    if (this.willBeUseLess(vb) && b.type !== "MemoryArg") {
      return [b, a];
    }
    return null;
  }

  chooseDest(a: Arg, b: Arg): [Arg, Arg] | null {
    if (b.type === "LiteralArg") {
      return null;
    }

    const vb = this.getValue(b)!;

    if (a.type !== "RegisterArg" && b.type !== "RegisterArg") {
      return null;
    }

    if (this.willBeUseLess(vb) && b.type === "RegisterArg") {
      return [b, a];
    }

    return null;
  }

  private setUltimate(x: Arg, v: Value | null) {
    if (x.type === "RegisterArg") {
      if (!this.building) {
        this.usedRegisters.add(x.value);
      }
      const old = this.registers[x.value];
      this.decVal(old);
      this.registers[x.value] = v;
      this.incVal(v);
      return;
    }
    if (x.type === "StackArg") {
      const e = StateWatcher.stack_bp + Math.floor(x.position / VALUE_SIZE);
      const item = this.stack[e];
      this.minStackAddr = Math.min(e, this.minStackAddr);
      if (item) {
        this.decVal(item);
      }
      this.stack[e] = v;
      this.incVal(v);
      return;
    }
    if (x.type === "MemoryArg") {
      this.decVal(this.memory[x.location]);
      if (v) {
        this.memory[x.location] = v;
        this.incVal(v);
      } else {
        delete this.memory[x.location];
      }
      return;
    }

    throw new Error(`Unknown argument!!! ${x.type}`);
  }

  set(x: Arg, v: Value) {
    this.setUltimate(x, v);
  }

  getValue(x: Arg): Value | null {
    if (x.type === "LiteralArg") {
      return null;
    }
    if (x.type === "LiteralStringArg") {
      return null;
    }
    if (x.type === "RegisterArg") {
      return this.registers[x.value];
    }
    if (x.type === "StackArg") {
      const e = Math.floor(StateWatcher.stack_bp + x.position / VALUE_SIZE);
      return this.stack[e];
    }
    if (x.type === "MemoryArg") {
      return this.memory[x.location] ?? null;
    }
    if (x.type === "ImmArg") {
      return null;
    }

    throw new Error("Unknown argument!!!");
  }

  tryGetLocation(x: Value): Arg | undefined {
    for (const r in this.registers) {
      const v = this.registers[r];
      if (v?.type === x.type && v.value === x.value) {
        return $r(r);
      }
    }
    let i = this.stack.length - 1;
    while (i > 0) {
      const e = this.stack[i];
      if (e) {
        if (e.type === x.type && e.value === x.value) {
          return $s((i - StateWatcher.stack_bp) * VALUE_SIZE);
        }
      }
      --i;
    }
    if (x.contains !== null) {
      return $l(x.contains);
    }
    for (const m in this.memory) {
      const v = this.memory[m];
      if (v.type === x.type && v.value === x.value) {
        return $m(m);
      }
    }
  }

  getLocation(x: Value): Arg {
    const loc = this.tryGetLocation(x);
    if (!loc) {
      throw new Error(`No value ${x.value}`);
    }
    return loc;
  }

  getLocations(x: Value): Arg[] {
    const result: Arg[] = [];
    for (const r in this.registers) {
      const v = this.registers[r];
      if (v?.type === x.type && v.value === x.value) {
        result.push($r(r));
      }
    }
    let i = this.stack.length - 1;
    while (i > 0) {
      const e = this.stack[i];
      if (e) {
        if (e.type === x.type && e.value === x.value) {
          result.push($s((i - StateWatcher.stack_bp) * VALUE_SIZE));
        }
      }
      --i;
    }
    for (const m in this.memory) {
      const v = this.memory[m];
      if (v.type === x.type && v.value === x.value) {
        result.push($m(m));
      }
    }

    if (x.contains !== null) {
      result.push($l(x.contains));
    }

    return result;
  }

  allocate(): Arg {
    return this.findFreeSpot();
  }

  allocateRegister(): Arg | null {
    return this.findFreeRegister();
  }

  allocateNotLockedRegister(): Arg {
    return this.findNotLockedRegister([
      "eax",
      "edx",
      "ebx",
      "ecx",
      "esi",
      "edi",
    ]);
  }

  allocateBasicRegister(): Arg | null {
    return this.findFreeBase();
  }

  allocateMemory(): Arg {
    return this.findFreeMemory();
  }

  liveRegisters(): Arg[] {
    const regs = ["eax", "edx", "ebx", "ecx", "esi", "edi"];
    return regs.map((e) => $r(e));
  }

  invalidate(x: Arg) {
    this.setUltimate(x, null);
  }

  save(x: RegisterArg, dest?: Arg): Arg | null {
    const v = this.registers[x.value];
    if (v === null) {
      return null;
    }
    if (!this.isUseFull(v)) {
      return null;
    }
    const s = this.getValStat(v);
    const dv = dest ? this.getValue(dest) : null;
    if (s > 1 && dv?.value !== v.value) {
      return null;
    }
    return this.allocate();
  }

  moveIfAny(x: Arg, y: Arg) {
    const v = this.getValue(x);
    if (v) {
      this.set(y, v);
      return true;
    }
    return false;
  }

  move(x: Arg, y: Arg, e?: Value) {
    let v = this.getValue(x);
    if (!v) {
      if (e) {
        v = e;
      } else {
        console.error(x);
        throw new Error("Can not move!");
      }
    }
    this.set(y, v);
  }

  print() {
    console.error("stack:");
    this.printStack();
    console.error("mem:");
    this.printMem();
    console.error("regs:");
    this.printRegs();
  }

  printStack() {
    for (let i = 0; i < this.stack.length; ++i) {
      const s = this.stack[i];
      if (s) {
        console.error(i - StateWatcher.stack_bp, s?.value);
      }
    }
  }

  printMem() {
    for (const key in this.memory) {
      console.error(key, this.memory[key].value);
    }
  }

  printRegs() {
    for (const r in this.registers) {
      console.error(r, this.registers[r]?.value);
    }
  }
}
