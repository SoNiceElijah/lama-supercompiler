import {
  Arg,
  Instruction,
  LiteralArg,
  RegisterArg,
  argEq,
} from "../common/asm";
import { extendRegisterName, R, shape } from "../common/utils";
import { InstructionNode, Snapshot } from "../common/types";
import { VALUE_SIZE } from "../common/types";

const STACK_SIZE = 100;
const STACK_START = 70;

type LitInstruction = {
  name: string;
  args: [LiteralArg, RegisterArg];
  justLabel: boolean;
  meta: boolean;
};

type MoveInstruction = {
  name: string;
  args: [RegisterArg, RegisterArg];
  justLabel: boolean;
  meta: boolean;
};

type NumberGen = () => number;
export class StateCounter {
  private stack: number[] = [];
  private memory = new Map<string, number>();
  private registers = {
    ebx: 0,
    ecx: 0,
    esi: 0,
    edi: 0,
    eax: 0,
    edx: 0,
    esp: 0,
    ebp: 0,
  };

  private flags = null as null | {
    original: InstructionNode;
    args: number[];
  };

  private state = {
    esp: STACK_START,
    ebp: STACK_START,
    frameBottom: STACK_START,
    symbolicStackSize: 0,
    localSize: 0,
    preserveEdx: false,
  };

  private pushes: Arg[] = [];
  private calls: [Instruction, number[], number][] = [];
  private call = null as null | {
    args: [number, Arg][];
    clojure: number[];
    call: Instruction;
    pops: Arg[];
    result: number;
  };

  // init
  private reset(newNumber: NumberGen) {
    this.stack = shape(STACK_SIZE, () => newNumber());

    const keys = this.memory.keys();
    for (const key of keys) {
      this.memory.set(key, newNumber());
    }

    for (const key in this.registers) {
      this.registers[key as keyof typeof this.registers] = newNumber();
    }

    this.flags = null;
  }

  resetSoft(newNumber: NumberGen) {
    this.reset(newNumber);
    this.state.esp = this.state.frameBottom;
  }

  resetHard(newNumber: NumberGen) {
    this.reset(newNumber);

    this.state.ebp = STACK_START;
    this.state.esp = STACK_START;
    this.state.frameBottom = STACK_START;
    this.state.symbolicStackSize = 0;
    this.state.preserveEdx = false;
  }

  frozeFrame() {
    this.state.frameBottom = this.state.esp;
  }

  inc(newNumber: NumberGen) {
    this.resetSoft(newNumber);
  }

  incMem(newNumber: NumberGen) {
    for (const [key] of this.memory) {
      this.memory.set(key, newNumber());
    }
    this.flags = null;
  }

  invalidate(place: string) {
    this.memory.delete(place);
  }

  affectsFlags(ins: InstructionNode, args: number[]) {
    this.flags = {
      original: ins,
      args,
    };
  }

  getLastFlagAffecter() {
    return this.flags;
  }

  preserveEdx() {
    this.state.preserveEdx = true;
  }

  snapshot(): Snapshot {
    function regs(lvl: number, edx: boolean) {
      const symst: string[] = [];
      if (edx) {
        symst.push("edx");
      }
      if (lvl >= 1) {
        symst.push("ebx");
      }
      if (lvl >= 2) {
        symst.push("ecx");
      }
      if (lvl >= 3) {
        symst.push("esi");
      }
      if (lvl >= 4) {
        symst.push("edi");
      }
      return symst;
    }

    const record: Snapshot = {};
    const stackSymbSize = Math.max(0, this.state.symbolicStackSize - 4);
    const start = this.state.ebp - this.state.localSize - stackSymbSize;

    record[`ignore_START`] = start;
    record[`ignore_LOCALS`] = this.state.localSize;
    record[`ignore_EBP`] = this.state.ebp;
    record[`ignore_SYMB`] = this.state.symbolicStackSize;

    for (let i = start; i < this.stack.length; ++i) {
      record[`stack_${i - this.state.ebp}`] = this.stack[i];
    }
    for (const [k, v] of this.memory) {
      record[`glob_${k}`] = v;
    }

    for (const reg of regs(
      this.state.symbolicStackSize,
      this.state.preserveEdx,
    )) {
      record[reg] = this.registers[reg as keyof typeof this.registers];
    }

    return record;
  }

  memSnapshot(): Snapshot {
    const record: Snapshot = {};
    for (const [k, v] of this.memory) {
      record[`glob_${k}`] = v;
    }

    return record;
  }

