import { Arg, Instruction, RegisterArg, showInstDebug } from "../common/asm";
import { StateWatcher } from "./stateWatcher";
import { $do, $i } from "../common/utils";
import { Value } from "../common/types";

type AddrDescType = "register" | "memory" | "literal" | "indirect";
class AddrDesc {
  private desc: {
    type: AddrDescType;
    destination: boolean;
    constant?: number;
  };

  static get reg() {
    return new AddrDesc("register");
  }

  static get mem() {
    return new AddrDesc("memory");
  }

  static get lit() {
    return new AddrDesc("literal");
  }

  static get ind() {
    return new AddrDesc("indirect");
  }

  private constructor(type: AddrDescType) {
    this.desc = {
      type,
      destination: false,
    };
  }

  get d() {
    if (this.desc.constant !== undefined) {
      throw new Error("R u sure??");
    }
    this.desc.destination = true;
    return this;
  }

  v(x: number) {
    if (this.desc.type !== "literal") {
      throw new Error("R u sure??");
    }
    this.desc.constant = x;
    return this;
  }

  private sameType(x: Arg): boolean {
    if (x.type === "RegisterArg") {
      return this.desc.type === "register";
    }
    if (x.type === "LiteralArg" || x.type === "LiteralStringArg") {
      return this.desc.type === "literal";
    }
    if (x.type === "StackArg" || x.type === "ImmArg") {
      return this.desc.type === "indirect";
    }
    if (x.type === "MemoryArg") {
      return this.desc.type === "memory";
    }
    return false;
  }

  private matchArg(x: Arg): [false] | [true, number] {
    if (x.type === "RegisterArg") {
      if (this.desc.type === "register") {
        return [true, 0];
      }
      if (this.desc.type === "literal") {
        return [false];
      }
      return [true, 100];
    }
    if (x.type === "MemoryArg") {
      if (this.desc.type === "memory") {
        return [true, 0];
      }
      if (this.desc.type === "literal") {
        return [false];
      }
      if (this.desc.type === "indirect") {
        return [true, 200];
      }
      return [true, 100];
    }
    if (x.type === "LiteralArg" || x.type === "LiteralStringArg") {
      if (this.desc.type === "literal") {
        if (this.desc.constant !== undefined) {
          if (x.value === this.desc.constant) {
            return [true, 0];
          } else {
            return [false];
          }
        }
        return [true, 0];
      }
      return [true, 100];
    }
    if (x.type === "StackArg" || x.type === "ImmArg") {
      if (this.desc.type === "indirect") {
        return [true, 0];
      }
      if (this.desc.type === "literal") {
        return [false];
      }
      if (this.desc.type === "memory") {
        return [true, 200];
      }
      return [true, 100];
    }

    return [false];
  }

  howGoodFor(
    x: Arg,
    canRewrite: boolean,
    haveFreeRegister: boolean,
  ): [false] | [true, number] {
    const [r, c] = this.matchArg(x);
    if (r) {
      let c1 = this.desc.destination && !canRewrite ? 100 : 0;
      if (c1 > 0 && x.type === "MemoryArg") {
        c1 += 10;
      }
      let c2 = 0;
      if (
        this.desc.destination &&
        haveFreeRegister &&
        (this.desc.type === "memory" || this.desc.type === "indirect")
      ) {
        c2 += 500;
      }
      return [r, c + c1 + c2];
    }
    return [false];
  }

  show(): string {
    return `${this.desc.type}[${this.desc.destination}, ${this.desc.constant}]`;
  }

  cast(
    x: Arg,
    v: Value,
    locs: StateWatcher,
    count: number,
  ): [Arg, Instruction[]] {
    if (this.sameType(x)) {
      const move: Instruction[] = [];
      if (this.desc.destination) {
        if (!locs.canISaveUse2(x, count)) {
          const nx = locs.allocate();
          move.push(...locs.doMove(x, nx, v));
        }
      }
      return [x, move];
    }

    if (this.desc.type === "register") {
      const nx = locs.allocateRegister() ?? locs.allocateNotLockedRegister();
      const place = locs.save(nx as RegisterArg);

      const inst: Instruction[] = [];
      if (place) {
        inst.push(...locs.doMove(nx, place));
      }
      return [nx, inst.concat(locs.doMove(x, nx, v))];
    }

    const nx = locs.allocateMemory();
    return [nx, locs.doMove(x, nx, v)];
  }
}

