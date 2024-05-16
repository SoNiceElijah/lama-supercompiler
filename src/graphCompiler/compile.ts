import {
  Arg,
  Instruction,
  RegisterArg,
  argEq,
  showInstDebug,
} from "../common/asm";
import { Graph, ProgramGraph } from "../common/graph";
import { InstructionNode, VALUE_SIZE, Value, ValueNode } from "../common/types";
import {
  $__m,
  $do,
  $i,
  $l,
  $lab,
  $ls,
  $m,
  $r,
  Code,
  R,
  downGradeRegisterTo32,
  low,
} from "../common/utils";
import { run } from "../common/visitor";
import { selector } from "./selector";
import { StateWatcher } from "./stateWatcher";

export function compile(rel: ProgramGraph): Instruction[] {
  const info = rel.getDesc();
  const gr = rel.expose();

  const calleeSaved: string[] = [];

  const usedRegs = new Set<string>();
  let stackSize = -10;
  let clojure = false;

  if (!gr.length) {
    return [];
  }

  const lab = gr[0].getLabels()[0];

  const code: Instruction[] = [];
  for (const g of gr) {
    const [inst, regs, size, cloj] = compileLinearBlock(g);
    code.push(...inst);

    for (const reg of calleeSaved) {
      if (regs.has(reg)) {
        usedRegs.add(reg);
      }
    }

    clojure = clojure || cloj;
    stackSize = Math.max(stackSize, size);
  }

  const prelude: Instruction[] = [];
  const epilogue: Instruction[] = [];

  if (info.type === "Module" || info.type === "Main") {
    prelude.push(
      $lab(info.perfTest ? `${info.name}_optimized` : info.name),
      $do("movl", $m("_init"), R.eax),
      $do("test", R.eax, R.eax),
      $do("jz", $m("_continue")),
      $do("ret"),
      $lab("_ERROR"),
      $do("call", $m("Lbinoperror")),
      $do("ret"),
      $lab("_ERROR2"),
      $do("call", $m("Lbinoperror2")),
      $do("ret"),
    );
  }

  if (lab) {
    prelude.push({
      label: lab,
      justLabel: true,
      meta: false,
      name: "",
      args: [],
    });
    if (info.perfTest) {
      prelude.push({
        label: `${lab}_optimized`,
        justLabel: true,
        meta: false,
        name: "",
        args: [],
      });
    }
  }

  if (info.type === "Module" || info.type === "Main") {
    prelude.push($do("movl", $l(1), $m("_init")));
  }

  epilogue.push($do("movl", R.ebp, R.esp), $do("popl", R.ebp));

  const pops: Instruction[] = [];
  if (clojure) {
    prelude.push($do("pushl", R.edx));
    pops.push($do("popl", R.edx));
  }

  for (const reg of usedRegs) {
    prelude.push($do("pushl", $r(reg)));
    pops.push($do("popl", $r(reg)));
  }

  pops.reverse();
  epilogue.push(...pops);
  epilogue.push($do("ret"));

  prelude.push(
    $do("pushl", R.ebp),
    $do("movl", R.esp, R.ebp),
    $do("subl", $l(stackSize), R.esp),
  );

  if (info.filled && stackSize > 0) {
    prelude.push(
      $do("movl", R.esp, R.edi),
      $do("movl", $ls("filler"), R.esi),
      $do("movl", $l(Math.max(0, Math.floor(stackSize / 4))), R.ecx),
      $do("rep", $__m("movsl")),
    );
  }

  function mapInst(i: Instruction): Instruction {
    const newArgs: Arg[] = [];
    for (const arg of i.args) {
      if (arg.type === "StackArg" && arg.position > 0) {
        newArgs.push({
          type: "StackArg",
          position: usedRegs.size * VALUE_SIZE + arg.position,
        });
      } else {
        newArgs.push(arg);
      }
    }

    return {
      ...i,
      args: newArgs,
    };
  }

  function expandInst(i: Instruction): Instruction[] {
    if (i.name === "tailrec") {
      return [$do("movl", R.ebp, R.esp), $do("popl", R.ebp), ...pops];
    }
    if (i.name === "tailrec_clojure") {
      if (clojure) {
        const ps = pops.slice(0, -1);
        return [
          $do("movl", R.ebp, R.esp),
          $do("popl", R.ebp),
          ...ps,
          $do("addl", $l(4), R.esp),
          $do("jmp", $m("*(%edx)")),
        ];
      } else {
        return [
          $do("movl", R.ebp, R.esp),
          $do("popl", R.ebp),
          ...pops,
          $do("jmp", $m("*(%edx)")),
        ];
      }
    }
    return [i];
  }

  const answer = code.map(mapInst).flatMap(expandInst);

  return prelude.concat(answer).concat(epilogue);
}

