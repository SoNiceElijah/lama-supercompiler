import fs from "fs";
import { Arg, Instruction } from "../common/asm";
import { $__m, $do } from "../common/utils";
import { prepare } from "./analyzer";

function read(filePath: string): Instruction[] {
  const text = fs.readFileSync(filePath, "utf-8");
  return parseText(text);
}

const I32 = true;

function split(text: string) {
  let buffer = "";
  const result: string[] = [];
  let mode = 0;
  let prev = "";
  for (const letter of text) {
    if ((letter === "\t" || letter === " ") && mode === 0) {
      if (buffer.length) {
        result.push(buffer);
        buffer = "";
      }
      continue;
    }
    if (letter === '"' && prev !== "\\") {
      if (mode === 0) {
        mode = 1;
        if (buffer.length) {
          result.push(buffer);
        }
        buffer = letter;
      } else {
        mode = 0;
        buffer += letter;
      }

      continue;
    }
    buffer += letter;
    prev = letter;
  }

  if (buffer.length) {
    result.push(buffer);
  }

  return result;
}

function parseText(text: string): Instruction[] {
  function getLabel(xs: string[]): [string[], string | undefined] {
    if (xs.length) {
      const x = xs[0];
      if (x.endsWith(":")) {
        return [xs.slice(1), x.substring(0, x.length - 1)];
      }
    }
    return [xs, undefined];
  }

  function mapArg(meta: boolean) {
    return function (e: string): Arg {
      let x = e.trim();
      if (x.endsWith(",")) {
        x = x.substring(0, x.length - 1);
      }
      if (x.startsWith("$")) {
        const value = parseInt(x.substring(1));
        if (!Number.isNaN(value)) {
          return {
            type: "LiteralArg",
            value,
          };
        } else {
          return {
            type: "LiteralStringArg",
            value: x.substring(1),
          };
        }
      }
      if (x.startsWith("%")) {
        return {
          type: "RegisterArg",
          value: x.substring(1),
        };
      }
      if (x.includes("(%ebp)") && !x.startsWith('"')) {
        return {
          type: "StackArg",
          position: parseInt(x.split("(")[0]),
        };
      }
      if (x.includes("(%") && !x.startsWith('"')) {
        const tokens = x.split("(");
        return {
          type: "ImmArg",
          offset: x.startsWith("(") ? 0 : parseInt(tokens[0]),
          base: {
            type: "RegisterArg",
            value: tokens[1].substring(1, tokens[1].length - 1),
          },
        };
      }
      if (!meta && I32) {
        return {
          type: "MemoryArg",
          location: x,
        };
      }
      return {
        type: "MetaArg",
        content: x,
      };
    };
  }

  const lines = text.split("\n");
  const result: Instruction[] = [];
  for (const line of lines) {
    if (line.startsWith("#")) {
      const match = line.match(/(?:LD|ST)\s*\(Local\s*\((\d+)\)\s*\)/);
      if (match) {
        const fst = match[1];
        if (fst !== undefined) {
          result.push($do(".local", $__m(fst)));
        }
      }
      continue;
    }
    const tokens = split(line).filter((x) => x);
    if (!tokens.length) {
      continue;
    }
    const [tks, label] = getLabel(tokens);
    if (!tks.length) {
      result.push({
        label,
        justLabel: true,
        name: "",
        meta: true,
        args: [],
      });
      continue;
    }
    const [cmd, ...args] = tks;
    const meta = cmd.startsWith(".");
    result.push({
      label,
      justLabel: false,
      name: cmd,
      meta,
      args: args.filter((x) => x.trim()).map(mapArg(meta)),
    });
  }
  return result;
}

export function parseFromFile(file: string, perf: boolean) {
  const instructions = read(file);
  return prepare(instructions, perf);
}
