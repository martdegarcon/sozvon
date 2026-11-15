"""Браузерный тест «все видят и слышат всех»: 3 участника (компьютер, iPhone, компьютер со строгим автозапуском звука).
Проверяет: видео и звук от каждого к каждому, кнопку «включить звук» при блокировке, автовосстановление пары,
вкладку «Связь» и статистику /health. Запуск: сервер на 3123, затем python3 tests/e2e_media.py"""
import asyncio, sys, time, json, urllib.request
from playwright.async_api import async_playwright

BASE = 'http://localhost:3123'
URL = BASE + '/?room=media' + str(int(time.time()))
errors = []

async def join(ctx, name, block_audio=False):
    p = await ctx.new_page()
    p.on('pageerror', lambda e: errors.append(f'{name}: {e}'))
    if block_audio:
        # имитируем браузер, который запрещает звук без нажатия: первый play() у <audio> отклоняется
        await p.add_init_script("""
          window.__blocked = true;
          const orig = HTMLMediaElement.prototype.play;
          HTMLMediaElement.prototype.play = function () {
            if (this.tagName === 'AUDIO' && window.__blocked) return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
            return orig.call(this);
          };
          document.addEventListener('pointerdown', () => { if (document.querySelector('#unmute:not(.hidden)')) window.__blocked = false; }, true);
        """)
    await p.goto(URL); await p.wait_for_timeout(500)
    await p.fill('#name', name); await p.click('#join')
    await p.wait_for_function('typeof token === "string" && token.length > 0', timeout=8000)
    return p

MEDIA_OK = '''() => [...peers.values()].map(p => ({
  name: p.name, state: p.pc.connectionState,
  video: p.tile.video.videoWidth > 0 && !p.tile.video.paused,
  audio: !!p.audio.srcObject && !p.audio.paused && p.audio.srcObject.getAudioTracks()[0]?.readyState === 'live',
  videoMuted: p.tile.video.muted }))'''

async def all_ok(p, n):
    await p.wait_for_function(f'''[...peers.values()].length === {n} && [...peers.values()].every(p => p.pc.connectionState === "connected" && p.tile.video.videoWidth > 0 && !p.tile.video.paused && p.audio.srcObject && !p.audio.paused)''', timeout=20000)

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox', '--autoplay-policy=document-user-activation-required'])
        dev = {k: v for k, v in pw.devices['iPhone 13'].items() if k != 'default_browser_type'}
        a = await join(await b.new_context(viewport={'width': 1280, 'height': 760}, permissions=['camera', 'microphone']), 'Аня')
        m = await join(await b.new_context(**dev, permissions=['camera', 'microphone']), 'Миша')
        c = await join(await b.new_context(viewport={'width': 1280, 'height': 760}, permissions=['camera', 'microphone']), 'Вика', block_audio=True)

        for p in (a, m):
            await all_ok(p, 2)
        print('✓ Аня и Миша видят и слышат всех:', await a.evaluate(MEDIA_OK))
        assert all(x['videoMuted'] for x in await a.evaluate(MEDIA_OK)), 'видео без звука — чтобы автозапуск не блокировался'

        # У Вики звук заблокирован: видео должно идти, а появиться кнопка «включить звук»
        await c.wait_for_function('[...peers.values()].length === 2 && [...peers.values()].every(p => p.pc.connectionState === "connected" && p.tile.video.videoWidth > 0)', timeout=20000)
        await c.wait_for_selector('#unmute:not(.hidden)', timeout=5000)
        print('✓ у Вики браузер заблокировал звук: видео идёт, показана кнопка «включить звук»')
        await c.click('#unmute')
        await all_ok(c, 2)
        await c.wait_for_selector('#unmute.hidden', state='attached', timeout=3000)
        print('✓ после нажатия Вика слышит всех')

        # Обрыв пары Аня↔Миша: Аня пересоздаёт соединение — обе стороны должны восстановиться
        await a.evaluate('''(() => { const p = [...peers.values()].find(x => x.name === "Миша"); send("signal", { reset: true }, p.id); wirePc(p, me < p.id); })()''')
        t0 = time.time()
        await all_ok(a, 2); await all_ok(m, 2)
        print(f'✓ пара Аня↔Миша пересоздана и восстановилась за {time.time() - t0:.1f} с')

        # Вкладка «Связь»
        await a.click('#bSet'); await a.click('[data-tab="net"]'); await a.wait_for_timeout(800)
        txt = await a.inner_text('#netPanel')
        assert 'соединено' in txt and 'Миша' in txt and 'Вика' in txt, txt
        print('✓ вкладка «Связь»:', ' | '.join(l for l in txt.split('\n') if l.strip())[:160])
        await a.screenshot(path='/tmp/media_netpanel.png')

        h = json.loads(urllib.request.urlopen(BASE + '/health').read())
        print('✓ /health net:', h['net']['connected'], 'resets:', h['net']['resets'], 'failed:', h['net']['failed'])
        assert sum(h['net']['connected'].values()) >= 6
        await b.close()
    if errors:
        print('ОШИБКИ:', errors); sys.exit(1)
    print('✓ ошибок в консоли нет')

asyncio.run(main())
