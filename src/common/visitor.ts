import { Instruction } from "./asm";

type KnownInstructions =
  | "mov"
  | "add"
  | "mul"
  | "call"
  | "cmp"
  | "set"
  | "xor"
  | "ret"
  | "sub"
  | "and"
  | "or"
  | "imul"
  | "idiv"
  | "cltd"
  | "jmp"
  | "j"
  | "lea"
  | "sal"
  | "sar"
  | "dec"
  | "push"
  | "pop"
  | "sync"
  | "nop";

type Handler = (x: Instruction) => void;
export function run(
  controllers: Partial<Record<KnownInstructions, Handler>> & {
    other: Handler;
    each?: Handler;
  },
) {
  return (xs: Instruction[]) => {
    for (let i = 0; i < xs.length; ++i) {
      const x = xs[i];
      if (x.name.startsWith(".")) {
        continue;
      }
      let found = false;
      for (const key in controllers) {
        if (!x.name.startsWith(key)) {
          continue;
        }
        const func = controllers[key as KnownInstructions];
        if (func) {
          func(x);
          found = true;
          break;
        }
      }
      if (!found) {
        controllers["other"](x);
      }
      controllers["each"]?.(x);
    }
  };
}
