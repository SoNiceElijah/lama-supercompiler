import { run } from "../common/visitor";
import { ProcedureDesc } from "../common/types";
import { Arg, Instruction, argEq } from "../common/asm";
import { StateCounter } from "./stateCounter";
import { Graph, RelationNode, ProgramGraph } from "../common/graph";
import { $m, $r, $s, R } from "../common/utils";

/////////////////////////////////////////////////////////////////////////////

const noStaticMemoryEffects = [
  "Lwrite",
  "Lread",
  "__gc_init",
  "set_args",
  "Llength",
  "Bstring",
  "Belem",
  "Bsta",
  "Barray",
  "Bsexp",
  "Btag",
  "Bclosure",
];

function scanLabels(xs: Instruction[]): string[] {
  const labs: string[] = [];
  let attainable: boolean = false;

  const visitedLabels: string[] = [];
  const pendingLabels: string[] = [];

  const go = run({
    jmp: (x) => {
      const [arg] = x.args;
      if (arg.type === "MemoryArg") {
        if (visitedLabels.includes(arg.location)) {
          labs.push(arg.location);
        } else {
          pendingLabels.push(arg.location);
        }
      }
      attainable = false;
    },
    j: (x) => {
      const [arg] = x.args;
      if (arg.type === "MemoryArg") {
        if (visitedLabels.includes(arg.location)) {
          labs.push(arg.location);
        } else {
          pendingLabels.push(arg.location);
        }
      }
    },
    other: (x) => {
      if (x.label !== undefined) {
        if (pendingLabels.includes(x.label) && attainable) {
          labs.push(x.label);
        }
        visitedLabels.push(x.label);
      }
      attainable = true;
    },
  });

  go(xs);

  return labs;
}

function findAccess(xs: Instruction[]): boolean {
  for (const x of xs) {
    for (const arg of x.args) {
      if (arg.type === "ImmArg" && argEq(arg.base, R.edx)) {
        return true;
      }
    }
  }
  return false;
}

