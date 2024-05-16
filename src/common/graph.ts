import { Instruction, argEq, instEqWeakArr, showInstDebug } from "./asm";
import { PatternWatcher } from "./patternWatcher";
import {
  InstructionNode,
  ProcedureDesc,
  Snapshot,
  Value,
  ValueNode,
} from "./types";
import { $__m, $fst, $l, arrEq } from "./utils";
import { run } from "./visitor";

function runFstInst(
  n: ValueNode,
  f: (x: Instruction, s: InstructionNode) => void,
) {
  if (n.stream.length) {
    const [s] = n.stream;
    if (s.original.length) {
      const [i] = s.original;
      f(i, s);
    }
  }
}

export class Graph {
  private static instId = 0;
  private static nodeId = 0;
  private static endId = 1_000_000;

  private labels: string[] = [];

  private scope: number = 0;
  private roots: ValueNode[] = [];
  private end: ValueNode = {
    id: Graph.endId++,
    value: {
      type: "Variable",
      value: Graph.endId,
      contains: null,
      incites: [],
    },
    stream: [],
    marked: false,
    createdBy: [],
    upSize: 0,
  };

  private startSnapshot?: Snapshot;
  private snapshots: Snapshot[] = [];
  private finalSnapshot?: Snapshot;
  private epilog: Instruction[] = [];

  private smellsLikeClojure = false;

  private masks: Set<string>[] = [];

  private finals: [InstructionNode, ValueNode[]][] = [];

  private localSize: number = 0;

  private find(x: number): ValueNode {
    const v = this.roots.find((e) => e.id === x);
    if (!v) {
      console.error(x);
      throw new Error("HEH!");
    }
    return v;
  }

  private findAll(...xs: (number[] | number)[]): ValueNode[] {
    const numbers: number[] = [];
    for (const x of xs) {
      if (typeof x === "number") {
        numbers.push(x);
      } else {
        numbers.push(...x);
      }
    }
    return numbers.map((e) => this.find(e));
  }

  private newValueNode(): ValueNode {
    const id = Graph.nodeId++;
    const node: ValueNode = {
      id,
      value: { type: "Variable", value: id, contains: null, incites: [] },
      stream: [],
      marked: false,
      createdBy: [],
      upSize: 0,
    };
    this.roots.push(node);
    return node;
  }

  isEmpty() {
    return this.end.createdBy.length === 0 && this.roots.length === 0;
  }

  setClojure() {
    this.smellsLikeClojure = true;
  }

  setLabel(lab: string) {
    this.labels.push(lab);
  }

  getEnd() {
    return this.end;
  }

  getMarkedRoots() {
    return this.roots
      .filter((e) => e.marked)
      .map((e) => [e.value, e.stream.length] as const);
  }

  getIsClojure() {
    return this.smellsLikeClojure;
  }

  getEpilog() {
    return this.epilog;
  }

  getLocalSize() {
    return this.localSize;
  }

  getFinalSnapshot() {
    return this.finalSnapshot;
  }

  getStartSnapshot() {
    return this.startSnapshot;
  }

  setLocalSize(size: number) {
    this.localSize = size;
  }

  getLabels() {
    return this.labels;
  }

  addEpilog(xs: Instruction[]) {
    this.epilog.push(...xs);
  }

  setStartSnapshot(snap: Snapshot) {
    this.startSnapshot = snap;
  }

  addSnapshot(snap: Snapshot) {
    this.snapshots.push(snap);
  }

  pollSnapshot() {
    const snap = this.snapshots.shift();
    if (!snap) {
      throw new Error("ZERO SNAPS");
    }
    return snap;
  }

  setFinalSnapshot(snap: Snapshot) {
    this.finalSnapshot = snap;
  }

  addFinalMask(mask: Set<string>) {
    this.masks.push(mask);
  }

