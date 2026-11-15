"""Браузерный тест «Бара лжецов»: 4 игрока (2 компьютера + 2 телефона) играют до последнего выжившего,
кликая по картам и кнопкам. Запуск: сервер на 3123, затем python3 tests/e2e_liar.py [префикс_скриншотов]"""
import asyncio, sys, time, random
from playwright.async_api import async_playwright
URL = 'http://localhost:3123/?room=liar' + str(int(time.time()))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/liar_'
MODE = sys.argv[2] if len(sys.argv) > 2 else 'liar'
errors = []
random.seed(7)

async def join(ctx, name):
    p = await ctx.new_page()
    p.on('pageerror', lambda e: errors.append(f'{name}: {e}'))
    await p.goto(URL); await p.wait_for_timeout(500)
    await p.fill('#name', name); await p.click('#join')
    await p.wait_for_function('typeof token === "string" && token.length > 0', timeout=8000)
    return p

async def tap(p, sel):
    try: await p.click(sel, timeout=1500); return True
    except Exception: return False

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'])
        dev = {k: v for k, v in pw.devices['iPhone 13'].items() if k != 'default_browser_type'}
        ctxs = [await b.new_context(viewport={'width': 1366, 'height': 800}, permissions=['camera', 'microphone']) for _ in range(2)] + \
               [await b.new_context(**dev, permissions=['camera', 'microphone']) for _ in range(2)]
        names = ['Аня', 'Борис', 'Вика', 'Гоша']
        ps = [await join(c, n) for c, n in zip(ctxs, names)]
        host = ps[0]
        await host.click('#bGames'); await host.click(f'[data-act="create:{MODE}"]')
        for p in ps[1:]:
            await p.wait_for_function('gameView && gameView.type')
            await p.click('#bGames'); await p.click('[data-act="join"]')
        await host.wait_for_function('gameView.players.length === 4')
        await host.click('[data-act="start"]')
        for p in ps: await p.wait_for_function('gameView.status === "playing"')
        print('✓ партия на 4 игроков началась')
        shots_seen = reveals = plays = calls = 0
        shot_taken = {'play': False, 'reveal': False}
        t_end = time.time() + 240
        while time.time() < t_end:
            v = await host.evaluate('gameView')
            if v['status'] != 'playing':
                break
            st = v['state']
            if st['phase'] == 'reveal':
                reveals += 1
                if not shot_taken['reveal']:
                    await host.wait_for_timeout(300); await ps[3].screenshot(path=OUT + 'reveal_spin_mobile.png')
                    await host.wait_for_timeout(1600); await ps[3].screenshot(path=OUT + 'reveal_mobile.png'); await host.screenshot(path=OUT + 'reveal_desktop.png')
                    shot_taken['reveal'] = True
                await host.wait_for_function('gameView.status !== "playing" || gameView.state.phase === "play"', timeout=8000)
                continue
            turn = st['turn']
            idx = next(i for i, x in enumerate(st['players']) if x['id'] == turn)
            p = ps[idx]
            pv = await p.evaluate('gameView.state')
            L = pv['legal']
            if not L:
                await host.wait_for_timeout(50); continue
            if not shot_taken['play'] and pv['last'] and idx >= 2:
                await p.screenshot(path=OUT + 'turn_mobile.png'); shot_taken['play'] = True
            before = await host.evaluate('JSON.stringify([gameView.state.phase, gameView.state.pile, gameView.state.turn, gameView.state.round])')
            if L['call'] and (not L['play'] or random.random() < 0.4):
                ok = await tap(p, '[data-act="lcall"]'); calls += ok
            else:
                hand = pv['hand']
                k = random.randint(1, min(3, len(hand)))
                for j in random.sample(range(len(hand)), k):
                    await tap(p, f'[data-act="lpick:{j}"]')
                ok = await tap(p, '[data-act="lplay"]'); plays += ok
            if ok:
                try: await host.wait_for_function('b => JSON.stringify([gameView.state.phase, gameView.state.pile, gameView.state.turn, gameView.state.round]) !== b || gameView.status !== "playing"', arg=before, timeout=5000)
                except Exception: pass
        v = await host.evaluate('gameView')
        assert v['status'] == 'over', v['status']
        alive = [x['name'] for x in v['state']['players'] if x['alive']]
        print(f'✓ сыграно: {plays} выкладок, {calls} «Лжец!», {reveals} вскрытий; выжил: {alive}')
        await host.wait_for_timeout(1800)
        await host.screenshot(path=OUT + 'over_desktop.png'); await ps[2].screenshot(path=OUT + 'over_mobile.png')
        st = await host.evaluate('[...peers.values()].map(p => p.pc.connectionState)')
        print('✓ видеосвязь:', st); assert all(x == 'connected' for x in st)
        await b.close()
    if errors: print('ОШИБКИ:', errors); sys.exit(1)
    print('✓ ошибок в консоли нет')
asyncio.run(main())
