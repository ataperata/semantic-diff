def parse_header(text: str) -> str:
    lines = text.split("\n")
    header = lines[0].strip() if lines else ""
    if len(header) == 0:
        raise ValueError("missing header")
    return header


def read_file(path: str) -> str:
    text = open(path, encoding="utf-8").read()
    return parse_header(text)
