from text.slug import slugify


def make_link(title: str) -> str:
    return "/" + slugify(title)
