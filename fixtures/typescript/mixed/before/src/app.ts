import { foo } from "./math";

export function run(x: number): number {
  const a = foo(x);
  return foo(a);
}
