from math import Cart, foo


def run(x: int) -> int:
    cart = Cart()
    a = foo(x)
    b = foo(a)
    return foo(b) + cart.cost(b)
