import { chromium } from '@playwright/test';

const base = 'http://127.0.0.1:5173';
const browser = await chromium.launch();
const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
const pages = await Promise.all(contexts.map(c => c.newPage()));
const [a, b] = pages;
for (const [i, page] of pages.entries()) {
  page.setDefaultTimeout(15000);
  page.on('console', m => { if (m.text().startsWith('[dbg-immersive]')) console.log('page' + i, m.text()); });
  await page.goto(base);
  await page.getByRole('textbox', { name: 'Имя игрока' }).fill('Shot ' + i);
  await page.getByRole('button', { name: 'Войти локально' }).click();
  await page.getByRole('button', { name: 'Выйти', exact: true }).waitFor();
}
await a.getByRole('button', { name: /Дурак/ }).click();
await a.getByRole('button', { name: 'Создать комнату', exact: true }).click();
await a.getByLabel('Мест за столом').selectOption('2');
await a.getByRole('textbox', { name: 'Название комнаты' }).fill('Screenshot room');
await a.getByRole('button', { name: 'Создать лобби' }).click();
await a.getByRole('button', { name: 'Создать приглашение' }).click();
const code = await a.locator('.invite-code').inputValue();
await b.getByRole('button', { name: 'Комнаты', exact: true }).click();
await b.getByRole('textbox', { name: 'Войти по коду' }).fill(code);
await b.getByRole('button', { name: 'Присоединиться' }).click();
for (const page of pages) await page.getByRole('button', { name: 'Я готов', exact: true }).click();
await a.getByRole('button', { name: 'Начать партию' }).click();
await a.locator('.own-hand .playing-card').first().waitFor();

for (const [w, h] of [[360, 640], [390, 844], [768, 1024], [1280, 720], [1920, 1080]]) {
  await a.setViewportSize({ width: w, height: h });
  await a.waitForTimeout(300);
  const m = await a.evaluate(() => ({
    sw: document.documentElement.scrollWidth, iw: innerWidth,
    sh: document.documentElement.scrollHeight, ih: innerHeight,
    bodySh: document.body.scrollHeight,
    mainH: document.querySelector('.immersive-main')?.getBoundingClientRect().height,
    roomScroll: document.querySelector('.room-screen')?.scrollHeight,
    roomClient: document.querySelector('.room-screen')?.clientHeight,
    gameScroll: document.querySelector('.durak-game')?.scrollHeight,
    gameClient: document.querySelector('.durak-game')?.clientHeight,
  }));
  console.log(w + 'x' + h, JSON.stringify(m));
  await a.screenshot({ path: 'tests/.artifacts/shot-' + w + 'x' + h + '.png' });
}
await browser.close();