  isLocalVar(size: number, position: number) {
    if (position >= 0) {
      return false;
    }
    return Math.abs(position) <= size * VALUE_SIZE;
  }

  load(x: Snapshot) {
    for (const key in x) {
      if (key.startsWith("ignore_LOCALS")) {
        this.state.localSize = x[key];
        continue;
      }
      if (key.startsWith("ignore_SYMB")) {
        this.state.symbolicStackSize = x[key];
        continue;
      }
      if (key.startsWith("stack_")) {
        const idx = parseInt(key.substring(6));
        this.stack[this.state.ebp + idx] = x[key];
        continue;
      }
      if (key.startsWith("glob_")) {
        const name = key.substring(5);
        this.memory.set(name, x[key]);
        continue;
      }

      this.registers[key as keyof typeof this.registers] = x[key];
    }
  }

  static cutOuter(x: Snapshot): Set<string> {
    const snap = new Set<string>();
    for (const key in x) {
      if (key.startsWith("stack_")) {
        const idx = parseInt(key.substring(6));
        if (idx >= 0) {
          snap.add(key);
        }
        continue;
      }
      if (key.startsWith("glob_")) {
        snap.add(key);
        continue;
      }
    }

    return snap;
  }

  private isEsp(x: Arg): boolean {
    return x.type === "RegisterArg" && x.value === "esp";
  }

  private isEbp(x: Arg): boolean {
    return x.type === "RegisterArg" && x.value === "ebp";
  }

  push(a: Arg, n?: number) {
    this.pushes.push(a);
    this.state.esp -= 1;

    let val = 0;
    if (a.type === "RegisterArg") {
      val = this.registers[a.value as keyof typeof this.registers];
    }
    if (a.type === "StackArg") {
      val = this.stack[this.state.ebp + Math.floor(a.position / VALUE_SIZE)];
    }
    if (
      a.type === "LiteralStringArg" ||
      a.type === "LiteralArg" ||
      a.type === "ImmArg"
    ) {
      if (n === undefined) {
        throw new Error("WOW, Error");
      }
      val = n;
    }

    this.stack[this.state.esp] = val;
  }

  pop(a: Arg) {
    const val = this.stack[this.state.esp];
    this.state.esp += 1;
    if (a.type === "RegisterArg") {
      this.registers[a.value as keyof typeof this.registers] = val;
    }
    if (a.type === "StackArg") {
      this.stack[Math.floor(a.position / VALUE_SIZE) + this.state.ebp] = val;
    }

    if (this.call) {
      this.call.pops.push(a);
    }

    this.submitCall();
  }

  pollCall() {
    return this.calls.shift();
  }

  get(a: Arg, gen?: NumberGen): number {
    if (a.type === "RegisterArg") {
      return this.registers[
        extendRegisterName(a.value) as keyof typeof this.registers
      ];
    }
    if (a.type === "StackArg") {
      const offset = Math.floor(a.position / VALUE_SIZE);
      return this.stack[this.state.ebp + offset];
    }
    if (a.type === "MemoryArg") {
      if (!this.memory.has(a.location)) {
        if (gen === undefined) {
          throw new Error("xxxxx");
        }
        this.memory.set(a.location, gen());
      }
      return this.memory.get(a.location)!;
    }

    console.error(a);
    throw new Error("Unknown arg");
  }

  prepareCall(x: Instruction, n: number) {
    const numbers = this.offset();
    const args: [number, Arg][] = [];
    let i = 1;
    for (const n of numbers) {
      const p = this.pushes.at(-i)!;
      args.push([n, p]);
      ++i;
    }

    const clojure: number[] = [];
    const [arg] = x.args;
    if (arg.type === "ImmArg") {
      clojure.push(this.get(arg.base), this.get(R.edx));
    }

    this.call = {
      args,
      call: x,
      pops: [],
      clojure,
      result: n,
    };

    if (this.state.esp >= this.state.frameBottom) {
      this.submitCall();
    }
  }

  put(a: Arg, v: number) {
    if (a.type === "RegisterArg") {
      return (this.registers[
        extendRegisterName(a.value) as keyof typeof this.registers
      ] = v);
    }
    if (a.type === "StackArg") {
      const offset = Math.floor(a.position / VALUE_SIZE);
      return (this.stack[this.state.ebp + offset] = v);
    }
    if (a.type === "MemoryArg") {
      return this.memory.set(a.location, v);
    }

    console.error(a);
    throw new Error("Unknown arg");
  }

