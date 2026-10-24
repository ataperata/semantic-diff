export function slugify(value: string): string {
  const text = value.trim().toLowerCase();
  return text.replace(" ", "-");
}
