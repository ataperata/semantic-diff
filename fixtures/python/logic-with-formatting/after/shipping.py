def shipping(total: int, weight: int) -> int:
    base = 5

    # free shipping threshold
    if total > 75:
        return 0

    return base + weight * 3
