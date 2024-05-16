import {
  Arg,
  IndirectArg,
  Instruction,
  LiteralArg,
  LiteralStringArg,
  MemoryArg,
  MetaArg,
  RegisterArg,
  StackArg,
} from "./asm";
import { InstructionNode } from "./types";

export function $r(x: string): RegisterArg {
  return {
    type: "RegisterArg",
    value: x,
  };
}

export function $m(x: string): MemoryArg {
  return {
    type: "MemoryArg",
    location: x,
  };
}

export function $l(x: number): LiteralArg {
  return {
    type: "LiteralArg",
    value: x,
  };
}

export function $ls(x: string): LiteralStringArg {
  return {
    type: "LiteralStringArg",
    value: x,
  };
}

export function $s(position: number): StackArg {
  return {
    type: "StackArg",
    position,
  };
}

export function $i(x: RegisterArg, offset?: number): IndirectArg {
  return {
    type: "ImmArg",
    offset: offset ?? 0,
    base: x,
  };
}

export function $__m(x: string): MetaArg {
  return {
    type: "MetaArg",
    content: x,
  };
}

export function shape<T>(n: number, f: (i: number) => T): T[] {
  const list: T[] = [];
  for (let i = 0; i < n; ++i) {
    list.push(f(i));
  }
  return list;
}

export function arrEq<T>(xs: T[], ys: T[]) {
  if (xs.length !== ys.length) {
    return false;
  }
  for (let i = 0; i < xs.length; ++i) {
    const a = xs[i];
    const b = ys[i];
    if (a !== b) {
      return false;
    }
  }

  return true;
}

export const R = {
  ebx: $r("ebx"),
  ecx: $r("ecx"),
  esi: $r("esi"),
  edi: $r("edi"),
  eax: $r("eax"),
  edx: $r("edx"),
  esp: $r("esp"),
  ebp: $r("ebp"),

  invisible: $r("invisible"),
};

export function low(r: RegisterArg): RegisterArg {
  if (!["eax", "ebx", "ecx", "edx"].includes(r.value)) {
    throw new Error("Can not place low byte");
  }

  return $r(r.value.substring(1)[0] + "l");
}

export function $do(name: string, ...args: Arg[]): Instruction {
  return {
    name,
    justLabel: false,
    args,
    meta: false,
  };
}

export function $meta(name: string, ...args: Arg[]): Instruction {
  return {
    name,
    justLabel: false,
    args,
    meta: true,
  };
}

export function $lab(label: string): Instruction {
  return {
    name: "",
    justLabel: true,
    meta: false,
    args: [],
    label,
  };
}

export function $fst<T>(n: InstructionNode) {
  return (f: (x: Instruction) => T): T | undefined => {
    if (n.original.length !== 1) {
      return;
    }
    const [inst] = n.original;
    return f(inst);
  };
}

export function maskEq(x: Set<string>, y: Set<string>) {
  if (x.size !== y.size) {
    return false;
  }
  for (const e of x) {
    if (!y.has(e)) {
      return false;
    }
  }
  for (const e of y) {
    if (!x.has(e)) {
      return false;
    }
  }

  return true;
}

export class Code {
  private code: Instruction[] = [];

  push(...xs: Instruction[]) {
    for (const x of xs) {
      this.code.push(x);
    }
  }

  expose() {
    return this.code;
  }
}

export function extendRegisterName(name: string) {
  if (name.startsWith("e")) {
    return name;
  }
  if (name.endsWith("l")) {
    return "e" + name.substring(0, 1) + "x";
  }
  return "";
}

export function downGradeRegisterTo32(x: Arg): Arg {
  return x;
}