  findInputMask(): Set<string> {
    const [rs] = this.findRoots();
    const mask = new Set<string>();
    for (const r of rs) {
      const keys = Object.entries(this.startSnapshot!)
        .filter(([, v]) => v === r.value.value)
        .map((e) => e[0]);

      for (const k of keys) {
        mask.add(k);
      }
    }

    return mask;
  }

  exploreMask() {
    const snap = Object.values(this.useMasks());
    const [rs] = this.findRoots();
    const mask = new Set<string>();
    for (const r of rs) {
      const keys = Object.entries(this.startSnapshot!)
        .filter(([, v]) => v === r.value.value || snap.includes(v))
        .map((e) => e[0]);

      for (const k of keys) {
        mask.add(k);
      }
    }

    return mask;
  }

  private cutOuter(x: Snapshot): Set<string> {
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

  cutOuterFinalSnapshot() {
    if (this.finalSnapshot) {
      const mask = this.cutOuter(this.finalSnapshot);
      this.masks.push(mask);
    }
    return this;
  }

  getMasks() {
    const sup = new Set<string>();
    for (const m of this.masks) {
      for (const e of m) {
        sup.add(e);
      }
    }
    return sup;
  }

  private useMasks(): Snapshot {
    if (!this.finalSnapshot) {
      return {};
    }

    const snap: Snapshot = {};

    if (this.masks.length) {
      for (const key in this.finalSnapshot) {
        for (const set of this.masks) {
          if (set.has(key)) {
            snap[key] = this.finalSnapshot[key];
          }
        }
      }
    }

    return snap;
  }

  frozeFinalSnapshot(force = false) {
    if (this.finalSnapshot) {
      const snap = force ? this.finalSnapshot : this.useMasks();

      for (const [key, val] of Object.entries(snap)) {
        if (key.startsWith("ignore_")) {
          continue;
        }
        this.connectToEnd(
          [
            {
              name: "nop",
              args: [$__m("final")],
              meta: false,
              justLabel: false,
            },
          ],
          val,
        );
      }

      this.finalSnapshot = snap;

      for (const [i, nodes] of this.finals) {
        for (const n of nodes) {
          n.createdBy.push(i);
        }

        i.down.push(...nodes);
      }
    }
    return this;
  }

  bindTo(i: InstructionNode, vs: number[]) {
    const nodes = this.findAll(vs);
    for (const n of nodes) {
      n.createdBy.push(i);
    }

    i.down.push(...nodes);
  }

  bindToEnd(i: InstructionNode) {
    this.end.createdBy.push(i);
    i.down.push(this.end);
  }

  finalBindToEnd(i: InstructionNode) {
    this.finals.push([i, [this.end]]);
  }

  newValue(): number {
    return this.newValueNode().id;
  }

  findValue(x: number) {
    return this.roots.find((e) => e.value.value === x)?.value;
  }

  produceWithInstruction(
    original: Instruction[],
    ts: number[],
    len: number,
  ): [number[], InstructionNode] {
    const frs = this.findAll(ts);
    for (const f of frs) {
      for (const s of f.stream) {
        if (
          instEqWeakArr(s.original, original) &&
          arrEq(frs, s.up) &&
          s.down.length === len
        ) {
          return [s.down.map((e) => e.value.value), s];
        }
      }
    }

    const res: number[] = [];
    for (let i = 0; i < len; ++i) {
      res.push(this.newValue());
    }

    return [res, this.newInstruction(original, ts, res)];
  }

  newInstruction(
    original: Instruction[],
    ts: number[],
    qs: number[],
  ): InstructionNode {
    const frs = this.findAll(ts);
    const tos = this.findAll(qs);

    const id = Graph.instId++;
    const inst: InstructionNode = {
      id,
      original,
      up: frs,
      down: tos,
      useful: false,
      scope: this.scope,
    };

    for (const t of tos) {
      t.createdBy.push(inst);
    }

    for (const f of frs) {
      f.stream.push(inst);
    }

    return inst;
  }

  createWith(original: Instruction[]): number {
    const node = this.newValueNode();
    const id = Graph.instId++;
    const inst: InstructionNode = {
      id,
      original,
      up: [],
      down: [node],
      useful: false,
      scope: this.scope,
    };
    node.createdBy.push(inst);
    return node.id;
  }

  newMetaInstruction(original: Instruction[]) {
    this.end.createdBy.push({
      useful: true,
      id: Graph.instId++,
      original,
      down: [this.end],
      up: [],
      scope: this.scope,
    });
  }

  connectToEnd(original: Instruction[], x: number | number[]) {
    const y = Array.isArray(x) ? x : [x];
    const e = this.findAll(y);

    const id = Graph.instId++;
    const i: InstructionNode = {
      id,
      original,
      up: e,
      down: [this.end],
      useful: false,
      scope: this.scope,
    };

    for (const o of e) {
      o.stream.push(i);
    }
    this.end.createdBy.push(i);
  }

  //////////////////////////////////////////////////////////////////
  // TRANSFORMATIONS

  findPureRoots(): Set<ValueNode> {
    const result = new Set<ValueNode>();
    const visited = new Set<ValueNode>();

    const queue = [this.end];

    while (queue.length) {
      const q = queue.shift()!;
      if (visited.has(q)) {
        continue;
      }
      visited.add(q);

      const back = new Set<ValueNode>();
      for (const s of q.createdBy) {
        const shouldSkip = $fst(s)((x) => {
          if (x.name === "nop" && x.args.length > 0) {
            const [f] = x.args;
            if (argEq(f, $__m("final"))) {
              return true;
            }
          }
          return false;
        });
        if (shouldSkip) {
          continue;
        }
        for (const u of s.up) {
          if (u === q) {
            continue;
          }
          back.add(u);
        }
      }

      if (back.size === 0) {
        result.add(q);
      }

      for (const s of back) {
        queue.push(s);
      }
    }

    return result;
  }

  private findRoots(): [Set<ValueNode>, Set<ValueNode>] {
    const result = new Set<ValueNode>();
    const visited = new Set<ValueNode>();

    const queue = [this.end];

    while (queue.length) {
      const q = queue.shift()!;
      if (visited.has(q)) {
        continue;
      }
      visited.add(q);

      const back = new Set<ValueNode>();
      for (const s of q.createdBy) {
        for (const u of s.up) {
          if (u === q) {
            continue;
          }
          back.add(u);
        }
      }

      if (back.size === 0) {
        result.add(q);
      }

      for (const s of back) {
        queue.push(s);
      }
    }

    return [result, visited];
  }

  shorten() {
    const [rs, vs] = this.findRoots();
    for (const n of this.roots) {
      if (rs.has(n)) {
        const newStream: InstructionNode[] = [];
        const newCreatedBy: InstructionNode[] = [];
        for (const s of n.stream) {
          const x = s.down.find((e) => e !== n);
          if (x) {
            newStream.push(s);
          }
        }
        for (const s of n.createdBy) {
          if (s.up.length === 0) {
            newCreatedBy.push(s);
            continue;
          }
          const x = s.up.find((e) => e !== n);
          if (x) {
            newCreatedBy.push(s);
          }
        }

        n.createdBy = newCreatedBy;
        n.stream = newStream;

        if (n.createdBy.length === 0) {
          n.marked = true;
        }
      } else if (vs.has(n)) {
        const newStream: InstructionNode[] = [];
        const newCreatedBy: InstructionNode[] = [];
        for (const s of n.stream) {
          const x = s.down.find((e) => e !== n);
          if (x) {
            newStream.push(s);
          }
        }
        for (const s of n.createdBy) {
          const y = s.up.find((e) => e !== n);
          if (y) {
            newCreatedBy.push(s);
          }
        }

        n.createdBy = newCreatedBy;
        n.stream = newStream;
      } else {
        runFstInst(n, (x) => {
          if (x.name === "call") {
            n.stream = [];
            this.connectToEnd([x], n.id);
          }
        });
      }
    }

    return this;
  }

  count() {
    const visited = new Set<ValueNode>();

    function walk(n: ValueNode): number {
      if (visited.has(n)) {
        return n.upSize;
      }
      visited.add(n);
      n.upSize = n.createdBy
        .flatMap((e) => e.up)
        .map(walk)
        .reduce((a, e) => a + e, 0);
      if (n.createdBy.flatMap((e) => e.up).length === 0) {
        n.upSize = 1;
      }

      return n.upSize;
    }

    walk(this.end);
    return this;
  }

  constantEval() {
    const visited = new Set<ValueNode | InstructionNode>();

    function goNode(x: ValueNode): Value {
      if (visited.has(x)) {
        return x.value;
      }
      visited.add(x);
      x.createdBy.forEach((e) =>
        goInst(
          e,
          e.down.map((x) => x.value),
        ),
      );

      return x.value;
    }

    function goInst(x: InstructionNode, vs: Value[]) {
      if (visited.has(x)) {
        return;
      }
      visited.add(x);
      const vals = x.up.map(goNode);

      function make(f: (...xs: number[]) => (number | null)[]) {
        return () => {
          const args: number[] = [];
          for (let i = 0; i < f.length; ++i) {
            const v = vals[i];
            if (v.contains === null) {
              return;
            }
            args.push(v.contains);
          }
          const res = f(...args);
          for (let i = 0; i < res.length; ++i) {
            const r = res[i];
            const v = vs[i];
            v.contains = r;
          }
        };
      }
      const go = run({
        other: () => {},
        add: make((a, b) => [a + b]),
        sub: make((a, b) => [b - a]),
        imul: () => {
          const [a, b] = vals;
          if (a.contains !== null && a.contains === 0) {
            vs[0].contains = 0;
            return;
          }
          if (b.contains !== null && b.contains === 0) {
            vs[0].contains = 0;
            return;
          }
          make((a, b) => [a * b])();
        },
        or: make((a, b) => [a | b]),
        and: make((a, b) => [a & b]),
        sal: make((a) => [a << 1]),
        sar: make((a) => [a >> 1]),
        dec: make((a) => [a - 1]),
        mov: (x) => {
          const [a] = x.args;
          if (a.type === "LiteralArg") {
            vs[0].contains = a.value;
          }
        },
        xor: (x) => {
          const [a, b] = x.args;
          if (argEq(a, b)) {
            vs[0].contains = 0;
            vs[0].incites.push("zero_padded");
          } else {
            make((a, b) => [a ^ b])();
          }
        },
      });

      go(x.original);
    }

    goNode(this.end);

    return this;
  }

  cutEvaluated() {
    const visited = new Set<ValueNode | InstructionNode>();

    function goNode(x: ValueNode) {
      if (visited.has(x)) {
        return x.value;
      }
      visited.add(x);

      if (x.value.contains !== null) {
        x.createdBy = [];
      }
      x.createdBy.forEach((e) => e.up.forEach(goNode));
    }

    goNode(this.end);
    return this;
  }

  cutPaths() {
    function choosePath(
      i: InstructionNode,
    ): [ValueNode, InstructionNode] | null {
      if (i.down.length !== 1) {
        return null;
      }
      const ups = i.up.filter((e) => e.value.contains === null);
      if (ups.length !== 1) {
        return null;
      }
      const [node] = ups;
      if (node.createdBy.length !== 1 || node.stream.length !== 1) {
        return null;
      }

      return [node, node.createdBy[0]];
    }

    const patterns = [
      PatternWatcher.create([
        ["sarl", [null]],
        ["orl", [$l(1), null]],
        ["sall", [null]],
      ]),
      PatternWatcher.create([
        ["decl", [null]],
        ["orl", [$l(1), null]],
      ]),
    ];

    const visited = new Set<ValueNode | InstructionNode>();
    function goNode(x: ValueNode) {
      if (visited.has(x)) {
        return;
      }
      visited.add(x);

      if (x.createdBy.length === 1) {
        for (const cutOne of patterns) {
          cutOne.restore();
          let currentNode = x;
          let currentInst = x.createdBy[0];
          while (!cutOne.isFinished()) {
            const next = choosePath(currentInst);
            if (!next) {
              break;
            }

            for (const i of currentInst.original) {
              cutOne.submit(i);
            }

            const [nextNode, nextInst] = next;
            currentNode = nextNode;
            currentInst = nextInst;
          }

          const pat = cutOne.getFulfilled();
          if (pat !== null) {
            const [a] = currentNode.createdBy;
            a.down.splice(a.down.indexOf(currentNode), 1, x);
            const [b] = x.createdBy;
            b.down.splice(b.down.indexOf(x), 1);
            x.createdBy = [a];
            currentNode.createdBy = [];
          }
        }
      }

      x.createdBy.forEach(goInst);
    }

    function goInst(x: InstructionNode) {
      if (visited.has(x)) {
        return;
      }
      visited.add(x);
      x.up.forEach(goNode);
    }

    goNode(this.end);
    return this;
  }

  //////////////////////////////////////////////////////////////////
  // PRINTS

  static printToTopMulti(gr: Graph[]) {
    let id = 0;
    let text = 'digraph {\n\tordering="in";\n';
    for (const g of gr) {
      text += g.printToTop(id);
      ++id;
    }
    text += "\n}";
    return text;
  }

  static printMulti(gr: Graph[]) {
    let id = 0;
    let text = 'digraph {\n\tordering="in";\n';
    for (const g of gr) {
      text += g.print(id);
      ++id;
    }
    text += "\n}";
    return text;
  }

  printToTop(id?: number): string {
    let text = "";
    if (id === undefined) {
      text += 'digraph {\n\tordering="in";\n\tsubgraph {\n\t\tlabel="Graph";\n';
    } else {
      text += `\tsubgraph cluster_${id} {\n\t\tlabel="Graph";\n`;
    }
    const visited = new Set<ValueNode | InstructionNode>();

    function goNode(n: ValueNode): number {
      if (visited.has(n)) {
        return n.id;
      }
      visited.add(n);

      const label =
        n.id >= 1_000_000 ? "[X]" : `value_${n.value.type}_${n.value.value}`;
      text += `\t\tv${n.id}[label="${label}`;
      if (n.value.contains !== null) {
        text += ` C=${n.value.contains}`;
      }
      text += '"];\n';

      for (const c of n.createdBy) {
        text += `\t\ti${c.id} -> v${n.id};\n`;
        goInst(c);
      }
      return n.id;
    }

    function goInst(n: InstructionNode) {
      if (visited.has(n)) {
        return;
      }

      visited.add(n);
      text += `\t\ti${n.id}[label="${n.original.map(showInstDebug).join("\\n")}"];\n`;

      for (const v of n.up) {
        text += `\t\tv${v.id} -> i${n.id};\n`;
        goNode(v);
      }
    }

    if (this.startSnapshot) {
      text += `\t\tbeg${id}[label="START SNAPSHOT"]\n`;
    }

    if (this.finalSnapshot) {
      text += `\t\tsnap${id}[label="FINAL SNAPSHOT"]\n`;
    }

    if (this.epilog.length) {
      text += `\t\te${id}[label="EPILOG\\n${this.epilog.map(showInstDebug).join("\\n")}"];\n`;
    }

    if (this.finalSnapshot && this.epilog.length) {
      text += `\t\tsnap${id} -> e${id};\n`;
    }

    goNode(this.end);
    text += "\t}";
    if (id === undefined) {
      text += "\n}";
    }

    if (id === undefined) {
      console.log(text);
    }
    return text;
  }

  ///

  print(id?: number): string {
    const visited = new Set<ValueNode | InstructionNode>();

    let text = "";
    if (id === undefined) {
      text += 'digraph {\n\tordering="in";\n\tsubgraph {\n\t\tlabel="Graph";\n';
    } else {
      text += `\tsubgraph cluster_${id} {\n\t\tlabel="Graph";\n`;
    }
    const queue: (ValueNode | InstructionNode)[] = [...this.roots];

    while (queue.length) {
      const q = queue.shift()!;
      if (visited.has(q)) {
        continue;
      }
      visited.add(q);

      if ("value" in q) {
        const label =
          q.id >= 1_000_000 ? "[X]" : `value_${q.value.type}_${q.value.value}`;
        text += `\t\tv${q.id}[label="${label}"];\n`;
        let i = 0;
        for (const s of q.createdBy) {
          queue.push(s);
          ++i;
        }
        for (const s of q.stream) {
          text += `\t\tv${q.id} -> i${s.id}[label="${i}"];\n`;
          queue.push(s);
          ++i;
        }
      }
      if ("up" in q) {
        text += `\t\ti${q.id}[label="${q.original.map(showInstDebug).join("\\n")}"];\n`;
        for (const v of q.down) {
          text += `\t\ti${q.id} -> v${v.id};\n`;
          queue.push(v);
        }
        for (const v of q.up) {
          queue.push(v);
        }
      }
    }

    if (this.startSnapshot) {
      text += `\t\tbeg${id}[label="START SNAPSHOT"]\n`;
    }

    if (this.finalSnapshot) {
      text += `\t\tsnap${id}[label="FINAL SNAPSHOT"]\n`;
    }

    if (this.epilog.length) {
      text += `\t\te${id}[label="EPILOG\\n${this.epilog.map(showInstDebug).join("\\n")}"];\n`;
    }

    if (this.finalSnapshot && this.epilog.length) {
      text += `\t\tsnap${id} -> e${id};\n`;
    }

    text += "\t}";
    if (id === undefined) {
      text += "\n}";
    }
    if (id === undefined) {
      console.log(text);
    }

    return text;
  }
}

//////////////////////////////////////////////////////////////////////////////

export interface RelationNode {
  id: number;
  value: Graph;
  out: RelationNode[];
  in: RelationNode[];
}

export class ProgramGraph {
  private static unique = 0;
  private nodes: RelationNode[] = [];
  private desc: ProcedureDesc;

