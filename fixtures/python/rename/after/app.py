from math import Cart, bar


def run(x: int) -> int:
    cart = Cart()
    a = bar(x)
    b = bar(a)
    return bar(b) + cart.price(b)
