import { ProgramGraph } from "../common/graph";

export function transform(rel: ProgramGraph): ProgramGraph {
  rel.transform();
  return rel;
}
