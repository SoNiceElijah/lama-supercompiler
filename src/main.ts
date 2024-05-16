import { showInst } from "./common/asm";
import { open } from "./compiler";
import { Command } from "commander";
import pk from "../package.json";

function main() {
  const program = new Command();
  program
    .name("lama-supercompiler")
    .version(pk.version)
    .description(
      "Prototype tool for LaMa program language optimization through supercompilation",
    )
    .argument("<file>")
    .option("-p, --perf", "Prepare output to performance testing")
    .option("-s, --show", "Prints original graph in .dot format")
    .option("-g, --graph", "Prints transformed graph in .dot format")
    .option(
      "-r, --relations",
      "Prints original graph relations in .dot format",
    );

  program.parse();

  const [file] = program.args;
  const opts = program.opts();

  const app = open(file, !!opts.perf);
  if (opts.s) {
    console.log(app.build().show());
    return;
  }
  if (opts.g) {
    console.log(app.build().transform().show());
    return;
  }

  const code = app.build().transform().compile();
  const text = code.map(showInst).join("\n");
  console.log(text);
  return;
}
main();
