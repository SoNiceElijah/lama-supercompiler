import { Instruction } from "./asm";

export type Procedure = Instruction[];
export type Snapshot = Record<string, number>;

export interface ProcedureDesc {
  type: "Main" | "Module" | "Regular";
  perfTest: boolean;
  code: Instruction[];
  name: string;
  filled: boolean;
  localSize: number;
}

export interface AnalyzeResult {
  prologue: Instruction[];
  data: Instruction[];
  functions: ProcedureDesc[];
  exports: Set<string>;
  sections: Procedure[];
}

export interface Value {
  type: "Constant" | "Variable";
  value: number;
  contains: number | null;
  incites: string[];
}

export interface ValueNode {
  id: number;
  value: Value;
  marked: boolean;
  stream: InstructionNode[];
  createdBy: InstructionNode[];
  upSize: number;
}

export interface InstructionNode {
  original: Instruction[];
  up: ValueNode[];
  down: ValueNode[];
  id: number;
  useful: boolean;
  scope: number;
}

export const VALUE_SIZE = 4;
