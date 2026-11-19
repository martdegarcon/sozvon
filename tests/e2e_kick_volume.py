"""Браузерный тест: отдельная громкость голоса и звука демонстрации + исключение голосованием.
Запуск: сервер на 3123, затем python3 tests/e2e_kick_volume.py"""
import asyncio, sys, time
from playwright.async_api import async_playwright

BASE = 'http://localhost:3123'
URL = BASE + '/?room=kick' + str(int(time.time()))
errors = []

# Демонстрация экрана в headless-браузере: подменяем getDisplayMedia холстом + тоном 440 Гц
FAKE_SCREEN = """
navigator.mediaDevices.getDisplayMedia = async () => {
  const c = document.createElement('canvas'); c.width = 640; c.height = 360;
  const g = c.getContext('2d'); setInterval(() => { g.fillStyle = '#' + Math.floor(Math.random() * 1e6).toString().padStart(6, '0'); g.fillRect(0, 0, 640, 360); }, 100);
  const s = c.captureStream(15);
  const ctx = new AudioContext(), o = ctx.createOscillator(), d = ctx.createMediaStreamDestination();
  o.frequency.value = 440; o.connect(d); o.start();
  s.addTrack(d.stream.getAudioTracks()[0]);
  return s;
};
"""

async def join(ctx, name):
    p = await ctx.new_page()
    p.on('pageerror', lambda e: errors.append(f'{name}: {e}'))
    p.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
    await p.add_init_script(FAKE_SCREEN)
    await p.goto(URL); await p.wait_for_timeout(400)
    await p.fill('#name', name); await p.click('#join')
    await p.wait_for_function('typeof token === "string" && token.length > 0', timeout=8000)
    return p

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        mk = lambda: b.new_context(viewport={'width': 1280, 'height': 760}, permissions=['camera', 'microphone'])
        a = await join(await mk(), 'Аня'); m = await join(await mk(), 'Миша'); v = await join(await mk(), 'Вика'); t = await join(await mk(), 'Тролль')
        for p in (a, m, v, t):
            await p.wait_for_function('peers.size === 3 && [...peers.values()].every(p => p.pc.connectionState === "connected" && p.audio.srcObject)', timeout=25000)
        print('✓ четверо соединились')

        # --- звук демонстрации идёт отдельной дорожкой ---
        await a.click('#bScreen')
        await m.wait_for_function('(() => { const p = [...peers.values()].find(x => x.name === "Аня"); return p.state.screen && p.saudio.srcObject && p.saudio.srcObject.getAudioTracks()[0].readyState === "live" && !p.saudio.paused; })()', timeout=10000)
        same = await m.evaluate('(() => { const p = [...peers.values()].find(x => x.name === "Аня"); return p.audio.srcObject.getAudioTracks()[0].id === p.saudio.srcObject.getAudioTracks()[0].id; })()')
        assert not same, 'голос и звук экрана — разные дорожки'
        print('✓ звук демонстрации пришёл отдельной дорожкой')

        # --- ползунки громкости ---
        await m.hover('.tile:has(.nm:text-is("Аня"))')
        await m.click('.tile:has(.nm:text-is("Аня")) .vol')
        await m.wait_for_selector('#peerMenu:not(.hidden)')
        await m.fill('#peerMenu input[data-k="s"]', '20')
        await m.fill('#peerMenu input[data-k="v"]', '70')
        vol = await m.evaluate('(() => { const p = [...peers.values()].find(x => x.name === "Аня"); return [p.audio.volume, p.saudio.volume, p.tile.el.classList.contains("quiet"), JSON.parse(localStorage.getItem("sozvon-vol"))["Аня"]]; })()')
        assert abs(vol[0] - .7) < .01 and abs(vol[1] - .2) < .01 and vol[2], vol
        print('✓ громкость: голос 70%, демонстрация 20% (запомнено:', vol[3], ')')
        await m.screenshot(path='/tmp/kick_volume_menu.png')
        await m.keyboard.press('Escape'); await m.mouse.click(5, 300)

        await a.click('#bScreen')
        await m.wait_for_function('!([...peers.values()].find(x => x.name === "Аня").state.screen)', timeout=5000)

        # --- голосование: Аня предлагает, Миша «за» → Тролль исключён (3 голосующих, нужно 2) ---
        await a.hover('.tile:has(.nm:text-is("Тролль"))')
        await a.click('.tile:has(.nm:text-is("Тролль")) .vol')
        await a.click('#peerMenu [data-a="kick"]')
        await m.wait_for_selector('.vote', timeout=5000)
        txt = await m.inner_text('.vote')
        assert 'Тролль' in txt and '1 из 2' in txt, txt
        assert await t.locator('.vote').count() == 0, 'Тролль не видит голосования'
        await v.screenshot(path='/tmp/kick_vote.png')
        print('✓ голосование видно у остальных:', ' '.join(txt.split()))
        tgone = t.wait_for_event('framenavigated', timeout=8000)
        await m.click('.vote .y')
        await tgone
        for p in (a, m, v):
            await p.wait_for_function('peers.size === 2 && !document.querySelector(".vote")', timeout=5000)
        print('✓ Тролль исключён, у остальных осталось по 2 собеседника')

        # повторный вход с того же браузера не пускает
        await t.wait_for_timeout(500)
        await t.fill('#name', 'Тролль'); await t.click('#join')
        await t.wait_for_timeout(1500)
        assert await a.evaluate('peers.size') == 2, 'Тролль не вернулся'
        print('✓ вернуться в комнату нельзя')

        # голосование, которое не набирает голосов (предлагает Миша — у Ани действует пауза между голосованиями)
        await m.hover('.tile:has(.nm:text-is("Вика"))')
        await m.click('.tile:has(.nm:text-is("Вика")) .vol')
        await m.click('#peerMenu [data-a="kick"]')
        await a.wait_for_selector('.vote', timeout=5000)
        await a.click('.vote .n')
        await m.wait_for_function('!document.querySelector(".vote")', timeout=5000)
        assert await v.evaluate('peers.size') == 2
        print('✓ «против» большинства — Вика осталась')
        await b.close()
    if errors:
        print('ОШИБКИ:', errors); sys.exit(1)
    print('✓ ошибок в консоли нет')

asyncio.run(main())
