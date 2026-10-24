import { bar } from "./math";

export function run(x: number): number {
  const a = bar(x);
  return bar(a);
}
