import { slugify } from "./url/slug";

export function makeLink(title: string): string {
  return "/" + slugify(title);
}
