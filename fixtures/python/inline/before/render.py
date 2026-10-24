def format_name(first: str, last: str) -> str:
    name = f"{first} {last}"
    return name.strip()


def render(first: str, last: str) -> str:
    return format_name(first, last)
