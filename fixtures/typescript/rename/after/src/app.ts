import { Cart, bar } from "./math";

export function run(x: number): number {
  const cart = new Cart();
  const a = bar(x);
  const b = bar(a);
  return bar(b) + cart.price(b);
}
