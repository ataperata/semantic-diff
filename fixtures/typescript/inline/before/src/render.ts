export function formatName(first: string, last: string): string {
  const name = `${first} ${last}`;
  return name.trim();
}

export function render(first: string, last: string): string {
  return formatName(first, last);
}
