export function shipping(total: number, weight: number): number {
  const base = 5;

  // free shipping threshold
  if (total > 75) {
    return 0;
  }

  return base + weight * 3;
}
