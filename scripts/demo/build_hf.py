"""
Write the HyperFrames composition for the Juno demo film.

    python3 scripts/demo/build_hf.py .juno/video/final/hf .juno/video/final/vo11

Order: an optional cold-open film (assets/cat.mp4), the web app, the problem card, a
phone fly-in opening, twelve feature chapters, how it's built, the end card.

The chapter layout follows the reference the user chose: a dark stage, the
phone alternating sides with a lime disc behind it, a 3D swing between
chapters, titles that type in letter by letter. The phone body is the frame
image with the screen recording placed in its cut-out, so the disc can sit
behind it. Captions are burned in from ElevenLabs word timings, one phrase at
a time, with the spoken word lit.
"""
import html
import json
import sys

HF, VO = sys.argv[1], sys.argv[2]
plan = json.load(open(f"{HF}/plan.json"))
vo = json.load(open(f"{VO}/durations.json"))
words = {k: json.load(open(f"{VO}/{k}.words.json")) for k in vo}

INK, LIME, SAGE = "#12150E", "#D6FF3D", "#DCE6D4"

CHAPTERS = [
    ("c01", "A wallet in seconds", "Sign in with email. Privy creates an Ethereum wallet, with no seed phrase.",
     ["Email sign-in, secured by Privy", "Embedded EVM wallet, made on sign-in", "Test ETH from the faucet, a name by signature"], ["Privy", "Arbitrum"]),
    ("c02", "Every post has a price", "Buy the posts you believe in. The quote comes from the curve contract.",
     ["Live quote, fee and price impact", "Signed on the phone, confirmed on Arbitrum", "Receipt with an Arbiscan link"], ["Arbitrum"]),
    ("c03", "Reels are markets too", "Full-screen video, with the market right under the caption.",
     ["Market cap and progress to graduation", "Buy and sell from the dock", "Likes stored against each wallet"], ["Arbitrum"]),
    ("c04", "Real likes, real comments", "Every count is stored. Every name is claimed with a signature.",
     ["Likes and comments from other wallets", "Names signed with EIP-191", "Nothing hardcoded"], ["Social"]),
    ("c05", "Posting is launching", "Pick a photo, choose a curve shape, sign once. The market is live.",
     ["Four shapes: Content, Thin name, IPO book, Tight NAV", "One factory call: token + curve", "Every step timestamped to the second"], ["Solidity", "IPFS"]),
    ("c06", "Reels launch the same way", "Video in, market out, in one transaction.",
     ["Video pinned to IPFS with a poster frame", "Launched by JunoFactory", "Straight into the swipe feed"], ["Solidity", "IPFS"]),
    ("c07", "Creators get paid", "Every trade pays the creator. They claim it from the coin page.",
     ["Half of every fee accrues to the creator", "claimCreatorFees(), creator only", "Receipt on screen"], ["Solidity"]),
    ("c08", "Held to Chainlink, on-chain", "A stock tracker refuses any buy that would leave its band.",
     ["Chainlink price read on every buy", "In-band buy: confirmed", "Out-of-band buy: OutsideBand, from the contract"], ["Chainlink"]),
    ("c09", "Market closed, sells only", "A stale feed closes the market. Selling never stops.",
     ["Staleness checked in the contract", "Buys refused: MarketClosed", "Sells always open"], ["Chainlink"]),
    ("c10", "Graduation to Uniswap v3", "A filled curve moves its liquidity into a Uniswap v3 pool.",
     ["graduate() is permissionless once full", "Full-range position, locked forever", "Trading continues on Uniswap"], ["Uniswap v3"]),
    ("c11", "Curve maths in Stylus", "The pricing engine is a Rust program on Arbitrum Stylus.",
     ["Sixteen segments, four measured shapes", "Matched a Solidity reference on 720 calls", "Deployed code rebuilt byte for byte"], ["Stylus", "Rust"]),
    ("c12", "Live on Arbitrum One", "The same contracts, with a Tesla tracker on the real Chainlink feed.",
     ["Factory, curve and Stylus maths on mainnet", "TSLA tracker against the real feed", "Out-of-band buy refused, proven with eth_call"], ["Arbitrum One", "Chainlink"]),

]

