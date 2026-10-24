export function shipping(total: number, weight: number): number {
  const base = 5;
  if (total > 50) {
    return 0;
  }
  return base + weight * 2;
}
