import { slugify } from "./text/slug";

export function makeLink(title: string): string {
  return "/" + slugify(title);
}