LOGO = ('<svg viewBox="0 0 48 48" fill="none"><path d="M9 38.5C9 38.5 18 36.5 24 30C29 24.6 30.5 18.5 30.5 18.5" '
        'stroke="{c}" stroke-width="5" stroke-linecap="round"/><circle cx="36.5" cy="10.5" r="4.8" fill="{c}"/></svg>')

# phone geometry: frame image 1414x2830 with the screen hole at (104,104) 1206x2622
PH = 900
S = PH / 2830
PW = round(1414 * S, 1)
HOLE = round(104 * S, 1)
SW, SH = round(1206 * S, 1), round(2622 * S, 1)
PHONE_TOP = 48

# ------------------------------------------------------------------ timing
T = {"cat": (0.0, 20.0), "web": (20.0, 10.0)}
T["prob"] = (30.0, round(vo["problem"] + 2.4, 2))
t = T["prob"][0] + T["prob"][1]
T["hero"] = (round(t, 2), 4.6)
t += 4.6
for cid, *_ in CHAPTERS:
    T[cid] = (round(t, 2), plan[cid]["len"])
    t += plan[cid]["len"]
T["stack"] = (round(t, 2), round(vo["stack"] + 2.6, 2))
t += T["stack"][1]
T["outro"] = (round(t, 2), 7.0)
TOTAL = round(t + 7.0, 2)
VO_AT = {"intro": T["web"][0] + 0.8, "problem": T["prob"][0] + 0.8, "stack": T["stack"][0] + 0.9, "outro": T["outro"][0] + 0.8}
for cid, *_ in CHAPTERS:
    VO_AT[cid] = T[cid][0] + 0.6

esc = html.escape
parts, tl = [], []


def at(key, offset=0.0):
    return round(T[key][0] + offset, 3)


def split_chars(text, prefix):
    """Title as word blocks of letter spans, so it can type in letter by letter."""
    out, n = [], 0
    for word in text.split(" "):
        letters = "".join(f'<span class="ch" id="{prefix}-{n + i}">{esc(c)}</span>' for i, c in enumerate(word))
        n += len(word)
        out.append(f'<span class="wd">{letters}</span>')
    return " ".join(out), n


# ------------------------------------------------------------------ cat film
parts.append(f'<video id="cat" class="clip full" data-start="0" data-duration="20" src="assets/cat.mp4" muted playsinline></video>')
parts.append('<audio id="cat-audio" data-start="0" data-duration="20" data-volume="1" data-fade-out="0.4" src="assets/audio/cat.wav"></audio>')

# ------------------------------------------------------------------ website
s, d = T["web"]
parts.append(f"""
<div id="web" class="clip scene" data-start="{s}" data-duration="{d}" style="background:{SAGE}">
  <div id="web-window" class="browser">
    <div class="bar"><span class="dot" style="background:#FF5F57"></span><span class="dot" style="background:#FEBC2E"></span><span class="dot" style="background:#28C840"></span>
      <div class="url">juno-arb-app.vercel.app</div></div>
    <div class="viewport"><img id="web-shot" src="assets/landing-full.png" alt="Juno landing page"></div>
  </div>
</div>""")
tl.append(f'tl.fromTo("#web-window", {{opacity: 0, scale: 0.94, y: 30}}, {{opacity: 1, scale: 1, y: 0, duration: 0.7, ease: "power3.out"}}, {at("web", 0.05)});')
tl.append(f'tl.fromTo("#web-shot", {{y: 0}}, {{y: -4110, duration: 8.6, ease: "power1.inOut"}}, {at("web", 0.8)});')

