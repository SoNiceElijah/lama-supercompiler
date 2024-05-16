import { Instruction } from "./common/asm";
import { AnalyzeResult } from "./common/types";
import { $meta } from "./common/utils";
import { build } from "./graphBuilder/build";
import { compile } from "./graphCompiler/compile";
import { transform } from "./graphCompiler/transform";
import { postprocess } from "./parser/analyzer";
import { parseFromFile } from "./parser/parser";

class Compiler {
  private info: AnalyzeResult;

  constructor(info: AnalyzeResult) {
    this.info = info;
  }

  build() {
    const structs = this.info.functions.map(build);

    const shows = {
      show: () =>
        structs.map((e) => e.showFullStructureFromEndDot()).join("\n"),
      showL: () =>
        structs.map((e) => e.showFullStructureFromLeafsDot()).join("\n"),
      showR: () => structs.map((e) => e.showRelationGraphDot()).join("\n"),
    };

    return {
      ...shows,
      transform: () => {
        for (const struct of structs) {
          transform(struct);
        }
        return {
          ...shows,
          compile: () => {
            const code: Instruction[][] = [];
            for (const struct of structs) {
              code.push(compile(struct));
            }

            const result = this.info.prologue
              .concat(this.info.sections.flatMap((e) => e))
              .concat([$meta(".data")])
              .concat(this.info.data)
              .concat([$meta(".text")])
              .concat(code.flatMap((e) => e));
            return postprocess(result);
          },
        };
      },
    };
  }
}

export function open(file: string, perf: boolean): Compiler {
  return new Compiler(parseFromFile(file, perf));
}