  propagate(a: Arg, b: Arg) {
    const v = this.get(a);
    this.put(b, v);
  }

  top() {
    return this.stack[this.state.esp];
  }

  offset(): number[] {
    const answer = [];
    for (let i = this.state.esp; i < this.state.frameBottom; ++i) {
      answer.push(this.stack[i]);
    }

    return answer;
  }

  private canMoveEbp(x: Instruction): x is MoveInstruction {
    return (
      x.args.length === 2 &&
      this.isEbp(x.args[1]) &&
      this.isEsp(x.args[0]) &&
      x.name.startsWith("mov")
    );
  }

  private canMoveEsp(x: Instruction): x is MoveInstruction {
    return (
      x.args.length === 2 &&
      this.isEsp(x.args[1]) &&
      this.isEbp(x.args[0]) &&
      x.name.startsWith("mov")
    );
  }

  private canUpdateEsp(x: Instruction): x is LitInstruction {
    const cond = x.args.length === 2 && this.isEsp(x.args[1]);

    if (!cond) {
      return false;
    }

    if (
      cond &&
      (x.name.startsWith("add") || x.name.startsWith("sub")) &&
      x.args[0].type === "LiteralArg"
    ) {
      return true;
    }

    console.error(x);
    throw new Error("Can not process this entity!");
  }

  private submitCall() {
    if (this.call && this.state.esp >= this.state.frameBottom) {
      const args: number[] = [];

      this.call.args.reverse();
      this.call.pops.reverse();

      let i = 0;
      while (i < this.call.args.length && i < this.call.pops.length) {
        if (!argEq(this.call.args[i][1], this.call.pops[i])) {
          break;
        }
        ++i;
      }

      while (i < this.call.args.length) {
        args.push(this.call.args[i][0]);
        ++i;
      }

      this.calls.push([
        this.call.call,
        this.call.clojure.concat(args.reverse()),
        this.call.result,
      ]);

      this.call = null;
    }
  }

  checkSymbolicStack(x: Instruction, localSize: number) {
    this.state.localSize = localSize;
    if (x.name === "movl") {
      const [fr, to] = x.args;
      if (fr.type === "RegisterArg") {
        if (fr.value === "ebx") {
          this.state.symbolicStackSize = 0;
        }
        if (fr.value === "ecx") {
          this.state.symbolicStackSize = 1;
        }
        if (fr.value === "esi") {
          this.state.symbolicStackSize = 2;
        }
        if (fr.value === "edi") {
          this.state.symbolicStackSize = 3;
        }
      }
      if (fr.type === "StackArg" && fr.position < 0) {
        const pos = Math.abs(Math.floor(fr.position / VALUE_SIZE));
        if (!this.isLocalVar(localSize, fr.position)) {
          this.state.symbolicStackSize = pos - localSize + 3;
        }
      }
      if (to.type === "RegisterArg") {
        if (to.value === "ebx") {
          this.state.symbolicStackSize = 1;
        }
        if (to.value === "ecx") {
          this.state.symbolicStackSize = 2;
        }
        if (to.value === "esi") {
          this.state.symbolicStackSize = 3;
        }
        if (to.value === "edi") {
          this.state.symbolicStackSize = 4;
        }
      }
      if (to.type === "StackArg" && to.position < 0) {
        const pos = Math.abs(Math.floor(to.position / VALUE_SIZE));
        if (!this.isLocalVar(localSize, to.position)) {
          this.state.symbolicStackSize = pos - localSize + 4;
        }
      }
    }
  }

  getSymbolicStack() {
    return this.state.symbolicStackSize;
  }

  technicOp(x: Instruction, gen: NumberGen) {
    if (this.canMoveEbp(x)) {
      this.state.ebp = this.state.esp;
      this.registers.ebp = this.registers.esp;
      return true;
    }

    if (this.canMoveEsp(x)) {
      this.state.esp = this.state.ebp;
      this.registers.esp = this.registers.ebp;
      return true;
    }

    if (this.canUpdateEsp(x)) {
      const [c] = x.args;
      if (x.name.startsWith("add")) {
        this.state.esp += Math.floor(c.value / VALUE_SIZE);
        this.registers.esp = gen();
      }
      if (x.name.startsWith("sub")) {
        this.state.esp -= Math.floor(c.value / VALUE_SIZE);
        this.registers.esp = gen();
      }

      this.submitCall();
      return true;
    }
    return false;
  }
}