# ------------------------------------------------------------------ problem
s, d = T["prob"]
pw = words["problem"]
starts = [w["s"] for w in pw]
sent = [0] + [i + 1 for i, w in enumerate(pw[:-1]) if w["w"].endswith(".")]
line_at = [round(VO_AT["problem"] + starts[i] - 0.15, 2) for i in sent[:3]]
parts.append(f"""
<div id="prob" class="clip scene dark" data-start="{s}" data-duration="{d}">
  <div class="prob-logo" id="prob-logo">{LOGO.format(c=LIME)}<span>juno</span></div>
  <div class="prob-lines">
    <div class="pl" id="pl1">Creators get paid last.</div>
    <div class="pl muted" id="pl2">Their first fans get nothing.</div>
    <div class="pl" id="pl3">On Juno, every post is <span class="hl">a market.</span></div>
  </div>
</div>""")
tl.append(f'tl.fromTo("#prob-logo", {{opacity: 0, y: -12}}, {{opacity: 1, y: 0, duration: 0.5}}, {at("prob", 0.2)});')
for i, a in enumerate(line_at, start=1):
    tl.append(f'tl.fromTo("#pl{i}", {{opacity: 0, y: 40}}, {{opacity: 1, y: 0, duration: 0.6, ease: "power3.out"}}, {a});')
tl.append(f'tl.to(".prob-lines", {{opacity: 0, duration: 0.35}}, {round(s + d - 0.4, 2)});')

# ------------------------------------------------------------------ hero: the reference's fly-in opening
s, d = T["hero"]
parts.append(f"""
<div id="hero" class="clip scene dark" data-start="{s}" data-duration="{d}">
  <div class="disc" id="hero-disc" style="left:{960 - 430}px; top:{540 - 430 - 30}px; width:860px; height:860px"></div>
  <img class="card" id="hero-card-l" src="assets/poster-NEON.jpg" alt="City After Rain reel">
  <img class="card" id="hero-card-r" src="assets/poster-KICK.jpg" alt="Park Session reel">
  <div class="phone" id="hero-phone" style="left:{960 - PW / 2}px; top:{PHONE_TOP}px">
    <img class="screen" src="assets/hero-screen.png" alt="Juno feed">
    <img class="frame" src="assets/phone-frame.png" alt="">
  </div>
</div>""")
tl.append(f'tl.fromTo("#hero-phone", {{scale: 2.8, y: 260, rotation: -8, opacity: 0}}, {{scale: 1, y: 0, rotation: 0, opacity: 1, duration: 1.1, ease: "power3.out"}}, {at("hero", 0.05)});')
tl.append(f'tl.fromTo("#hero-disc", {{scale: 0}}, {{scale: 1, duration: 0.7, ease: "back.out(1.5)"}}, {at("hero", 0.7)});')
tl.append(f'tl.fromTo("#hero-card-l", {{x: 0, rotation: 0, opacity: 0}}, {{x: -330, rotation: -7, opacity: 1, duration: 0.8, ease: "power3.out"}}, {at("hero", 1.0)});')
tl.append(f'tl.fromTo("#hero-card-r", {{x: 0, rotation: 0, opacity: 0}}, {{x: 330, rotation: 7, opacity: 1, duration: 0.8, ease: "power3.out"}}, {at("hero", 1.1)});')
tl.append(f'tl.to(["#hero-card-l", "#hero-card-r"], {{x: 0, rotation: 0, opacity: 0, duration: 0.4, ease: "power2.in"}}, {at("hero", d - 0.5)});')
tl.append(f'tl.to("#hero-phone", {{x: -400, rotationY: 35, opacity: 0, duration: 0.45, ease: "power2.in"}}, {at("hero", d - 0.45)});')
tl.append(f'tl.to("#hero-disc", {{scale: 0, duration: 0.4, ease: "power2.in"}}, {at("hero", d - 0.45)});')