  constructor(desc: ProcedureDesc) {
    this.desc = desc;
  }

  getDesc() {
    return this.desc;
  }

  add(g: Graph): RelationNode {
    const node: RelationNode = {
      id: ProgramGraph.unique++,
      value: g,
      out: [],
      in: [],
    };
    this.nodes.push(node);
    return node;
  }

  link(n: RelationNode) {
    return {
      to: (m: RelationNode) => {
        n.out.push(m);
        m.in.push(n);
      },
    };
  }

  transform() {
    this.nodes.forEach((e) =>
      e.value
        .frozeFinalSnapshot(true)
        .shorten()
        .constantEval()
        .cutEvaluated()
        .cutPaths()
        .count(),
    );
  }

  expose() {
    return this.nodes.filter((e) => !e.value.isEmpty()).map((e) => e.value);
  }

  showFullStructureFromEndDot() {
    return Graph.printToTopMulti(this.nodes.map((e) => e.value));
  }

  showFullStructureFromLeafsDot() {
    return Graph.printMulti(this.nodes.map((e) => e.value));
  }

  showRelationGraphDot() {
    let text = "";
    text += 'digraph {\n\tsubgraph {\n\t\tlabel="Graph";\n';
    for (const n of this.nodes) {
      text += `\t\tn${n.id}[label="${n.value.getLabels().join(", ")}"];\n`;
      for (const o of n.out) {
        text += `\t\tn${n.id} -> n${o.id};\n`;
      }
      for (const i of n.in) {
        text += `\t\tn${n.id} -> n${i.id}[style="dashed"];\n`;
      }
    }
    text += "\t}\n}\n";
    console.error(text);
  }
}
