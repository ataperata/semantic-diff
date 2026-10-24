def shipping(total: int, weight: int) -> int:
    base = 5
    if total > 50:
        return 0
    return base + weight * 2
