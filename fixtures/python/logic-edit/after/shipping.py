def shipping(total: int, weight: int) -> int:
    base = 5
    if total > 75:
        return 0
    return base + weight * 3


def note() -> str:
    return "standard"
