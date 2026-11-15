"""Браузерный тест раскладок: пресеты, перетаскивание, растягивание, сохранение после перезагрузки, мобильное меню.
Запуск: сервер на 3123, затем python3 tests/e2e_layout.py"""
import asyncio, time
from playwright.async_api import async_playwright
URL='http://localhost:3123/?room=lay'+str(int(time.time()))
async def join(ctx,n):
    p=await ctx.new_page(); p.on('pageerror',lambda e:print('ERR',n,e)); await p.goto(URL); await p.wait_for_timeout(400); await p.fill('#name',n); await p.click('#join'); await p.wait_for_function('token'); return p
async def main():
    async with async_playwright() as pw:
        b=await pw.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--no-sandbox'])
        d=await b.new_context(viewport={'width':1440,'height':860},permissions=['camera','microphone'])
        dev={k:v for k,v in pw.devices['iPhone 13'].items() if k!='default_browser_type'}
        m=await b.new_context(**dev,permissions=['camera','microphone'])
        a=await join(d,'Аня'); 
        others=[await join(await b.new_context(permissions=['camera','microphone']),n) for n in ['Борис','Вика']]
        mob=await join(m,'Миша')
        await a.wait_for_timeout(2500)
        await a.screenshot(path='/tmp/layout_L1_grid.png')
        await a.click('#bGames'); await a.click('[data-act="create:durak"]')
        for p in others+[mob]:
            await p.wait_for_function('gameView'); await p.click('#bGames'); await p.click('[data-act="join"]')
        await a.wait_for_function('gameView.players.length===4'); await a.click('[data-act="start"]')
        await mob.wait_for_function('gameView.status==="playing"'); await a.wait_for_timeout(800)
        await a.screenshot(path='/tmp/layout_L2_center.png'); await mob.screenshot(path='/tmp/layout_M1_split.png')
        for pid in ['game-top','game-side','game-full','grid']:
            if await a.evaluate('document.querySelector("#layoutMenu").classList.contains("hidden")'): await a.click('#bLayout')
            await a.click(f'[data-preset="{pid}"]'); await a.wait_for_timeout(600)
            await a.screenshot(path=f'/tmp/layout_L_{pid}.png')
        await a.click('body', position={'x':5,'y':5})
        # drag a tile onto the game and resize the game
        t=a.locator('#grid .tile').nth(0); bb=await t.bounding_box()
        await a.mouse.move(bb['x']+bb['width']/2, bb['y']+bb['height']/2); await a.mouse.down(); await a.mouse.move(700,400,steps=12); await a.mouse.up()
        g=a.locator('#games .rz'); gb=await g.bounding_box()
        await a.mouse.move(gb['x']+10,gb['y']+10); await a.mouse.down(); await a.mouse.move(gb['x']-200,gb['y']-150,steps=10); await a.mouse.up()
        await a.wait_for_timeout(500); await a.screenshot(path='/tmp/layout_L3_custom.png')
        print('custom:', await a.evaluate('JSON.stringify(LY.game)'), await a.evaluate('Object.keys(LY.custom.game).length'))
        await a.reload(); await a.fill('#name','Аня'); await a.click('#join'); await a.wait_for_function('token && gameView && gameView.status==="playing"')
        await a.click('#bGames'); await a.wait_for_timeout(1500); await a.screenshot(path='/tmp/layout_L4_after_reload.png')
        # mobile: more sheet, m-full
        await mob.click('#bMore'); await mob.wait_for_timeout(300); await mob.screenshot(path='/tmp/layout_M2_more.png')
        await mob.click('[data-more="layout"]'); await mob.wait_for_timeout(300); await mob.screenshot(path='/tmp/layout_M3_layoutmenu.png')
        await mob.click('[data-preset="m-full"]'); await mob.wait_for_timeout(600); await mob.click('#games .chat-h span'); await mob.screenshot(path='/tmp/layout_M4_full.png')
        await b.close()
asyncio.run(main())