export function build(desc: ProcedureDesc): ProgramGraph {
  const xs = desc.code;
  const localSize = desc.localSize;

  let reachable = false;

  const aliases = new Map<number, string>();

  const graphs: Graph[] = [];
  const locs = new StateCounter();
  let graph = new Graph();
  locs.inc(() => graph.newValue());

  graph.setStartSnapshot(locs.snapshot());
  graph.setLocalSize(localSize);

  graphs.push(graph);

  const rel = new ProgramGraph(desc);
  let currentRel = rel.add(graph);

  const graphStorage = new Map<string, RelationNode>();
  graphStorage.set("@", currentRel);
  const pendingJumps = new Map<string, RelationNode[]>();

  function newGraph() {
    if (graphs.at(-1)?.isEmpty()) {
      graphs.pop();
    }

    graph = new Graph();
    graph.setLocalSize(localSize);

    currentRel = rel.add(graph);
    graphs.push(graph);
  }

  const binop = (x: Instruction) => {
    const [f, t] = x.args;
    if (locs.technicOp(x, () => graph.newValue())) {
      return;
    }
    let m;
    if (f.type === "LiteralArg") {
      m = graph.createWith([
        {
          name: "movl",
          args: [f, R.eax],
          meta: false,
          justLabel: false,
        },
      ]);
    } else {
      m = locs.get(f);
    }
    const k = locs.get(t);
    const [[n], inst] = graph.produceWithInstruction([x], [m, k], 1);
    locs.put(t, n);
    locs.affectsFlags(inst, [m, k]);
  };

  const code: Instruction[] = xs;
  const snapshots: Record<string, Record<string, number>> = {};

  const labs = scanLabels(code);
  const preserveEdx = findAccess(code);

  if (preserveEdx) {
    locs.preserveEdx();
  }

  const prologue = ["pushl", "movl", "subl"];

  const go = run({
    call: (x) => {
      const [arg] = x.args;
      const e =
        arg.type === "MetaArg"
          ? arg.content
          : arg.type === "MemoryArg"
            ? arg.location
            : "";

      if (!noStaticMemoryEffects.includes(e)) {
        locs.incMem(() => graph.newValue());
        graph.addSnapshot(locs.memSnapshot());
        x.args.push({
          type: "MetaArg",
          content: "#SNAP",
        });
      }

      const n = graph.newValue();
      locs.prepareCall(x, n);
      locs.put(R.eax, n);

      graph.connectToEnd(
        [
          {
            name: "nop",
            args: [],
            meta: false,
            justLabel: false,
          },
        ],
        n,
      );

      return;
    },
    push: (x) => {
      const [arg] = x.args;
      if (arg.type === "LiteralArg" || arg.type === "LiteralStringArg") {
        locs.push(
          x.args[0],
          graph.createWith([
            {
              name: "movl",
              args: [arg, R.eax],
              justLabel: false,
              meta: false,
            },
          ]),
        );
      } else if (arg.type === "ImmArg") {
        const n = locs.get(arg.base);
        const v = graph.newValue();
        graph.newInstruction(
          [
            {
              name: "movl",
              args: [arg, R.eax],
              justLabel: false,
              meta: false,
            },
          ],
          [n],
          [v],
        );
        locs.push(x.args[0], v);
      } else {
        locs.push(x.args[0]);
      }
    },
    pop: (x) => {
      locs.pop(x.args[0]);
    },
    mov: (x) => {
      locs.checkSymbolicStack(x, localSize);
      const [f, t] = x.args;
      if (f.type === "LiteralArg") {
        const n = graph.createWith([x]);
        locs.put(t, n);
        return;
      }
      if (f.type === "LiteralStringArg") {
        const n = graph.createWith([x]);
        locs.put(t, n);
        return;
      }
      if (f.type === "ImmArg") {
        const v = locs.get(f.base);
        const n = graph.newValue();
        graph.newInstruction([x], [v], [n]);
        locs.put(t, n);
        return;
      }
      if (locs.technicOp(x, () => graph.newValue())) {
        return;
      }
      const n = locs.get(f, () => graph.createWith([x]));
      if (t.type !== "ImmArg") {
        locs.propagate(f, t);
      }
      if (t.type === "ImmArg") {
        const v = locs.get(t.base);
        if (aliases.has(v)) {
          const s = aliases.get(v)!;
          let arg: Arg = $r("");
          if (s.startsWith("MEM:")) {
            arg = $m(s.substring(4));
          }
          if (s.startsWith("STACK:")) {
            arg = $s(parseInt(s.substring(6)));
          }
          locs.put(arg, n);
          x.args[1] = arg;
          graph.connectToEnd([x], n);
        } else {
          graph.connectToEnd([x], [n, v]);
        }
      } else if (t.type === "MemoryArg") {
        graph.connectToEnd([x], n);
      } else if (t.type === "StackArg") {
        if (locs.isLocalVar(localSize, t.position)) {
          graph.connectToEnd([x], n);
        } else {
          graph.newInstruction([x], [n], [n]);
        }
      } else {
        graph.newInstruction([x], [n], [n]);
      }
    },

    add: binop,
    sub: binop,
    imul: binop,
    or: binop,
    and: binop,

    xor: (x) => {
      const [f, t] = x.args;
      if (
        t.type === "RegisterArg" &&
        f.type === "RegisterArg" &&
        f.value === t.value
      ) {
        const n = graph.createWith([x]);
        locs.put(f, n);
        return;
      }
      if (f.type === "LiteralArg" && f.value === 0) {
        const args: number[] = [];
        for (const e of x.args) {
          if (e.type !== "LiteralArg") {
            args.push(locs.get(e));
          } else {
            const v = graph.createWith([
              {
                name: "movl",
                args: [e, R.eax],
                meta: false,
                justLabel: false,
              },
            ]);
            args.push(v);
          }
        }
        const inst = graph.newInstruction([x], args, []);
        locs.affectsFlags(inst, args);
        return;
      }
      binop(x);
    },
    sal: (x) => {
      const v = locs.get(x.args[0]);
      const [[u]] = graph.produceWithInstruction([x], [v], 1);
      locs.put(x.args[0], u);
    },
    sar: (x) => {
      const v = locs.get(x.args[0]);
      const [[u]] = graph.produceWithInstruction([x], [v], 1);
      locs.put(x.args[0], u);
    },
    dec: (x) => {
      const v = locs.get(x.args[0]);
      const [[u]] = graph.produceWithInstruction([x], [v], 1);
      locs.put(x.args[0], u);
    },
    cltd: (x) => {
      const e = locs.get(R.eax);
      const [[n, m]] = graph.produceWithInstruction([x], [e], 2);
      locs.put(R.eax, n);
      locs.put(R.edx, m);
    },
    idiv: (x) => {
      const a = locs.get(R.eax);
      const b = locs.get(R.edx);
      const c = locs.get(x.args[0]);

      const [[n, m]] = graph.produceWithInstruction([x], [c, a, b], 2);
      locs.put(R.eax, n);
      locs.put(R.edx, m);
    },
    cmp: (x) => {
      const args: number[] = [];
      for (const e of x.args) {
        if (e.type !== "LiteralArg") {
          args.push(locs.get(e));
        } else {
          const v = graph.createWith([
            {
              name: "movl",
              args: [e, R.eax],
              meta: false,
              justLabel: false,
            },
          ]);
          args.push(v);
        }
      }
      const inst = graph.newInstruction([x], args, []);
      locs.affectsFlags(inst, args);
    },
    set: (x) => {
      const last = locs.getLastFlagAffecter();
      if (!last) {
        throw new Error("Why?");
      }
      const [a] = x.args;
      const n = graph.newValue();
      locs.put(a, n);

      last.original.original.push(x);
      graph.bindTo(last.original, [n]);
    },
    ret: (x) => {
      const n = locs.get(R.eax);
      graph.connectToEnd([x], n);
    },
    jmp: (x) => {
      const [arg] = x.args;
      if (arg.type !== "MemoryArg") {
        throw new Error("Why 2?");
      }
      if (graphStorage.has(arg.location)) {
        const j = graphStorage.get(arg.location)!;
        rel.link(currentRel).to(j);
      }
      if (!pendingJumps.has(arg.location)) {
        pendingJumps.set(arg.location, []);
      }
      pendingJumps.get(arg.location)?.push(currentRel);
      snapshots[arg.location] = locs.snapshot();
      graph.setFinalSnapshot(snapshots[arg.location]);
      graph.addEpilog([x]);
      newGraph();
      locs.inc(() => graph.newValue());

      graph.setStartSnapshot(locs.snapshot());
    },
    lea: (x) => {
      const [f, t] = x.args;
      if (f.type === "MemoryArg") {
        const v = graph.createWith([x]);
        locs.put(t, v);
        aliases.set(v, `MEM:${f.location}`);
        return;
      }
      if (f.type === "StackArg") {
        const v = graph.createWith([x]);
        locs.put(t, v);
        aliases.set(v, `STACK:${f.position}`);
        return;
      }
      const a = locs.get(f);
      const [[v]] = graph.produceWithInstruction([x], [a], 1);
      locs.put(t, v);
    },
    j: (x) => {
      const last = locs.getLastFlagAffecter();
      if (!last) {
        throw new Error("Why?");
      }
      const [arg] = x.args;
      if (arg.type !== "MemoryArg") {
        throw new Error("Why 2?");
      }
      if (graphStorage.has(arg.location)) {
        const j = graphStorage.get(arg.location)!;
        rel.link(currentRel).to(j);
      }
      if (!pendingJumps.has(arg.location)) {
        pendingJumps.set(arg.location, []);
      }
      pendingJumps.get(arg.location)?.push(currentRel);
      const old = currentRel;
      snapshots[arg.location] = locs.snapshot();
      graph.finalBindToEnd(last.original);
      graph.setFinalSnapshot(snapshots[arg.location]);
      graph.addEpilog([x]);
      newGraph();
      locs.inc(() => graph.newValue());
      graph.setStartSnapshot(locs.snapshot());
      rel.link(old).to(currentRel);
    },
    other: (i) => {
      if (i.label !== undefined) {
        graph.setLabel(i.label);
        const old = currentRel;
        if (labs.includes(i.label)) {
          graph.setFinalSnapshot(locs.snapshot());
          newGraph();
          locs.inc(() => graph.newValue());
          graph.setStartSnapshot(locs.snapshot());
          if (reachable) {
            rel.link(old).to(currentRel);
          }
        }
        if (!reachable && i.label in snapshots) {
          locs.load(snapshots[i.label]);
          locs.inc(() => graph.newValue());
          graph.setStartSnapshot(locs.snapshot());
        }
        if (pendingJumps.has(i.label)) {
          const js = pendingJumps.get(i.label)!;
          for (const j of js) {
            rel.link(j).to(currentRel);
          }
        }
        graph.setLabel(i.label);
        graphStorage.set(i.label, currentRel);
      }

      if (!prologue.length) {
        graph.newMetaInstruction([i]);
      }
    },
    each: (x) => {
      if (prologue.length) {
        if (
          x.name === "pushl" &&
          x.args[0].type === "RegisterArg" &&
          x.args[0].value === "edx"
        ) {
          graph.setClojure();
        }
        if (prologue[0] === x.name) {
          prologue.shift();
        }
        if (prologue.length === 0) {
          locs.frozeFrame();
          graph.setStartSnapshot(locs.snapshot());
        }
      }

      const call = locs.pollCall();
      if (call) {
        const [x, args, to] = call;
        graph.newInstruction([x], args, [to]);
      }

      if (x.name === "" || x.justLabel) {
        return;
      }

      reachable = x.name !== "jmp" && x.name !== "ret";
    },
  });

  go(code);
  return rel;
}
