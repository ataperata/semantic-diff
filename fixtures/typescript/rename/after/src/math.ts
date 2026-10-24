export function bar(n: number): number {
  const base = n * 2;
  return base + 1;
}

export class Cart {
  price(n: number): number {
    const tax = 1;
    return n * 2 + tax;
  }
}