const T = AddrDesc;
type Ts = AddrDesc;
type ActionArg = {
  original: Arg;
  d: (n?: number) => ActionArg;
};
type MemDesc = Ts[];
type InstHandler = (...xs: ActionArg[]) => [string, ActionArg[]];
type MemMap = [MemDesc, Set<string>, InstHandler][];

class StorageBuilder {
  private storage: MemMap = [];

  rule(x: MemDesc, f: InstHandler) {
    this.storage.push([x, new Set(), f]);
    return this;
  }

  into(x: MemDesc, f: InstHandler) {
    this.storage.push([x, new Set(["reg.d"]), f]);
    return this;
  }

  compile() {
    return this.storage;
  }
}

function zip<T, U>(xs: T[], ys: U[]) {
  const result: [T, U][] = [];
  for (let i = 0; i < xs.length && i < ys.length; ++i) {
    result.push([xs[i], ys[i]]);
  }
  return result;
}

export class Selector {
  private storage: Map<string, MemMap> = new Map();

  add(name: string, f: (x: StorageBuilder) => StorageBuilder) {
    this.storage.set(name, f(new StorageBuilder()).compile());
    return this;
  }

  private matchArgs(
    mems: MemDesc,
    stat: Map<Value, number>,
    vals: [Value, Arg[]][],
    locs: StateWatcher,
  ): [number, Arg[]] | undefined {
    if (mems.length !== vals.length) {
      return undefined;
    }

    let sum = 0;
    const args: Arg[] = [];
    for (const [mem, [u, vs]] of zip(mems, vals)) {
      const found = {
        sum: 10000000000000,
        mem: null as null | Arg,
      };

      const hasFree = locs.hasFreeRegister();
      for (const v of vs) {
        const [r, c] = mem.howGoodFor(
          v,
          vs.length > 1 || locs.willBeUseLess2(u, stat.get(u)!),
          hasFree,
        );
        if (r) {
          if (c < found.sum) {
            found.sum = c;
            found.mem = v;
          }
        }
      }

      if (!found.mem) {
        return undefined;
      }

      sum += found.sum;
      args.push(found.mem);
    }

    return [sum, args];
  }

  private static showMem(mem: MemDesc): string {
    return mem.map((e) => e.show()).join(", ");
  }

  match(
    i: Instruction,
    args: Value[],
    vs: Value[],
    locs: StateWatcher,
  ): Instruction[] {
    const box = this.storage.get(i.name);
    if (!box) {
      return [i];
    }

    const stat = new Map<Value, number>();
    for (const a of args) {
      if (!stat.has(a)) {
        stat.set(a, 0);
      }
      const c = stat.get(a)!;
      stat.set(a, c + 1);
    }

    let answer: [MemDesc, Arg[], Set<string>, InstHandler] | null = null;
    let min = 1000000;

    // console.error('-------------------------------')
    for (const [mems, traits, to] of box) {
      if (mems.length !== args.length) {
        continue;
      }

      const vals = args.map((e) => [e, locs.getLocations(e)] as [Value, Arg[]]);
      // console.error(vals.map(e => e.map(showArgDebug).join(', ')).join(' | '))
      const res = this.matchArgs(mems, stat, vals, locs);
      if (!res) {
        continue;
      }

      let sum = res[0];
      const ys = res[1];
      // console.error(sum, i.name, Selector.showMem(mems));
      if (traits.has("reg.d")) {
        const r = locs.allocateRegister();
        if (!r) {
          sum += 100;
        }
      }
      if (sum < min) {
        min = sum;
        answer = [mems, ys, traits, to];
        // console.error()
      }
    }

    const inst: Instruction[] = [];
    if (answer) {
      const hs: Arg[] = [];
      const [mems, xs, traits, to] = answer;

      for (const a of xs) {
        locs.lock(a);
      }
      for (const [[m, a], b] of zip(zip(mems, xs), args)) {
        const count = stat.get(b)!;
        const [h, iss] = m.cast(a, b, locs, count);
        locs.lock(h);
        locs.unlock(a);
        locs.used(b);
        hs.push(h);
        inst.push(...iss);
      }
      if (traits.has("reg.d")) {
        const r = locs.allocateRegister() ?? locs.allocateNotLockedRegister();
        const place = locs.save(r as RegisterArg);
        if (place) {
          inst.push(...locs.doMove(r, place));
        }
        locs.lock(r);
        hs.push(r);
      }

      const ks: ActionArg[] = hs.map((e) => {
        const item: ActionArg = {
          original: e,
          d: function (n = 0): ActionArg {
            locs.set(e, vs[n]);
            return this;
          },
        };

        return item;
      });
      const [n, ns] = to(...ks);
      // console.error("#", n, Selector.showMem(mems))
      inst.push($do(n, ...ns.map((e) => e.original)));
      for (const h of hs) {
        locs.unlock(h);
      }
    } else {
      console.error("INST:", showInstDebug(i));
      throw new Error("SPECIFICATION NOT FOUND!");
    }
    return inst;
  }
}

