////////////////////////////////////////////////////////////////////////////

export interface MetaArg {
  type: "MetaArg";
  content: string;
}

export interface LiteralArg {
  type: "LiteralArg";
  value: number;
}

export interface LiteralStringArg {
  type: "LiteralStringArg";
  value: string;
}

export interface RegisterArg {
  type: "RegisterArg";
  value: string;
}

export interface StackArg {
  type: "StackArg";
  position: number;
}

export interface IndirectArg {
  type: "ImmArg";
  offset: number;
  base: RegisterArg;
}

export interface MemoryArg {
  type: "MemoryArg";
  location: string;
}

export interface ValueArg {
  type: "ValueArg";
  name: string;
  original: Arg;
}

export type Arg =
  | MemoryArg
  | StackArg
  | RegisterArg
  | LiteralArg
  | LiteralStringArg
  | MetaArg
  | ValueArg
  | IndirectArg;

export function showArgDebug(x: Arg): string {
  if (x.type === "LiteralArg") {
    return `$${x.value}`;
  }
  if (x.type === "MemoryArg") {
    return `${x.location}`;
  }
  if (x.type === "MetaArg") {
    return x.content;
  }
  if (x.type === "RegisterArg") {
    return `%${x.value}`;
  }
  if (x.type === "LiteralStringArg") {
    return `$${x.value}`;
  }
  if (x.type === "StackArg") {
    return `${x.position}(%ebp)`;
  }
  if (x.type === "ImmArg") {
    if (x.offset === 0) {
      return `(%${x.base.value})`;
    }
    return `${x.offset}(%${x.base.value})`;
  }
  return `${showArgDebug(x.original)} [${x.name}]`;
}

export function showArg(x: Arg): string {
  if (x.type === "LiteralArg") {
    return `$${x.value}`;
  }
  if (x.type === "MemoryArg") {
    return `${x.location}`;
  }
  if (x.type === "MetaArg") {
    return x.content;
  }
  if (x.type === "RegisterArg") {
    return `%${x.value}`;
  }
  if (x.type === "StackArg") {
    return `${x.position}(%ebp)`;
  }
  if (x.type === "LiteralStringArg") {
    return `$${x.value}`;
  }
  if (x.type === "ImmArg") {
    if (x.offset === 0) {
      return `(%${x.base.value})`;
    }
    if (Number.isNaN(x.offset)) {
      return `*(%${x.base.value})`;
    }
    return `${x.offset}(%${x.base.value})`;
  }
  throw new Error("Unknown argument");
}

export interface Instruction {
  label?: string;
  justLabel: boolean;
  name: string;
  meta: boolean;
  args: Arg[];
}

export function argEq(x: Arg, y: Arg): boolean {
  if (x.type === "RegisterArg" && y.type === "RegisterArg") {
    return x.value === y.value;
  }
  if (x.type === "MemoryArg" && y.type === "MemoryArg") {
    return x.location === y.location;
  }
  if (x.type === "StackArg" && y.type === "StackArg") {
    return x.position === y.position;
  }
  if (x.type === "LiteralArg" && y.type === "LiteralArg") {
    return x.value === y.value;
  }
  if (x.type === "LiteralStringArg" && y.type === "LiteralStringArg") {
    return x.value === y.value;
  }
  if (x.type === "ImmArg" && y.type === "ImmArg") {
    return x.offset === y.offset && argEq(x.base, y.base);
  }
  return false;
}

export function instEqWeak(x: Instruction, y: Instruction) {
  if (x === y) {
    return true;
  }
  if (x.name !== y.name) {
    return false;
  }

  return true;
}

export function instEqWeakArr(xs: Instruction[], ys: Instruction[]) {
  if (xs.length !== ys.length) {
    return false;
  }

  for (let i = 0; i < xs.length; ++i) {
    if (!instEqWeak(xs[i], ys[i])) {
      return false;
    }
  }

  return true;
}

export function showInst(x: Instruction) {
  const args = x.args.map(showArg).join(",\t");
  if (x.justLabel) {
    return `${x.label}:`;
  }
  return `${x.label ? `${x.label}:` : ""}\t${x.name}\t${args}`;
}

export function showInstDebug(x: Instruction) {
  const args = x.args.map(showArgDebug).join(", ");
  return `${x.label ? `LAB[${x.label}] ` : ""}${x.name} ${args}`;
}

export function showAsmDebug(x: Instruction[]) {
  return x.map(showInstDebug).join("\n");
}

////////////////////////////////////////////////////////////////////////////
