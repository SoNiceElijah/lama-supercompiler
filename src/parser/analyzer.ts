import { Arg, Instruction } from "../common/asm";
import { PatternWatcher } from "../common/patternWatcher";
import { AnalyzeResult, Procedure, ProcedureDesc } from "../common/types";
import { $__m, R } from "../common/utils";

export function prepare(
  code: Instruction[],
  perfTest: boolean,
  persist = false,
): AnalyzeResult {
  const constants = new Map<string, number>();
  const functions = new Set<string>();
  const exports = new Set<string>();

  let mainName = "";
  let filled: boolean = false;

  const begin = PatternWatcher.create([
    ["pushl", [R.ebp]],
    ["movl", [R.esp, R.ebp]],
    ["subl", [null, R.esp]],
  ]);

  const end = PatternWatcher.create([
    ["movl", [R.ebp, R.esp]],
    ["popl", [R.ebp]],
  ]);

  const lastLabels: string[] = [""];
  let smellsLikeFunction = "";

  const technicLabels = ["_ERROR", "_ERROR2"];

  for (const inst of code) {
    if (inst.name === ".globl") {
      const name = inst.args[0];
      if (name.type === "MetaArg") {
        exports.add(name.content);
      }
    }
    if (inst.name === ".fill") {
      filled = true;
    }
    if (inst.meta && inst.name !== ".set" && inst.label === undefined) {
      continue;
    }
    if (inst.label !== undefined) {
      if (!technicLabels.includes(inst.label)) {
        lastLabels.push(inst.label);
      }
    }
    if (begin.submit(inst)) {
      smellsLikeFunction = lastLabels.at(-1)!;
      if (smellsLikeFunction === "_continue") {
        mainName = lastLabels.at(-2)!;
      }
    }
    if (end.submit(inst)) {
      functions.add(smellsLikeFunction);
    }
    if (inst.name === ".set") {
      const [name, value] = inst.args;
      let n = "";
      if (name.type === "MetaArg") {
        n = name.content;
      }
      let v = 0;
      if (value.type === "MetaArg") {
        v = parseInt(value.content);
      }

      constants.set(n, v);
    }
  }

  const resolved: Instruction[] = [];

  for (const inst of code) {
    const { args, ...info } = inst;
    if (inst.name === ".stabs") {
      continue;
    }
    resolved.push({
      ...info,
      args: args.map((e) => {
        if (e.type === "LiteralStringArg") {
          if (constants.has(e.value)) {
            return {
              type: "LiteralArg",
              value: constants.get(e.value),
            } as Arg;
          } else {
            return e;
          }
        }
        return e;
      }),
    });
  }

  const zeros = PatternWatcher.create([
    ["movl", [R.esp, R.edi]],
    ["movl", [null, R.esi]],
    ["movl", [null, R.ecx]],
    ["rep", [null]],
  ]);

  const tailrec = PatternWatcher.create([
    ["movl", [R.ebp, R.esp]],
    ["popl", [R.ebp]],
    ["jmp", [null]],
  ]);

  const tailrec2 = PatternWatcher.create([
    ["movl", [R.ebp, R.esp]],
    ["popl", [R.ebp]],
    ["popl", [R.ebx]],
    ["jmp", [null]],
  ]);

  const prologue: Instruction[] = [];
  const data: Instruction[] = [];
  const funcs: ProcedureDesc[] = [];
  const sections: Procedure[] = [];
  const text: Instruction[] = [];
  let mode = 0;

  for (const inst of resolved) {
    if (inst.name === ".data") {
      mode = 1;
      continue;
    }
    if (inst.name === ".text") {
      mode = 2;
      continue;
    }
    if (inst.name === ".section") {
      mode = 3;
      sections.push([]);
    }

    //////////////////////////////////////////////

    if (mode === 0) {
      if (perfTest && inst.name === ".globl") {
        inst.args = inst.args.map((e) => {
          if (e.type === "MetaArg") {
            return $__m(`${e.content}_optimized`);
          }
          return e;
        });
      }
      prologue.push(inst);
    }
    if (mode === 1) {
      data.push(inst);
    }
    if (mode === 2) {
      text.push(inst);
    }
    if (mode === 3) {
      sections.at(-1)?.push(inst);
    }
  }

  const resolvedText = resolveUnreachable(text, exports);
  for (const inst of resolvedText) {
    if (inst.label !== undefined) {
      if (functions.has(inst.label)) {
        const fname = inst.label === "_continue" ? mainName : inst.label;
        funcs.push({
          code: [],
          perfTest,
          type:
            inst.label === "_continue"
              ? mainName === "main"
                ? "Main"
                : "Module"
              : "Regular",
          name: fname,
          filled,
          localSize: 0,
        });
      }
    }

    if (inst.name === ".local") {
      const arg = inst.args[0];
      if (arg.type === "MetaArg") {
        const idx = parseInt(arg.content);
        const f = funcs.at(-1)!;
        f.localSize = Math.max(f.localSize, idx + 1);
      }
    }

    if (!persist) {
      if (tailrec.submit(inst)) {
        inst.args.push($__m("#TAILREC"));
      }

      if (tailrec2.submit(inst)) {
        inst.args.push($__m("#TAILREC"));
      }

      zeros.submit(inst);
      const rej = zeros.restoreRejected();
      if (rej) {
        funcs.at(-1)?.code.push(...rej);
      }
    } else {
      funcs.at(-1)?.code.push(inst);
    }
  }

  return {
    exports,
    prologue,
    data,
    functions: funcs,
    sections,
  };
}