# ------------------------------------------------------------------ chapters
for n, (cid, title, body, facts, chips) in enumerate(CHAPTERS):
    s, d = T[cid]
    left = n % 2 == 0  # phone on the left for even chapters, like the reference
    pcx = 560 if left else 1360
    text_left = 940 if left else 150
    disc_d = 820
    disc_x = pcx - disc_d / 2 + (-110 if left else 110)
    disc_y = 540 - disc_d / 2 - 40
    chip_html = "".join(f'<span class="chip">{esc(c)}</span>' for c in chips)
    title_html, nchars = split_chars(title, f"{cid}-t")
    fact_html = "".join(
        f'<div class="fact" id="{cid}-f{i}"><span class="tick">✓</span><span>{esc(f)}</span></div>' for i, f in enumerate(facts))
    parts.append(f"""
<div id="{cid}" class="clip scene dark" data-start="{s}" data-duration="{d}">
  <div class="disc" id="{cid}-disc" style="left:{disc_x}px; top:{disc_y}px; width:{disc_d}px; height:{disc_d}px"></div>
  <div class="col" id="{cid}-col" style="left:{text_left}px">
    <div class="chips" id="{cid}-chips">{chip_html}</div>
    <h1 class="title">{title_html}</h1>
    <p class="body" id="{cid}-body">{esc(body)}</p>
    <div class="facts">{fact_html}</div>
  </div>
</div>""")
    # the phone: untimed wrappers (animated), the timed video inside the screen hole
    parts.append(
        f'<div class="phone" id="{cid}-phone" style="left:{pcx - PW / 2}px; top:{PHONE_TOP}px; z-index:{20 + n}">'
        f'<video id="{cid}-video" class="clip screen-video" data-start="{s}" data-duration="{d}" src="assets/clips/{cid}.mp4" muted playsinline></video>'
        f'<img class="frame" src="assets/phone-frame.png" alt=""></div>')
    enter_x = 520 if left else -520
    exit_x = 420 if left else -420
    tl.append(f'tl.fromTo("#{cid}-phone", {{x: {enter_x}, rotationY: {-38 if left else 38}, scale: 0.86, opacity: 0}}, '
              f'{{x: 0, rotationY: 0, scale: 1, opacity: 1, duration: 0.75, ease: "power3.out"}}, {s});')
    tl.append(f'tl.fromTo("#{cid}-disc", {{scale: 0}}, {{scale: 1, duration: 0.65, ease: "back.out(1.4)"}}, {at(cid, 0.15)});')
    tl.append(f'tl.fromTo("#{cid}-chips", {{opacity: 0, y: 16}}, {{opacity: 1, y: 0, duration: 0.4}}, {at(cid, 0.25)});')
    tl.append(f'tl.fromTo("#{cid} .ch", {{opacity: 0, y: 26}}, {{opacity: 1, y: 0, duration: 0.28, ease: "power2.out", stagger: 0.022}}, {at(cid, 0.35)});')
    tl.append(f'tl.fromTo("#{cid}-body", {{opacity: 0, y: 22}}, {{opacity: 1, y: 0, duration: 0.5, ease: "power3.out"}}, {at(cid, 0.35 + nchars * 0.022 + 0.1)});')
    for i in range(len(facts)):
        tl.append(f'tl.fromTo("#{cid}-f{i}", {{opacity: 0, x: {-20 if not left else 20}}}, {{opacity: 1, x: 0, duration: 0.4, ease: "power2.out"}}, {at(cid, 1.3 + i * 0.25)});')
    tl.append(f'tl.to("#{cid}-col", {{opacity: 0, y: -14, duration: 0.3, ease: "power1.in"}}, {round(s + d - 0.4, 2)});')
    tl.append(f'tl.to("#{cid}-disc", {{scale: 0, duration: 0.4, ease: "power2.in"}}, {round(s + d - 0.45, 2)});')
    tl.append(f'tl.to("#{cid}-phone", {{x: {exit_x}, rotationY: {32 if left else -32}, scale: 0.9, opacity: 0, duration: 0.45, ease: "power2.in"}}, {round(s + d - 0.45, 2)});')

# ------------------------------------------------------------------ stack
s, d = T["stack"]
cards = [("One app, three platforms", "Expo on iOS, Android and the web."),
         ("Wallets by Privy", "The server builds each transaction. The Privy wallet signs it."),
         ("Solidity + Stylus", "A Solidity launchpad; the curve maths in Rust on Stylus."),
         ("Real reference prices", "Chainlink for stocks, Uniswap v3 at graduation, IPFS for media.")]