function $up(x: Arg): ActionArg {
  return {
    original: x,
    d: function () {
      return this;
    },
  };
}

function ind(a: ActionArg, b: ActionArg) {
  if (b.original.type !== "LiteralArg") {
    throw new Error("B not lit");
  }
  if (a.original.type !== "RegisterArg") {
    throw new Error("A not reg");
  }

  return $up($i(a.original, b.original.value));
}

function rev(a: ActionArg): ActionArg {
  if (a.original.type !== "LiteralArg") {
    throw new Error("Why u do this to me?");
  }
  return {
    ...a,
    original: {
      type: a.original.type,
      value: -a.original.value,
    },
  };
}

export const selector = new Selector();
selector.add("addl", (b) =>
  b
    .rule([T.reg.d, T.lit.v(1)], (x) => ["incl", [x.d()]])
    .rule([T.lit.v(1), T.reg.d], (_, x) => ["incl", [x.d()]])
    .rule([T.reg.d, T.lit.v(-1)], (x) => ["decl", [x.d()]])
    .rule([T.lit.v(-1), T.reg.d], (_, x) => ["decl", [x.d()]])
    /////////////////////////////////////////////////////////
    .into([T.reg, T.lit], (a, b, r) => ["leal", [ind(a, b), r.d()]])
    .into([T.lit, T.reg], (a, b, r) => ["leal", [ind(b, a), r.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.reg.d, T.lit], (a, b) => ["addl", [b, a.d()]])
    .rule([T.lit, T.reg.d], (a, b) => ["addl", [a, b.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.reg.d, T.reg], (a, b) => ["addl", [b, a.d()]])
    .rule([T.reg, T.reg.d], (a, b) => ["addl", [a, b.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.mem, T.reg.d], (a, b) => ["addl", [a, b.d()]])
    .rule([T.reg.d, T.mem], (a, b) => ["addl", [b, a.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.reg, T.ind.d], (a, b) => ["addl", [a, b.d()]])
    .rule([T.ind.d, T.reg], (a, b) => ["addl", [b, a.d()]])
    .rule([T.ind, T.reg.d], (a, b) => ["addl", [a, b.d()]])
    .rule([T.reg.d, T.ind], (a, b) => ["addl", [b, a.d()]]),
);

selector.add("subl", (b) =>
  b
    .rule([T.lit.v(-1), T.reg.d], (_, x) => ["incl", [x.d()]])
    .rule([T.lit.v(1), T.reg.d], (_, x) => ["decl", [x.d()]])
    /////////////////////////////////////////////////////////
    .into([T.lit, T.reg], (a, b, r) => ["leal", [ind(b, rev(a)), r.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.lit, T.reg.d], (a, b) => ["subl", [a, b.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.reg, T.reg.d], (a, b) => ["subl", [a, b.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.mem, T.reg.d], (a, b) => ["subl", [a, b.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.reg, T.ind.d], (a, b) => ["subl", [a, b.d()]])
    .rule([T.ind, T.reg.d], (a, b) => ["subl", [a, b.d()]]),
);

selector.add(
  "cmpl",
  (b) =>
    b
      .rule([T.lit, T.reg], (a, b) => ["cmpl", [a, b]])
      .rule([T.lit, T.mem], (a, b) => ["cmpl", [a, b]])
      /////////////////////////////////////////////////////////
      .rule([T.reg, T.reg], (a, b) => ["cmpl", [a, b]])
      /////////////////////////////////////////////////////////
      .rule([T.reg, T.mem], (a, b) => ["cmpl", [a, b]])
      .rule([T.mem, T.reg], (a, b) => ["cmpl", [a, b]])
      /////////////////////////////////////////////////////////
      .rule([T.reg, T.ind], (a, b) => ["cmpl", [a, b]])
      .rule([T.ind, T.reg], (a, b) => ["cmpl", [a, b]]),
  /////////////////////////////////////////////////////////
);

selector.add("andl", (b) =>
  b
    .rule([T.reg.d, T.lit], (a, b) => ["andl", [b, a.d()]])
    .rule([T.lit, T.reg.d], (a, b) => ["andl", [a, b.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.reg.d, T.reg], (a, b) => ["andl", [b, a.d()]])
    .rule([T.reg, T.reg.d], (a, b) => ["andl", [a, b.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.mem, T.reg.d], (a, b) => ["andl", [a, b.d()]])
    .rule([T.reg.d, T.mem], (a, b) => ["andl", [b, a.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.reg, T.ind.d], (a, b) => ["andl", [a, b.d()]])
    .rule([T.ind.d, T.reg], (a, b) => ["andl", [b, a.d()]])
    .rule([T.ind, T.reg.d], (a, b) => ["andl", [a, b.d()]])
    .rule([T.reg.d, T.ind], (a, b) => ["andl", [b, a.d()]]),
);

selector.add("xorl", (b) =>
  b
    .rule([T.reg.d, T.lit], (a, b) => ["xorl", [b, a.d()]])
    .rule([T.lit, T.reg.d], (a, b) => ["xorl", [a, b.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.reg.d, T.reg], (a, b) => ["xorl", [b, a.d()]])
    .rule([T.reg, T.reg.d], (a, b) => ["xorl", [a, b.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.mem, T.reg.d], (a, b) => ["xorl", [a, b.d()]])
    .rule([T.reg.d, T.mem], (a, b) => ["xorl", [b, a.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.reg, T.ind.d], (a, b) => ["xorl", [a, b.d()]])
    .rule([T.ind.d, T.reg], (a, b) => ["xorl", [b, a.d()]])
    .rule([T.ind, T.reg.d], (a, b) => ["xorl", [a, b.d()]])
    .rule([T.reg.d, T.ind], (a, b) => ["xorl", [b, a.d()]]),
);

selector.add("orl", (b) =>
  b
    .rule([T.reg.d, T.lit], (a, b) => ["orl", [b, a.d()]])
    .rule([T.lit, T.reg.d], (a, b) => ["orl", [a, b.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.reg.d, T.reg], (a, b) => ["orl", [b, a.d()]])
    .rule([T.reg, T.reg.d], (a, b) => ["orl", [a, b.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.mem, T.reg.d], (a, b) => ["orl", [a, b.d()]])
    .rule([T.reg.d, T.mem], (a, b) => ["orl", [b, a.d()]])
    /////////////////////////////////////////////////////////
    .rule([T.reg, T.ind.d], (a, b) => ["orl", [a, b.d()]])
    .rule([T.ind.d, T.reg], (a, b) => ["orl", [b, a.d()]])
    .rule([T.ind, T.reg.d], (a, b) => ["orl", [a, b.d()]])
    .rule([T.reg.d, T.ind], (a, b) => ["orl", [b, a.d()]]),
);

selector.add("imull", (b) =>
  b
    .rule([T.reg, T.reg.d], (a, b) => ["imull", [a, b.d()]])
    .rule([T.reg.d, T.reg], (a, b) => ["imull", [b, a.d()]])
    .rule([T.ind, T.reg.d], (a, b) => ["imull", [a, b.d()]])
    .rule([T.mem, T.reg.d], (a, b) => ["imull", [a, b.d()]])
    .rule([T.reg.d, T.ind], (a, b) => ["imull", [b, a.d()]])
    .rule([T.reg.d, T.mem], (a, b) => ["imull", [b, a.d()]])
    .into([T.lit, T.reg], (a, b, r) => ["imull", [a, b, r.d()]])
    .into([T.reg, T.lit], (a, b, r) => ["imull", [b, a, r.d()]])
    .into([T.lit, T.ind], (a, b, r) => ["imull", [a, b, r.d()]])
    .into([T.ind, T.lit], (a, b, r) => ["imull", [b, a, r.d()]])
    .into([T.lit, T.mem], (a, b, r) => ["imull", [a, b, r.d()]])
    .into([T.mem, T.lit], (a, b, r) => ["imull", [b, a, r.d()]]),
);

selector.add("sarl", (b) =>
  b
    .rule([T.reg.d], (a) => ["sarl", [a.d()]])
    .rule([T.ind.d], (a) => ["sarl", [a.d()]]),
);

selector.add("sall", (b) =>
  b
    .rule([T.reg.d], (a) => ["sall", [a.d()]])
    .rule([T.ind.d], (a) => ["sall", [a.d()]]),
);

selector.add("decl", (b) =>
  b
    .rule([T.reg.d], (a) => ["decl", [a.d()]])
    .rule([T.ind.d], (a) => ["decl", [a.d()]]),
);