function resolveUnreachable(
  code: Instruction[],
  exports: Set<string>,
): Instruction[] {
  // bad algo, rewrite later...
  const text = code.map((e) => [false, e] as [boolean, Instruction]);
  const reachable = new Set(exports);
  let online = true;
  while (online) {
    online = false;
    let currentReachable = false;
    const notReachable = new Set();

    // eslint-disable-next-line no-inner-declarations
    function use(i: Instruction) {
      if (currentReachable) {
        for (const arg of i.args) {
          if (arg.type === "MemoryArg") {
            reachable.add(arg.location);
            if (notReachable.has(arg.location)) {
              online = true;
            }
          }
          if (arg.type === "LiteralStringArg") {
            reachable.add(arg.value);
            if (notReachable.has(arg.value)) {
              online = true;
            }
          }
        }
      }
    }

    for (const box of text) {
      const inst = box[1];
      if (inst.label !== undefined) {
        if (reachable.has(inst.label)) {
          currentReachable = true;
        } else {
          if (!currentReachable) {
            notReachable.add(inst.label);
          }
        }
      }
      if (currentReachable) {
        box[0] = true;
      }
      use(inst);
      if (inst.name === "jmp") {
        use(inst);
        currentReachable = false;
      }
      if (inst.name === "ret") {
        currentReachable = false;
      }
    }
  }
  return text.filter((e) => e[0]).map((e) => e[1]);
}

export function postprocess(code: Instruction[]): Instruction[] {
  return collapseLabels(code);
}

function collapseLabels(code: Instruction[]): Instruction[] {
  const result: Instruction[] = [];
  const useful = new Set<string>();

  useful.add("_ERROR");
  useful.add("_ERROR2");

  for (const inst of code) {
    if (inst.name === ".globl") {
      const [name] = inst.args;
      if (name.type === "MetaArg") {
        useful.add(name.content);
      }
      continue;
    }

    for (const arg of inst.args) {
      if (arg.type === "MemoryArg") {
        useful.add(arg.location);
      }
      if (arg.type === "LiteralStringArg") {
        useful.add(arg.value);
      }
    }
  }

  for (const inst of code) {
    if (inst.label !== undefined && inst.justLabel) {
      if (useful.has(inst.label)) {
        result.push(inst);
      }
      continue;
    }
    if (inst.label !== undefined) {
      if (useful.has(inst.label)) {
        result.push(inst);
      } else {
        result.push({
          ...inst,
          label: undefined,
        });
      }
      continue;
    }
    result.push(inst);
  }

  return result;
}