function compileLinearBlock(
  me: Graph,
): [Instruction[], Set<string>, number, boolean] {
  const visited = new Set<ValueNode | InstructionNode>();
  const code = new Code();

  function goNode(n: ValueNode, locs: StateWatcher): Value {
    if (visited.has(n)) {
      return n.value;
    }

    const finalSnap = me.getFinalSnapshot();
    const items = new Set(finalSnap ? Object.values(finalSnap) : []);
    const isInFinal = (x: number) => items.has(x);

    const end = me.getEnd();
    visited.add(n);
    if (n === end) {
      const snap = me.getFinalSnapshot();
      if (snap) {
        const vals = Object.values(snap);
        for (const v of vals) {
          locs.shouldUse(me.findValue(v) ?? StateWatcher.numToVal(v), 1000000);
        }
      }
      locs.shouldUse(n.value, 0);
    } else {
      const len = n.stream.length + (isInFinal(n.value.value) ? 1000000 : 0);
      locs.shouldUse(n.value, len);
    }
    for (const c of n.createdBy) {
      const vs: Value[] = [];
      for (const e of c.down) {
        const len = e.stream.length + (isInFinal(e.value.value) ? 1000000 : 0);
        locs.shouldUse(e.value, len);
        vs.push(e.value);
      }
      goInst(c, vs, locs);
    }
    return n.value;
  }

  let cmpAnswerIncite: [number, number] | null = null;
  function goInst(n: InstructionNode, vs: Value[], locs: StateWatcher) {
    function addInst(name: string, args: Arg[]) {
      code.push({
        name,
        justLabel: false,
        meta: false,
        args,
      });
    }

    function doMove(a: Arg, b: Arg, vl?: Value) {
      code.push(...locs.doMove(a, b, vl));
    }

    if (visited.has(n)) {
      return;
    }
    visited.add(n);

    const [v] = vs;
    const vals: Value[] = n.up.map((e) => goNode(e, locs));

    function checkContains(len: number) {
      if (vals.length < len) {
        return false;
      }
      const vals2 = vals.slice(0, len);
      for (const v of vals2) {
        if (v.contains === null) {
          return false;
        }
      }
      return true;
    }

    function select(f: (...xs: number[]) => number) {
      return (e: Instruction) => {
        if (checkContains(f.length)) {
          v.contains = f(...vals.map((x) => x.contains as number));
          return;
        }
        code.push(...selector.match(e, vals, vs, locs));
      };
    }

    const go = run({
      other: (e) => {
        code.push(e);
      },
      call: (e) => {
        const [name] = e.args;
        const args = name.type === "ImmArg" ? vals.slice(2) : vals;

        const reversedArgs: Value[] = [...args];
        reversedArgs.reverse();

        for (const val of reversedArgs) {
          const va = locs.getLocation(val);
          addInst("pushl", [va]);
          locs.used(val);
        }

        if (e.args.length === 2) {
          const a = e.args.pop();
          if (a?.type === "MetaArg" && a.content === "#SNAP") {
            const mems = locs.getUseFullMemory();
            for (const mem of mems) {
              const x = locs.allocate();
              doMove(mem, x);
            }

            const snap = me.pollSnapshot();
            locs.update(snap);
          }
        }

        locs.lock(R.eax);
        locs.lock(R.edx);

        locs.lock(R.ebx);
        locs.lock(R.ecx);
        locs.lock(R.esi);
        locs.lock(R.edi);

        const place = locs.save(R.eax);
        if (place) {
          locs.move(R.eax, place);
          addInst("movl", [R.eax, place]);
        }
        locs.invalidate(R.eax);

        if (name.type === "ImmArg") {
          const a = locs.getLocation(vals[1]);
          if (!argEq(a, R.edx)) {
            locs.lock(a);
            const edxPlace = locs.save(R.edx);
            if (edxPlace) {
              locs.move(R.edx, edxPlace);
              addInst("movl", [R.edx, edxPlace]);
            }
            locs.move(a, R.edx);
            addInst("movl", [a, R.edx]);
            locs.unlock(a);
          }
          name.base = R.edx;
        } else {
          const edxPlace = locs.save(R.edx);
          if (edxPlace) {
            locs.move(R.edx, edxPlace);
            addInst("movl", [R.edx, edxPlace]);
          }
        }

        locs.invalidate(R.edx);

        if (locs.shouldISaveRegister(R.ebx)) {
          const mem = locs.allocateMemory();
          locs.move(R.ebx, mem);
          addInst("movl", [R.ebx, mem]);
        }
        locs.invalidate(R.ebx);

        if (locs.shouldISaveRegister(R.ecx)) {
          const mem = locs.allocateMemory();
          locs.move(R.ecx, mem);
          addInst("movl", [R.ecx, mem]);
        }
        locs.invalidate(R.ecx);

        if (locs.shouldISaveRegister(R.esi)) {
          const mem = locs.allocateMemory();
          locs.move(R.esi, mem);
          addInst("movl", [R.esi, mem]);
        }
        locs.invalidate(R.esi);

        if (locs.shouldISaveRegister(R.edi)) {
          const mem = locs.allocateMemory();
          locs.move(R.edi, mem);
          addInst("movl", [R.edi, mem]);
        }
        locs.invalidate(R.edi);

        code.push(e);

        if (args.length > 0) {
          addInst("addl", [$l(args.length * VALUE_SIZE), R.esp]);
        }

        locs.unlock(R.ebx);
        locs.unlock(R.ecx);
        locs.unlock(R.esi);
        locs.unlock(R.edi);

        locs.unlock(R.eax);
        locs.unlock(R.edx);

        locs.set(R.eax, v);
      },
      mov: (e) => {
        if (e.meta) {
          addInst(e.name, e.args);
          return;
        }
        if (e.args[0].type === "LiteralArg") {
          v.contains = e.args[0].value;
          if ((v.contains & ~0x0f) === 0) {
            v.incites.push("zero_padded");
          }
          return;
        }
        if (e.args[0].type === "LiteralStringArg") {
          const a = locs.allocateRegister() ?? locs.allocateNotLockedRegister();
          const place = locs.save(a as RegisterArg);
          if (place) {
            locs.move(a, place);
            addInst("movl", [a, place]);
          }
          locs.move(e.args[0], a, v);
          addInst("movl", [e.args[0], a]);
          return;
        }
        if (e.args[0].type === "ImmArg") {
          let l = locs.getLocation(vals[0]);
          if (l.type !== "RegisterArg") {
            const a =
              locs.allocateRegister() ?? locs.allocateNotLockedRegister();
            const place = locs.save(a as RegisterArg);
            if (place) {
              locs.move(a, place);
              addInst("movl", [a, place]);
            }
            locs.move(l, a);
            addInst("movl", [l, a]);
            l = a;
          }
          const r = locs.allocate();
          const insts = locs.doMove(
            {
              type: "ImmArg",
              offset: e.args[0].offset,
              base: l as RegisterArg,
            },
            r,
            v,
          );
          code.push(...insts);
          // locs.set(r, v);
          return;
        }
        if (e.args[0].type === "MemoryArg") {
          locs.set(e.args[0], v);
          return;
        }
        if (e.args[1].type === "MemoryArg") {
          const u = locs.getValue(e.args[1]);
          if (u && locs.isUseFull(u)) {
            const v = locs.allocate();
            doMove(e.args[1], v);
            locs.invalidate(e.args[1]);
          }
          const va = locs.getLocation(vals[0]);
          doMove(va, e.args[1], vals[0]);
          locs.used(vals[0]);
          return;
        }
        if (e.args[1].type === "StackArg") {
          const va = locs.getLocation(vals[0]);
          const u = locs.getValue(e.args[1]);
          if (u?.value === vals[0].value) {
            locs.used(vals[0]);
            return;
          }
          if (argEq(va, e.args[1])) {
            locs.used(vals[0]);
            return;
          }
          if (u && locs.isUseFull(u) && !locs.hasOthers(u)) {
            const v = locs.allocate();
            doMove(e.args[1], v);
            locs.invalidate(e.args[1]);
          }
          doMove(va, e.args[1], vals[0]);
          locs.used(vals[0]);
          return;
        }
        if (e.args[1].type === "ImmArg") {
          let va = locs.getLocation(vals[0]);
          if (va.type !== "RegisterArg") {
            const reg =
              locs.allocateRegister() ?? locs.allocateNotLockedRegister();
            const place = locs.save(reg as RegisterArg);
            if (place) {
              locs.move(reg, place);
              addInst("movl", [reg, place]);
            }
            locs.move(va, reg, vals[0]);
            addInst("movl", [va, reg]);
            va = reg;
          }
          let vb = locs.getLocation(vals[1]);
          if (vb.type !== "RegisterArg") {
            const reg =
              locs.allocateRegister() ?? locs.allocateNotLockedRegister();
            const place = locs.save(reg as RegisterArg);
            if (place) {
              locs.move(reg, place);
              addInst("movl", [reg, place]);
            }
            locs.move(vb, reg, vals[1]);
            addInst("movl", [vb, reg]);
            vb = reg;
          }
          addInst("movl", [va, $i(vb as RegisterArg, e.args[1].offset)]);
        }
      },
      cmp: (e) => {
        if (vals[0].contains !== null && vals[1].contains !== null) {
          const ca = vals[0].contains;
          const cb = vals[1].contains;

          locs.used(vals[0]);
          locs.used(vals[1]);

          cmpAnswerIncite = [cb, ca];

          return;
        }

        if (vals[0].value === vals[1].value) {
          locs.used(vals[0]);
          locs.used(vals[1]);

          cmpAnswerIncite = [0, 0];
          return;
        }

        const inst = selector.match(e, vals, vs, locs);
        code.push(...inst);
      },
      set: (e) => {
        if (cmpAnswerIncite !== null) {
          const [ca, cb] = cmpAnswerIncite;

          let x: boolean;
          const op = e.name.substring(3);
          if (op === "e") {
            x = ca === cb;
          } else if (op === "ne") {
            x = ca !== cb;
          } else if (op === "l") {
            x = ca < cb;
          } else if (op === "g") {
            x = ca > cb;
          } else if (op === "le") {
            x = ca <= cb;
          } else if (op === "ge") {
            x = ca >= cb;
          } else if (op === "z") {
            x = ca === cb;
          } else if (op === "nz") {
            x = ca !== cb;
          } else {
            throw new Error("Why?");
          }

          vs.at(-1)!.contains = x ? 1 : 0;
          vs.at(-1)!.incites.push("zero_padded");

          cmpAnswerIncite = null;
          return;
        }

        if (vs.length === 2 && v.contains !== null) {
          const ca = 0;
          const cb = v.contains;

          let x: boolean;
          const op = e.name.substring(3);
          if (op === "e") {
            x = ca === cb;
          } else if (op === "ne") {
            x = ca !== cb;
          } else if (op === "l") {
            x = ca < cb;
          } else if (op === "g") {
            x = ca > cb;
          } else if (op === "le") {
            x = ca <= cb;
          } else if (op === "ge") {
            x = ca >= cb;
          } else {
            throw new Error("Why?");
          }

          const last = vs.at(-1)!;
          last.contains = x ? 1 : 0;
          return;
        }

        const dx =
          locs.allocateBasicRegister() ?? locs.allocateNotLockedRegister();
        locs.lock(dx);

        const place = locs.save(dx as RegisterArg);
        if (place) {
          doMove(dx, place);
        }

        const dest = low(dx as RegisterArg);
        addInst(e.name, [dest]);
        const rt = locs.getValue(dx);
        if (!rt?.incites.includes("zero_padded")) {
          addInst("movzbl", [dest, dx]);
        }

        vs.at(-1)!.incites.push("zero_padded");
        locs.set(dx, vs.at(-1)!);
        locs.unlock(dx);
      },

      add: select((a, b) => a + b),
      sub: (e) => {
        if (vals[0].value === vals[1].value) {
          v.contains = 0;
          return;
        }
        select((a, b) => b - a)(e);
      },
      imul: select((a, b) => a * b),
      or: select((a, b) => a | b),
      and: select((a, b) => a & b),

      cltd: (e) => {
        const p1 = locs.save(R.eax);
        if (p1) {
          locs.move(R.eax, p1);
          addInst("movl", [R.eax, p1]);
        }
        locs.invalidate(R.eax);
        locs.lock(R.eax);

        const p2 = locs.save(R.edx);
        if (p2) {
          locs.move(R.edx, p2);
          addInst("movl", [R.edx, p2]);
        }
        locs.invalidate(R.edx);
        locs.lock(R.edx);

        const l = locs.getLocation(vals[0]);
        if (l.type !== "RegisterArg" || l.value !== R.eax.value) {
          locs.move(l, R.eax, vals[0]);
          addInst("movl", [l, R.eax]);
        }

        locs.used(vals[0]);

        if (locs.isUseFull(vals[0]) && !locs.hasOthers(vals[0])) {
          const b = locs.allocate();
          locs.move(R.eax, b);
          addInst("movl", [R.eax, b]);
        }

        addInst(e.name, []);

        locs.set(R.eax, vs[0]);
        locs.set(R.edx, vs[1]);
      },

      idiv: (e) => {
        let l = locs.getLocation(vals[0]);

        const v0 = locs.getLocation(vals[1]);
        const v1 = locs.getLocation(vals[2]);

        if (!argEq(v0, R.eax)) {
          throw new Error("PANIC!");
        }

        if (!argEq(v1, R.edx)) {
          throw new Error("PANIC!");
        }

        if (l.type === "LiteralArg") {
          const reg =
            locs.allocateRegister() ?? locs.allocateNotLockedRegister();
          const place = locs.save(reg as RegisterArg);
          if (place) {
            locs.move(reg, place);
            addInst("movl", [reg, place]);
          }
          locs.move(l, reg, vals[0]);
          addInst("movl", [l, reg]);
          l = reg;
        }

        addInst(e.name, [l]);

        locs.used(vals[1]);
        locs.used(vals[2]);

        locs.set(R.eax, vs[0]);
        locs.set(R.edx, vs[1]);

        locs.unlock(R.eax);
        locs.unlock(R.edx);
      },

      xor: (e) => {
        const [f, dist] = e.args;
        if (v.value === me.getEnd().value.value) {
          const xl = locs.getLocation(vals[1]);
          addInst(e.name, [$l(0), xl]);
          return;
        }
        if (
          dist.type === "RegisterArg" &&
          f.type === "RegisterArg" &&
          dist.value === f.value
        ) {
          v.contains = 0;
          v.incites.push("zero_padded");
          const xl = locs.getValue(dist);
          if (xl) {
            if (xl.contains === v.contains) {
              locs.used(xl);
              locs.set(e.args[1], v);
              return;
            }
          }
          const place = locs.save(dist);
          if (place) {
            doMove(dist, place);
          }
          addInst("xorl", e.args.map(downGradeRegisterTo32));
          locs.set(e.args[1], v);
        } else {
          select((a, b) => a ^ b)(e);
        }
      },
      nop: () => locs.used(vals[0]),

      sar: select((x) => x >> 1),
      sal: select((x) => x << 1),
      dec: select((x) => x - 1),

      lea: (e) => {
        const reg = locs.allocateRegister() ?? locs.allocateNotLockedRegister();
        const place = locs.save(reg as RegisterArg);
        if (place) {
          locs.move(reg, place);
          addInst("movl", [reg, place]);
        }
        addInst(e.name, [e.args[0], reg]);
        locs.set(reg, v);
      },
      ret: () => {
        const x = locs.tryGetLocation(vals[0]);
        locs.used(vals[0]);
        if (x) {
          if (x.type === "RegisterArg" && x.value === R.eax.value) {
            return;
          }
          doMove(x, R.eax, vals[0]);
        } else {
          code.push($do("movl", $r("ebx"), $r("eax")));
        }
      },
      jmp: (e) => {
        if (
          e.args.length === 2 &&
          e.args[1].type === "MetaArg" &&
          e.args[1].content === "#TAILREC"
        ) {
          e.args.pop();
          if (
            e.args[0].type === "MemoryArg" &&
            e.args[0].location.startsWith("*")
          ) {
            code.push($do("tailrec_clojure"));
            return;
          } else {
            code.push($do("tailrec"));
          }
        }
        code.push(e);
      },
      j: (e) => {
        if (cmpAnswerIncite !== null) {
          const [ca, cb] = cmpAnswerIncite;

          let x: boolean;
          const op = e.name.substring(1);
          if (op === "e") {
            x = ca === cb;
          } else if (op === "ne") {
            x = ca !== cb;
          } else if (op === "l") {
            x = ca < cb;
          } else if (op === "g") {
            x = ca > cb;
          } else if (op === "le") {
            x = ca <= cb;
          } else if (op === "ge") {
            x = ca >= cb;
          } else if (op === "z") {
            x = ca === cb;
          } else if (op === "nz") {
            x = ca !== cb;
          } else {
            throw new Error("Why?");
          }

          if (x) {
            addInst("jmp", e.args);
          }

          cmpAnswerIncite = null;
          return;
        }
        code.push(e);
      },
      sync: () => {
        const snap = me.getFinalSnapshot();
        if (snap) {
          const info = StateWatcher.inspectSnapshot(snap, (x) =>
            me.findValue(x),
          );
          const count = new Map<number, number>();
          // eslint-disable-next-line no-inner-declarations
          function dec(v: Value) {
            if (count.has(v.value)) {
              let rec = count.get(v.value)!;
              rec -= 1;
              if (rec <= 0) {
                count.delete(v.value);
                locs.forgetValue(v);
              } else {
                count.set(v.value, rec);
              }
            }
          }
          for (const [, v] of info) {
            if (count.has(v.value)) {
              const rec = count.get(v.value)!;
              count.set(v.value, rec + 1);
            } else {
              count.set(v.value, 1);
            }
          }

          const round2: [Arg, Value][] = [];

          for (const [b, v] of info) {
            const u = locs.getValue(b);
            if (u?.value === v.value) {
              locs.lock(b);
              dec(v);
              continue;
            }
            round2.push([b, v]);
          }

          for (const round of [round2]) {
            for (const [b, v] of round) {
              const u = locs.getValue(b);
              if (u?.value === v.value) {
                locs.lock(b);
                dec(v);
                continue;
              }

              const a = locs.getLocation(v);
              if (argEq(a, b)) {
                locs.lock(b);
                dec(v);
                continue;
              }

              locs.lock(b);
              locs.lock(a);

              let place: Arg | null = null;

              if (!locs.canISaveUse3(b)) {
                place = locs.allocate();
                doMove(b, place);
              }

              locs.unlock(a);
              doMove(a, b, v);
              dec(v);
            }
          }
        }
      },
    });

    go(n.original);
  }

  try {
    const startSnap = me.getStartSnapshot();
    const loc = startSnap
      ? StateWatcher.fromSnapshot(me.getLocalSize(), startSnap, (x) =>
          me.findValue(x),
        )
      : new StateWatcher(me.getLocalSize());

    me.newMetaInstruction([
      {
        name: "sync",
        args: [],
        justLabel: false,
        meta: false,
      },
    ]);

    me.newMetaInstruction(me.getEpilog());

    for (const [vs, len] of me.getMarkedRoots()) {
      loc.shouldUse(vs, len);
    }

    goNode(me.getEnd(), loc);
    const [stackSize, usedRegs] = loc.getInfo();

    // epiloge
    return [code.expose(), usedRegs, stackSize, me.getIsClojure()];
  } catch (ex) {
    console.error(code.expose().slice(-30).map(showInstDebug).join("\n"));
    throw ex;
  }
}
