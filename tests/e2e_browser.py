"""Сквозной тест в настоящем Chrome (Playwright).
Запуск: node server.js (PORT=3123)  и  python3 tests/e2e_browser.py [путь_для_скриншотов]
Проверяет: звонок, игры через интерфейс (клики), мобильную вёрстку, обрыв сети и время отрисовки."""
import asyncio, sys, time
from playwright.async_api import async_playwright

URL = 'http://localhost:3123/?room=e2e' + str(int(time.time()))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/e2e_'
errors = []

async def join(ctx, name):
    p = await ctx.new_page()
    p.on('pageerror', lambda e: errors.append(f'{name}: {e}'))
    p.on('console', lambda m: m.type == 'error' and errors.append(f'{name} console: {m.text}'))
    await p.goto(URL); await p.wait_for_timeout(600)
    await p.fill('#name', name); await p.click('#join')
    await p.wait_for_function('typeof token === "string" && token.length > 0', timeout=8000)
    return p

async def gv(p):
    return await p.evaluate('gameView')

async def tap(p, sel):
    try:
        await p.click(sel, timeout=1500); return True
    except Exception:
        return False   # состояние успело смениться (кон закрылся) — это нормально

async def play_durak_turn(p):
    """Сделать один осмысленный ход через интерфейс (как человек: клики по картам/кнопкам)."""
    v = await gv(p)
    if not v or v['status'] != 'playing': return False
    L = v['state']['legal']
    if not L: return False
    if L['defend']:
        card, idxs = next(iter(L['defend'].items()))
        if not await tap(p, f'[data-act="card:{card}"]'): return False
        if len(idxs) > 1: return await tap(p, f'[data-act="target:{idxs[0]}"]')
        return True
    if L['attack'] and not L['pass']:
        return await tap(p, f'[data-act="card:{L["attack"][0]}"]')
    if L['pass']:
        return await tap(p, '[data-act="pass"]')
    if L['take']:
        return await tap(p, '[data-act="take"]')
    return False

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'])
        desk = await b.new_context(viewport={'width': 1366, 'height': 800}, permissions=['camera', 'microphone'])
        dev = {k: v for k, v in pw.devices['iPhone 13'].items() if k != 'default_browser_type'}
        mob = await b.new_context(**dev, permissions=['camera', 'microphone'])
        a = await join(desk, 'Аня')
        m = await join(mob, 'Миша')
        await a.wait_for_function('[...peers.values()].some(p => p.pc.connectionState === "connected")', timeout=10000)
        print('✓ видеосвязь установлена')

        # --- Дурак ---
        await a.click('#bGames'); await a.click('[data-act="create:durak"]')
        await m.wait_for_function('gameView && gameView.status === "lobby"')
        await m.click('#bGames'); await m.click('[data-act="join"]')
        await a.wait_for_function('gameView.players.length === 2')
        await a.click('[data-act="start"]')
        await m.wait_for_function('gameView.status === "playing"')
        print('✓ партия в Дурака началась (компьютер + телефон)')
        await a.screenshot(path=OUT + 'durak_desktop.png'); await m.screenshot(path=OUT + 'durak_mobile.png')

        # Время отрисовки панели (должно быть << 16 мс, чтобы не было лагов)
        rt = await a.evaluate('(() => { const t = performance.now(); for (let i = 0; i < 50; i++) renderGame(); return (performance.now() - t) / 50; })()')
        print(f'✓ отрисовка панели игры: {rt:.2f} мс')
        assert rt < 8, rt

        moves, rtts = 0, []
        for step in range(400):
            v = await gv(a)
            if v['status'] != 'playing': break
            before = (await gv(a))['state']
            t = time.perf_counter()
            moved = await play_durak_turn(a) or await play_durak_turn(m)
            if not moved:
                await a.wait_for_timeout(100); continue
            moves += 1
            # ждём, пока ход дойдёт до обоих
            try:
                await a.wait_for_function('s => JSON.stringify(gameView.state) !== s', arg=__import__('json').dumps(before), timeout=5000)
            except Exception:
                continue
            rtts.append((time.perf_counter() - t) * 1000)
            if moves == 6:
                await a.screenshot(path=OUT + 'durak_desktop_mid.png'); await m.screenshot(path=OUT + 'durak_mobile_mid.png')
            if moves == 10:
                # Обрыв сети у телефона посреди партии
                await mob.set_offline(True); await m.wait_for_timeout(1200)
                await m.evaluate('reconnect()')
                await mob.set_offline(False)
                await m.wait_for_function('typeof token === "string" && gameView && gameView.status === "playing" && gameView.state.legal', timeout=15000)
                print('✓ обрыв сети на телефоне: переподключился, место в партии сохранилось')
        v = await gv(a)
        rtts.sort()
        print(f'✓ сыграно ходов через интерфейс: {moves}, статус: {v["status"]}, задержка хода p50={rtts[len(rtts)//2]:.0f} мс, p95={rtts[int(len(rtts)*.95)]:.0f} мс')
        assert v['status'] == 'over', 'партия должна доиграться'
        await a.screenshot(path=OUT + 'durak_over.png'); await m.screenshot(path=OUT + 'durak_over_mobile.png')

        # --- Крестики-нолики ---
        await a.click('[data-act="close"]')
        await a.wait_for_function('gameView === null')
        await a.click('[data-act="create:ttt"]')
        await m.wait_for_function('gameView && gameView.type === "ttt"')
        await m.click('[data-act="join"]')
        await a.wait_for_function('gameView.players.length === 2'); await a.click('[data-act="start"]')
        await m.wait_for_function('gameView.status === "playing"')
        fails = 0
        for _ in range(60):
            v = await gv(a)
            if v['status'] != 'playing': break
            for p in (a, m):
                v = await gv(p)
                L = v['state']['legal'] if v['state'] else None
                if v['status'] == 'playing' and L and L['place']:
                    n = sum(1 for x in v['state']['board'] if x)
                    if await tap(p, f'[data-act="cell:{L["place"][0]}"]'):
                        await a.wait_for_function('n => gameView.status !== "playing" || gameView.state.board.filter(Boolean).length > n', arg=n, timeout=5000)
                    else:
                        fails += 1
                    break
            else:
                await a.wait_for_timeout(100)
        if (await gv(m))['status'] != 'over':
            print('ДИАГНОСТИКА:', fails, 'неудачных нажатий;', await a.evaluate('JSON.stringify([gameView.status, gameView.state && gameView.state.board, gameView.state && gameView.state.turn, me])'), await m.evaluate('JSON.stringify([gameView.status, gameView.state && gameView.state.legal, me])'))
            await m.screenshot(path=OUT + 'ttt_fail.png')
        await m.wait_for_function('gameView.status === "over"', timeout=10000)
        v = await gv(m)
        assert v['status'] == 'over', v['status']
        print('✓ крестики-нолики доиграны:', 'ничья' if v['state']['draw'] else 'есть победитель')
        await m.screenshot(path=OUT + 'ttt_mobile.png')

        # Видео всё это время не отвалилось
        st = await a.evaluate('[...peers.values()].map(p => p.pc.connectionState)')
        print('✓ видеосвязь после игр:', st)
        assert 'connected' in st
        await b.close()
    if errors:
        print('ОШИБКИ В КОНСОЛИ:'); [print(' ', e) for e in errors]; sys.exit(1)
    print('✓ ошибок в консоли нет')

asyncio.run(main())
