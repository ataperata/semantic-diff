def slugify(value: str) -> str:
    text = value.strip().lower()
    return text.replace(" ", "-")
