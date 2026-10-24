export function openSocket(url: string): string {
  return url;
}

export function connect(url: string, timeout = 30): Promise<string> {
  return openSocket(url);
}