stats = [("31", "Foundry tests on a fork"), ("32,768", "invariant calls"), ("132", "server tests"), ("3", "platforms")]
parts.append(f"""
<div id="stack" class="clip scene dark" data-start="{s}" data-duration="{d}">
  <div class="stack-wrap" id="stack-wrap">
    <div class="kicker" id="st-kick">How it's built</div>
    <div class="cards">{''.join(f'<div class="bcard" id="st-c{i}"><div class="ct">{esc(a)}</div><div class="cb">{esc(b)}</div></div>' for i, (a, b) in enumerate(cards))}</div>
    <div class="stats">{''.join(f'<div class="stat" id="st-s{i}"><div class="sv">{a}</div><div class="sl">{esc(b)}</div></div>' for i, (a, b) in enumerate(stats))}</div>
  </div>
</div>""")
tl.append(f'tl.fromTo("#st-kick", {{opacity: 0, y: 20}}, {{opacity: 1, y: 0, duration: 0.5}}, {at("stack", 0.2)});')
step = (vo["stack"] * 0.62) / 4
for i in range(4):
    tl.append(f'tl.fromTo("#st-c{i}", {{opacity: 0, y: 40}}, {{opacity: 1, y: 0, duration: 0.55, ease: "power3.out"}}, {at("stack", 0.7 + i * step)});')
for i in range(4):
    tl.append(f'tl.fromTo("#st-s{i}", {{opacity: 0, y: 30}}, {{opacity: 1, y: 0, duration: 0.55, ease: "power3.out"}}, {at("stack", 0.9 + vo["stack"] * 0.66 + i * 0.4)});')
tl.append(f'tl.to("#stack-wrap", {{opacity: 0, duration: 0.35}}, {round(s + d - 0.4, 2)});')

# ------------------------------------------------------------------ outro
s, d = T["outro"]
parts.append(f"""
<div id="outro" class="clip scene" data-start="{s}" data-duration="{d}" style="background:{SAGE}">
  <div class="end">
    <div class="end-mark" id="end-mark">{LOGO.format(c=INK)}<span>juno</span></div>
    <div class="end-tag" id="end-tag">Every post is a market.</div>
    <div class="end-links" id="end-links"><span>juno-arb-app.vercel.app</span><span class="sep">·</span><span>github.com/nickthelegend/juno-arbitrum</span></div>
    <div class="end-built" id="end-built">Built on Arbitrum with Stylus, Chainlink and Uniswap</div>
  </div>
</div>""")
tl.append(f'tl.fromTo("#end-mark", {{opacity: 0, scale: 0.9}}, {{opacity: 1, scale: 1, duration: 0.8, ease: "power3.out"}}, {at("outro", 0.15)});')
tl.append(f'tl.fromTo("#end-tag", {{opacity: 0, y: 24}}, {{opacity: 1, y: 0, duration: 0.6}}, {at("outro", 0.9)});')
tl.append(f'tl.fromTo("#end-links", {{opacity: 0, y: 16}}, {{opacity: 1, y: 0, duration: 0.6}}, {at("outro", 1.8)});')
tl.append(f'tl.fromTo("#end-built", {{opacity: 0}}, {{opacity: 1, duration: 0.6}}, {at("outro", 2.4)});')

