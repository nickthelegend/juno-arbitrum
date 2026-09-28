"""
An iPhone 17 Pro body to put simulator recordings in.

`simctl io recordVideo` captures the screen alone; the device body in the
Simulator window is chrome, not pixels. This draws one: titanium band, black
bezel, side buttons, and a transparent cut-out exactly the size
of the simulator's screen (1206x2622), so a recording overlaid underneath
shows through with the display's rounded corners.

    python3 scripts/demo/device_frame.py out/frame.png

Drawn at 3x and downsampled, because Pillow does not anti-alias shapes.
"""
import sys

from PIL import Image, ImageDraw, ImageFilter

SCREEN_W, SCREEN_H = 1206, 2622  # iPhone 17 Pro simulator, @3x
SCREEN_R = 168  # display corner radius
BEZEL = 40  # black glass border around the display
BAND = 20  # titanium edge
PAD = 44  # room for the side buttons
ISLAND_W, ISLAND_H, ISLAND_TOP = 378, 111, 33

BODY_W = SCREEN_W + 2 * (BEZEL + BAND)
BODY_H = SCREEN_H + 2 * (BEZEL + BAND)
W, H = BODY_W + 2 * PAD, BODY_H + 2 * PAD
SCREEN_X, SCREEN_Y = PAD + BAND + BEZEL, PAD + BAND + BEZEL

S = 3  # supersampling


def rr(draw, box, radius, fill):
    x0, y0, x1, y1 = box
    draw.rounded_rectangle((x0 * S, y0 * S, x1 * S, y1 * S), radius=radius * S, fill=fill)


def titanium(width, height):
    """A brushed-titanium band: dark at the edges, a soft highlight inside."""
    gradient = Image.new("RGBA", (width, 1))
    stops = [(0.0, (58, 58, 62)), (0.08, (142, 142, 147)), (0.5, (92, 92, 98)), (0.92, (142, 142, 147)), (1.0, (58, 58, 62))]
    for x in range(width):
        t = x / max(width - 1, 1)
        for (a, ca), (b, cb) in zip(stops, stops[1:]):
            if a <= t <= b:
                k = (t - a) / (b - a) if b > a else 0
                gradient.putpixel((x, 0), tuple(int(ca[i] + (cb[i] - ca[i]) * k) for i in range(3)) + (255,))
                break
    return gradient.resize((width, height))


def main(out):
    big = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(big)

    # Side buttons, drawn first so the body overlaps their inner edge.
    button = (84, 84, 90, 255)
    left = PAD - 10
    rr(draw, (left, PAD + 360, PAD + 6, PAD + 460), 8, button)  # action button
    rr(draw, (left, PAD + 560, PAD + 6, PAD + 760), 8, button)  # volume up
    rr(draw, (left, PAD + 800, PAD + 6, PAD + 1000), 8, button)  # volume down
    right = W - PAD - 6
    rr(draw, (right, PAD + 640, W - PAD + 10, PAD + 930), 8, button)  # side button
    rr(draw, (right, PAD + 1560, W - PAD + 8, PAD + 1720), 8, (70, 70, 76, 255))  # camera control

    # Titanium band, masked to the body's rounded rectangle.
    outer_r = SCREEN_R + BEZEL + BAND
    mask = Image.new("L", big.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (PAD * S, PAD * S, (PAD + BODY_W) * S, (PAD + BODY_H) * S), radius=outer_r * S, fill=255
    )
    big.paste(titanium(big.size[0], big.size[1]), (0, 0), mask)

    # Black glass.
    rr(draw, (PAD + BAND, PAD + BAND, PAD + BODY_W - BAND, PAD + BODY_H - BAND), SCREEN_R + BEZEL, (8, 8, 10, 255))

    # The display cut-out: fully transparent, rounded like the real panel.
    hole = Image.new("L", big.size, 0)
    ImageDraw.Draw(hole).rounded_rectangle(
        (SCREEN_X * S, SCREEN_Y * S, (SCREEN_X + SCREEN_W) * S, (SCREEN_Y + SCREEN_H) * S),
        radius=SCREEN_R * S,
        fill=255,
    )
    alpha = big.getchannel("A")
    alpha.paste(0, (0, 0), hole)
    big.putalpha(alpha)

    # No Dynamic Island here: on iOS 26 the simulator draws it into its own
    # screenshots and recordings (x 415-791, y 42-151 at @3x), and a second
    # one on top would sit a few pixels off. `--island` adds it for captures
    # that lack one.
    if "--island" in sys.argv:
        ix = SCREEN_X + (SCREEN_W - ISLAND_W) // 2
        rr(draw, (ix, SCREEN_Y + ISLAND_TOP, ix + ISLAND_W, SCREEN_Y + ISLAND_TOP + ISLAND_H), ISLAND_H // 2, (0, 0, 0, 255))

    frame = big.resize((W, H), Image.LANCZOS)

    # A soft drop shadow, for the version on a background.
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    shadow.putalpha(frame.getchannel("A").point(lambda a: 70 if a > 0 else 0).filter(ImageFilter.GaussianBlur(24)))

    frame.save(out)
    shadow.save(out.replace(".png", "-shadow.png"))
    print(f"{out}  {W}x{H}  screen at ({SCREEN_X},{SCREEN_Y}) {SCREEN_W}x{SCREEN_H}")


if __name__ == "__main__":
    main(next((a for a in sys.argv[1:] if not a.startswith("--")), "frame.png"))
