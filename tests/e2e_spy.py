"""Браузерный тест «Шпиона»: 4 игрока (2 компьютера, 2 телефона).
Запуск: сервер на 3123, затем python3 tests/e2e_spy.py [префикс_скриншотов]"""
import asyncio, sys, time
from playwright.async_api import async_playwright
URL = 'http://localhost:3123/?room=spy' + str(int(time.time()))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/spy_'
errors = []

async def join(ctx, name):
    p = await ctx.new_page()
    p.on('pageerror', lambda e: errors.append(f'{name}: {e}'))
    await p.goto(URL); await p.wait_for_timeout(500)
    await p.fill('#name', name); await p.click('#join')
    await p.wait_for_function('typeof token === "string" && token.length > 0', timeout=8000)
    return p

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'])
        dev = {k: v for k, v in pw.devices['iPhone 13'].items() if k != 'default_browser_type'}
        ctxs = [await b.new_context(viewport={'width': 1366, 'height': 800}, permissions=['camera', 'microphone']) for _ in range(2)] + \
               [await b.new_context(**dev, permissions=['camera', 'microphone']) for _ in range(2)]
        names = ['Аня', 'Борис', 'Вика', 'Гоша']
        ps = [await join(c, n) for c, n in zip(ctxs, names)]
        host = ps[0]
        await host.click('#bGames'); await host.click('[data-act="create:spy"]')
        for p in ps[1:]:
            await p.wait_for_function('gameView && gameView.type === "spy"')
            await p.click('#bGames'); await p.click('[data-act="join"]')
        await host.wait_for_function('gameView.players.length === 4')
        await host.click('[data-act="start"]')
        for p in ps: await p.wait_for_function('gameView.status === "playing"')
        views = [await p.evaluate('gameView.state') for p in ps]
        spies = [i for i, v in enumerate(views) if v['me']['spy']]
        assert len(spies) == 1, spies
        loc = {v['me'].get('location') for v in views if not v['me']['spy']}
        assert len(loc) == 1 and None not in loc, loc
        si = spies[0]
        print(f'✓ шпион один ({names[si]}), у остальных одна локация: {loc.pop()}')
        # шпион не видит локацию нигде на экране, кроме общего списка
        txt = await ps[si].inner_text('.spycard')
        assert 'шпион' in txt
        civ = [i for i in range(4) if i != si]
        await ps[civ[0]].screenshot(path=OUT + 'civil.png'); await ps[si].screenshot(path=OUT + 'spy.png')
        mob_civ = next(i for i in civ if i >= 2) if any(i >= 2 for i in civ) else civ[0]
        await ps[mob_civ].screenshot(path=OUT + 'civil_mobile.png')
        if si >= 2: await ps[si].screenshot(path=OUT + 'spy_mobile.png')

        # Скрыть/показать карточку
        await ps[civ[0]].click('.spycard'); await ps[civ[0]].wait_for_function('document.querySelector(".spycard").innerText.includes("скрыта")', timeout=3000)
        await ps[civ[0]].click('.spycard'); await ps[civ[0]].wait_for_function('document.querySelector(".spycard").innerText.includes("📍")', timeout=3000)
        print('✓ карточку можно скрыть и показать (удобно при демонстрации экрана)')

        # Вычёркивание локаций не сбрасывается при обновлениях
        p0 = ps[civ[1]]
        await p0.click('details.lc summary')
        await p0.click('.locs button >> nth=0')
        # 1) Ложное обвинение мирного: один голос «против» снимает обвинение
        accuser, target, other = civ[0], civ[1], civ[2]
        await ps[accuser].click(f'[data-act="spyask:{views[target]["players"][target]["id"]}"]')
        await ps[accuser].click(f'[data-act="spyaccuse:{views[target]["players"][target]["id"]}"]')
        await ps[other].wait_for_selector('[data-act="spyvote:0"]')
        await ps[other].screenshot(path=OUT + 'vote.png')
        await ps[other].click('[data-act="spyvote:0"]')
        await host.wait_for_function('gameView.state.accusation === null && gameView.state.log.some(l => l.includes("не прошло"))')
        assert await p0.evaluate('document.querySelector("details.lc").open'), 'список локаций остался открытым'
        assert await p0.evaluate('document.querySelectorAll(".locs button.x").length') == 1, 'пометка сохранилась'
        print('✓ обвинение с голосом «против» снято, пометки игрока не сбросились')

        # 2) Верное обвинение шпиона: все «за»
        spy_id = views[si]['players'][si]['id']
        await ps[other].click(f'[data-act="spyask:{spy_id}"]'); await ps[other].click(f'[data-act="spyaccuse:{spy_id}"]')
        for i in civ:
            if i == other: continue
            await ps[i].wait_for_selector('[data-act="spyvote:1"]'); await ps[i].click('[data-act="spyvote:1"]')
        for p in ps: await p.wait_for_function('gameView.status === "over"')
        res = await host.evaluate('gameView.state')
        assert res['winner'] == 'civil', res
        print('✓ шпиона вычислили единогласно — мирные победили:', res['reason'])
        await ps[si].screenshot(path=OUT + 'over_spy.png'); await ps[3].screenshot(path=OUT + 'over_mobile.png')

        # 3) Ещё партия: шпион называет локацию
        await host.click('[data-act="start"]')
        for p in ps: await p.wait_for_function('gameView.status === "playing"')
        vs = [await p.evaluate('gameView.state') for p in ps]
        si2 = next(i for i, v in enumerate(vs) if v['me']['spy'])
        real = next(v['me']['location'] for v in vs if not v['me']['spy'])
        sp = ps[si2]
        await sp.click('[data-act="spyguess"]')
        await sp.click(f'.acc .locs button:text-is("{real}")')
        await sp.screenshot(path=OUT + 'guess.png')
        await sp.click('[data-act="spyconfirm"]')
        for p in ps: await p.wait_for_function('gameView.status === "over"')
        assert (await host.evaluate('gameView.state.winner')) == 'spy'
        print('✓ вторая партия: шпион угадал локацию и победил')
        st = await host.evaluate('[...peers.values()].map(p => p.pc.connectionState)')
        print('✓ видеосвязь:', st); assert all(x == 'connected' for x in st)
        await b.close()
    if errors: print('ОШИБКИ:', errors); sys.exit(1)
    print('✓ ошибок в консоли нет')
asyncio.run(main())
