def foo(n: int) -> int:
    base = n * 2
    return base + 1


class Cart:
    def cost(self, n: int) -> int:
        tax = 1
        return n * 2 + tax
