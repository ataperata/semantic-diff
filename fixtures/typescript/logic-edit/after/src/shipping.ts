export function shipping(total: number, weight: number): number {
  const base = 5;
  if (total > 75) {
    return 0;
  }
  return base + weight * 3;
}

export function note(): string {
  return "standard";
}