# ------------------------------------------------------------------ voiceover + captions
for key, start in VO_AT.items():
    parts.append(f'<audio id="vo-{key}" data-start="{round(start, 3)}" data-duration="{round(vo[key] + 0.3, 2)}" data-volume="1" src="assets/audio/vo-{key}.wav"></audio>')
    if key == "outro":  # the end card already says it
        continue
    ws = words[key]
    # phrases: break at sentence ends, commas past four words, or eight words
    phrases, cur = [], []
    for i, w in enumerate(ws):
        cur.append(i)
        end = w["w"][-1] in ".!?"
        soft = w["w"][-1] in ",:;" and len(cur) >= 4
        if end or soft or len(cur) >= 8:
            phrases.append(cur)
            cur = []
    if cur:
        phrases.append(cur)
    for p, idx in enumerate(phrases):
        p_start = round(start + ws[idx[0]]["s"] - 0.05, 3)
        nxt = phrases[p + 1][0] if p + 1 < len(phrases) else None
        p_end = round(start + (ws[nxt]["s"] - 0.05 if nxt is not None else ws[idx[-1]]["e"] + 0.35), 3)
        cap_id = f"cap-{key}-{p}"
        spans = " ".join(f'<span class="cw" id="{cap_id}-{j}">{esc(ws[i]["w"])}</span>' for j, i in enumerate(idx))
        parts.append(f'<div class="clip caption" id="{cap_id}" data-start="{p_start}" data-duration="{round(max(p_end - p_start, 0.3), 3)}"><div class="cap-pill">{spans}</div></div>')
        tl.append(f'tl.fromTo("#{cap_id} .cap-pill", {{opacity: 0, y: 10}}, {{opacity: 1, y: 0, duration: 0.18}}, {p_start});')
        for j, i in enumerate(idx):
            tl.append(f'tl.set("#{cap_id}-{j}", {{color: "{LIME}"}}, {round(start + ws[i]["s"], 3)});')

# ------------------------------------------------------------------ music
parts.append(f'<audio id="music" data-start="20" data-duration="{round(TOTAL - 20, 2)}" data-volume="0.9" data-fade-in="1.5" data-fade-out="4" src="assets/audio/music-bed.wav"></audio>')

