import { expect, test } from '@playwright/test';
test('two players create, join, restore their session and synchronize a lobby', async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const a = await first.newPage(); const b = await second.newPage();
  const roomName = 'Вечер друзей ' + Date.now();
  try {
    for (const [page, name] of [[a, 'Алина'], [b, 'Борис']] as const) {
      await page.goto('/');
      await page.getByRole('textbox', { name: 'Имя игрока' }).fill(name);
      await page.getByRole('button', { name: 'Войти локально' }).click();
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
    await a.getByRole('button', { name: /Дурак/ }).click();
    await a.getByRole('button', { name: 'Создать комнату', exact: true }).click();
    await a.getByRole('textbox', { name: 'Название комнаты' }).fill(roomName);
    await a.getByRole('button', { name: 'Создать лобби' }).click();
    await expect(a.getByRole('heading', { name: roomName })).toBeVisible();
    await b.getByRole('button', { name: 'Комнаты', exact: true }).click();
    await b.locator('section.panel').filter({ has: b.getByRole('heading', { name: roomName }) }).getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(b.getByRole('heading', { name: roomName, level: 1 })).toBeVisible();
    await expect(a.getByText('Борис', { exact: true })).toBeVisible();
    await b.getByRole('button', { name: 'Я готов', exact: true }).click();
    await expect(a.getByText('Готов', { exact: true })).toBeVisible();
    await first.setOffline(true);
    await expect(a.getByText('Переподключение…', { exact: true })).toBeVisible();
    await b.getByRole('button', { name: 'Отменить готовность', exact: true }).click();
    await first.setOffline(false);
    await expect(a.getByText('Подключено', { exact: true })).toBeVisible();
    await expect(a.getByText('Готов', { exact: true })).toHaveCount(0);
    await a.reload();
    await expect(a.getByRole('heading', { name: roomName, level: 1 })).toBeVisible();
    await expect(a.getByText('Борис', { exact: true })).toBeVisible();
    await b.getByRole('button', { name: 'Покинуть комнату' }).click();
    await expect(a.getByText('Борис', { exact: true })).toHaveCount(0);
    await a.setViewportSize({ width: 390, height: 844 });
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await a.screenshot({ path: 'tests/.artifacts/lobby-mobile.png', fullPage: true });
    await a.getByRole('button', { name: 'Закрыть комнату' }).click();
    await expect(a.getByRole('heading', { name: roomName, level: 1 })).toHaveCount(0);
  } finally { await first.close(); await second.close(); }
});
test('library and account screens are responsive and settings survive reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Библиотека игр' })).toBeVisible();
  await expect(page.getByText('СКОРО', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: /Мафия/ })).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'tests/.artifacts/library-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Войти локально' }).click();
  for (const [button, title] of [['Профиль', 'Профиль игрока'], ['История', 'История матчей'], ['Рейтинги', 'Рейтинги'], ['Настройки', 'Настройки']] as const) {
    await page.getByRole('button', { name: button, exact: true }).click();
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  }
  await page.getByLabel('Уменьшить анимацию').check();
  await page.getByLabel('Компактные карточки игр').check();
  await page.getByRole('button', { name: 'Сохранить настройки' }).click();
  await expect(page.getByRole('button', { name: 'Сохранить настройки' })).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel('Компактные карточки игр')).toBeChecked();
  await page.getByRole('button', { name: 'Библиотека', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'tests/.artifacts/library-mobile.png', fullPage: true });
});
test('private invitation runs the test GameModule and persists history', async ({ browser }) => {
  const a = await browser.newPage(); const b = await browser.newPage();
  const roomName = 'Испытание ' + Date.now();
  try {
    for (const [page, name] of [[a, 'Первый'], [b, 'Второй']] as const) {
      await page.goto('/');
      await page.getByRole('textbox', { name: 'Имя игрока' }).fill(name);
      await page.getByRole('button', { name: 'Войти локально' }).click();
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
    await a.getByRole('button', { name: /Испытательный стол/ }).click();
    await a.getByRole('button', { name: 'Создать комнату', exact: true }).click();
    await a.getByRole('textbox', { name: 'Название комнаты' }).fill(roomName);
    await a.getByLabel('Приватная комната').check();
    await a.getByRole('button', { name: 'Создать лобби' }).click();
    await a.getByRole('button', { name: 'Создать приглашение' }).click();
    const invitation = await a.locator('.invite-code').innerText();
    await b.getByRole('button', { name: 'Комнаты', exact: true }).click();
    await expect(b.getByRole('heading', { name: roomName })).toHaveCount(0);
    await b.getByRole('textbox', { name: 'Войти по коду' }).fill(invitation);
    await b.getByRole('button', { name: 'Присоединиться' }).click();
    await expect(a.getByText('Второй', { exact: true })).toBeVisible();
    await a.getByRole('button', { name: 'Я готов', exact: true }).click();
    await b.getByRole('button', { name: 'Я готов', exact: true }).click();
    await a.getByRole('button', { name: 'Начать партию' }).click();
    await a.getByRole('button', { name: 'Ход +2' }).click();
    await b.getByRole('button', { name: 'Ход +1' }).click();
    await a.reload();
    await expect(a.getByRole('button', { name: 'Ход +2' })).toBeEnabled();
    await a.getByRole('button', { name: 'Ход +2' }).click();
    await expect(a.getByText(/Вы победили/)).toBeVisible();
    await expect(b.getByText(/Победитель: Первый/)).toBeVisible();
    await a.screenshot({ path: 'tests/.artifacts/results-desktop.png', fullPage: true });
    await a.getByRole('button', { name: 'История', exact: true }).click();
    await expect(a.getByText('Победа', { exact: true })).toBeVisible();
    await a.getByRole('button', { name: 'Рейтинги', exact: true }).click();
    await a.getByRole('combobox', { name: 'Игра', exact: true }).selectOption('sandbox');
    await expect(a.locator('.ranking-row').filter({ hasText: 'Первый' }).first()).toBeVisible();
    await a.getByRole('button', { name: 'Вернуться за стол' }).click();
    await a.getByRole('button', { name: 'Закрыть комнату' }).click();
  } finally { await a.close(); await b.close(); }
});
