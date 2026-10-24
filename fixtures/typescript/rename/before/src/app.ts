import { Cart, foo } from "./math";

export function run(x: number): number {
  const cart = new Cart();
  const a = foo(x);
  const b = foo(a);
  return foo(b) + cart.cost(b);
}