CSS = f"""
@font-face {{ font-family: "Plus Jakarta Sans"; src: url("fonts/jakarta-400.woff2") format("woff2"); font-weight: 200 800; font-style: normal; }}
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
html, body {{ margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: {INK}; }}
#root {{ position: relative; width: 100%; height: 100%; font-family: "Plus Jakarta Sans", sans-serif; color: #F3F7EE; background: {INK}; }}
.clip {{ position: absolute; inset: 0; }}
.full {{ width: 1920px; height: 1080px; object-fit: cover; }}
.scene {{ overflow: hidden; }}
.dark {{ background: {INK}; color: #F3F7EE; }}
.browser {{ position: absolute; left: 160px; top: 80px; width: 1600px; height: 920px; border-radius: 22px; overflow: hidden; background: #fff; box-shadow: 0 40px 90px rgba(18,21,14,0.28), 0 0 0 1px rgba(18,21,14,0.08); }}
.bar {{ height: 52px; background: #F4F6F1; display: flex; align-items: center; gap: 10px; padding: 0 22px; border-bottom: 1px solid #E2E8DC; }}
.dot {{ width: 14px; height: 14px; border-radius: 7px; display: block; }}
.url {{ margin-left: 380px; width: 560px; height: 32px; border-radius: 10px; background: #fff; border: 1px solid #E2E8DC; font-size: 17px; font-weight: 600; color: #566150; display: flex; align-items: center; justify-content: center; }}
.viewport {{ position: relative; width: 1600px; height: 868px; overflow: hidden; }}
#web-shot {{ position: absolute; left: 0; top: 0; width: 1600px; height: auto; display: block; }}
.prob-logo {{ position: absolute; left: 150px; top: 90px; display: flex; align-items: center; gap: 14px; font-size: 44px; font-weight: 800; letter-spacing: -0.03em; }}
.prob-logo svg {{ width: 54px; height: 54px; display: block; }}
.prob-lines {{ position: absolute; left: 150px; top: 320px; width: 1640px; }}
.pl {{ font-size: 96px; font-weight: 800; letter-spacing: -0.035em; line-height: 1.12; margin-bottom: 18px; }}
.pl.muted {{ color: #8B9683; }}
.hl {{ color: {LIME}; }}
.disc {{ position: absolute; border-radius: 50%; background: {LIME}; }}
.card {{ position: absolute; left: {960 - 150}px; top: 230px; width: 300px; height: 533px; border-radius: 26px; object-fit: cover; box-shadow: 0 30px 60px rgba(0,0,0,0.45); }}
.phone {{ position: absolute; width: {PW}px; height: {PH}px; transform-origin: 50% 50%; }}
.phone .frame {{ position: absolute; left: 0; top: 0; width: {PW}px; height: {PH}px; display: block; }}
.phone .screen, .phone .screen-video {{ position: absolute; left: {HOLE}px; top: {HOLE}px; right: auto; bottom: auto; width: {SW}px; height: {SH}px; object-fit: fill; display: block; border-radius: 46px; }}
.col {{ position: absolute; top: 230px; width: 830px; }}
.chips {{ display: flex; gap: 12px; margin-bottom: 28px; }}
.chip {{ font-size: 20px; font-weight: 700; color: {LIME}; border: 2px solid {LIME}; border-radius: 999px; padding: 6px 18px; }}
.title {{ font-size: 88px; font-weight: 800; letter-spacing: -0.035em; line-height: 1.04; margin-bottom: 26px; color: #F7FAF3; }}
.wd {{ display: inline-block; white-space: nowrap; }}
.ch {{ display: inline-block; }}
.body {{ font-size: 32px; font-weight: 500; color: #A9B4A2; line-height: 1.38; margin-bottom: 40px; width: 800px; }}
.facts {{ display: flex; flex-direction: column; gap: 18px; }}
.fact {{ display: flex; align-items: center; gap: 18px; font-size: 28px; font-weight: 600; color: #E6ECE0; }}
.tick {{ width: 38px; height: 38px; border-radius: 19px; background: {LIME}; color: {INK}; font-size: 21px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex: none; }}
.stack-wrap {{ position: absolute; left: 150px; top: 170px; width: 1620px; }}
.kicker {{ font-size: 28px; font-weight: 800; color: {LIME}; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 40px; }}
.cards {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; margin-bottom: 64px; }}
.bcard {{ background: #1C2118; border-radius: 24px; padding: 34px 30px; min-height: 240px; }}
.ct {{ font-size: 32px; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 16px; color: #F3F7EE; }}
.cb {{ font-size: 24px; font-weight: 500; color: #A9B4A2; line-height: 1.4; }}
.stats {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; }}
.stat {{ border-top: 2px solid rgba(214,255,61,0.4); padding-top: 22px; }}
.sv {{ font-size: 104px; font-weight: 800; letter-spacing: -0.04em; color: {LIME}; line-height: 1; }}
.sl {{ font-size: 26px; font-weight: 600; color: #C8D2C1; margin-top: 10px; }}
.end {{ position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: {INK}; }}
.end-mark {{ display: flex; align-items: center; gap: 28px; font-size: 190px; font-weight: 800; letter-spacing: -0.045em; line-height: 1; }}
.end-mark svg {{ width: 190px; height: 190px; display: block; }}
.end-tag {{ font-size: 56px; font-weight: 700; letter-spacing: -0.03em; margin-top: 36px; }}
.end-links {{ display: flex; gap: 18px; font-size: 30px; font-weight: 600; color: #566150; margin-top: 44px; }}
.sep {{ color: #8B9683; }}
.end-built {{ font-size: 24px; font-weight: 600; color: #8B9683; margin-top: 26px; }}
.caption {{ z-index: 100; display: flex; align-items: flex-end; justify-content: center; padding-bottom: 34px; pointer-events: none; }}
.cap-pill {{ max-width: 1300px; background: rgba(10,12,8,0.78); border-radius: 18px; padding: 12px 26px; font-size: 36px; font-weight: 700; line-height: 1.3; color: #FFFFFF; text-align: center; letter-spacing: -0.01em; }}
.cw {{ color: #FFFFFF; }}
"""

doc = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>{CSS}</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{TOTAL}" data-width="1920" data-height="1080">
{chr(10).join(parts)}
    </div>
    <script>
      const tl = gsap.timeline({{ paused: true }});
{chr(10).join('      ' + line for line in tl)}
      window.__timelines["main"] = tl;
      tl.seek(0);
    </script>
  </body>
</html>
"""
open(f"{HF}/index.html", "w").write(doc)
json.dump({k: list(v) for k, v in T.items()} | {"total": TOTAL}, open(f"{HF}/timeline.json", "w"), indent=1)
print("total", TOTAL, "s")
