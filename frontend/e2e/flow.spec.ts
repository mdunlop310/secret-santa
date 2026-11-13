import { expect, test, type Browser, type Page } from '@playwright/test'

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025'
const run = Math.random().toString(36).slice(2, 8)
const codeword = `e2e ${run}`
const email = (name: string) => `e2e-${run}-${name.toLowerCase()}@example.com`

type MailSummary = { ID: string; Subject: string; To: { Address: string }[] }

/** The button link in the newest email to this address whose subject matches. */
async function emailButton(to: string, subject: RegExp): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages?limit=200`)).json()) as { messages: MailSummary[] }
    const message = list.messages.find((m) => m.To[0]?.Address === to && subject.test(m.Subject))
    if (message) {
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json()) as { Text: string }
      const match = full.Text.match(/https?:\/\/\S+\/open\/\S+/)
      if (match) {
        const url = new URL(match[0])
        return url.pathname + url.search
      }
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`no email matching ${subject} sent to ${to}`)
}

async function newPage(browser: Browser): Promise<Page> {
  return (await browser.newContext()).newPage()
}

function isoInDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000)
  return d.toISOString().slice(0, 10)
}

test('create, join, wish lists, exclusions, draw and reveal', async ({ browser }) => {
  // Create the group as Sam, who is taking part.
  const admin = await newPage(browser)
  await admin.goto('/new')
  await admin.getByLabel('Group name').fill(`E2E Santa ${run}`)
  await admin.getByLabel('Gift exchange date').fill(isoInDays(30))
  await admin.getByLabel('Min budget (£)').fill('15')
  await admin.getByLabel('Max budget (£)').fill('25')
  await admin.getByLabel('Codeword for friends').fill(codeword)
  await admin.getByLabel('Your name').fill('Sam')
  await admin.getByLabel('Your email').fill(email('Sam'))
  await expect(admin.getByLabel("I'm taking part too")).toBeChecked()
  const created = admin.waitForResponse((r) => r.url().endsWith('/groups') && r.request().method() === 'POST')
  await admin.getByRole('button', { name: 'Create group' }).click()
  const links = (await (await created).json()) as { admin_link: string }
  await expect(admin.getByRole('heading', { name: 'Your group is ready' })).toBeVisible()
  await expect(admin.getByText(codeword)).toBeVisible()
  await admin.getByRole('link', { name: 'Go to your group' }).click()
  await expect(admin.getByRole('heading', { name: `E2E Santa ${run}` })).toBeVisible()

  // Sam's one link also holds Sam's own wish list.
  await admin.getByRole('link', { name: 'Open your wish list' }).click()
  await expect(admin.getByRole('heading', { name: 'Your wish list' })).toBeVisible()
  await expect(admin.getByRole('button', { name: 'Leave this Secret Santa' })).toBeHidden()
  await admin.getByRole('link', { name: 'Back to group' }).click()

  // Alex and Priya enter the codeword in their own browsers and join; only Alex gives
  // an email. They land on their wish lists.
  const people: Record<string, Page> = { Sam: await newPage(browser) }
  await people.Sam.goto(`${new URL(links.admin_link).pathname}/wishlist`)
  const enterCodeword = async (page: Page, typed: string) => {
    await page.goto('/')
    await page.getByLabel('Group codeword').fill(typed)
    await page.getByRole('button', { name: 'Find my group' }).click()
    await expect(page.getByRole('heading', { name: `E2E Santa ${run}` })).toBeVisible()
  }
  for (const name of ['Alex', 'Priya']) {
    const page = await newPage(browser)
    await enterCodeword(page, codeword.toUpperCase().replace(' ', '-'))
    await page.getByLabel('Your name').fill(name)
    if (name === 'Alex') await page.getByLabel('Email (optional)').fill(email(name))
    await page.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your wish list' })).toBeVisible()
    people[name] = page
  }

  await admin.reload()
  await expect(admin.getByText('3 people')).toBeVisible()

  // Wish lists: Sam adds one item over budget, Alex one within, Priya wants a surprise.
  const addItem = async (page: Page, title: string, price: string) => {
    const form = page.getByRole('form', { name: 'Add an item' })
    await form.getByLabel('Item').fill(title)
    await form.getByLabel('Price (£)').fill(price)
    await form.getByRole('button', { name: 'Save item' }).click()
    await expect(page.getByRole('article', { name: title })).toBeVisible()
  }
  await expect(people.Sam.getByRole('heading', { name: 'Your wish list' })).toBeVisible()
  await addItem(people.Sam, 'Fancy headphones', '40')
  await expect(people.Sam.getByText('Over budget (max £25)')).toBeVisible()
  await addItem(people.Alex, 'Wool socks', '18')
  await people.Priya.getByLabel('Secret surprise: skip my list').check()
  await expect(people.Priya.getByRole('form', { name: 'Add an item' })).toBeHidden()

  // Exclusions: a mirrored Sam/Alex block makes three people impossible; one-way is fine.
  await admin.getByRole('link', { name: 'Edit exclusions' }).click()
  await admin.getByRole('button', { name: 'Sam to Alex, allowed' }).click()
  await expect(admin.getByRole('button', { name: 'Alex to Sam, blocked' })).toBeVisible()
  await expect(admin.getByText(/^No valid draw: /)).toBeVisible()
  await admin.getByRole('button', { name: 'Sam to Alex, blocked' }).click()
  await admin.getByLabel("One-way only (don't mirror)").check()
  await admin.getByRole('button', { name: 'Sam to Alex, allowed' }).click()
  await expect(admin.getByRole('button', { name: 'Alex to Sam, allowed' })).toBeVisible()
  await expect(admin.getByText('A valid draw is still possible')).toBeVisible()
  await admin.getByRole('button', { name: 'Save exclusions' }).click()
  await expect(admin.getByText("1 pair can't be matched")).toBeVisible()

  // Draw.
  await admin.getByRole('button', { name: 'Run the draw' }).click()
  await expect(admin.getByText('Names drawn')).toBeVisible()
  await expect(admin.locator('body')).not.toContainText("You're Secret Santa for")

  // Reveal: everyone sees one giftee, never themselves, and the exclusion holds.
  const giftees: Record<string, string> = {}
  for (const name of Object.keys(people)) {
    let page = people[name]
    if (name === 'Priya') {
      // On a new device: codeword, then tap her name.
      const fresh = await newPage(browser)
      await enterCodeword(fresh, codeword)
      await expect(fresh.getByRole('button', { name: 'Join', exact: true })).toBeHidden()
      await fresh.getByRole('button', { name: 'Priya' }).click()
      await expect(fresh.getByRole('heading', { name: 'Your wish list' })).toBeVisible()
      await page.close()
      people[name] = page = fresh
    }
    if (name === 'Alex') {
      // Straight from the button in the draw email, on a fresh browser.
      const fresh = await newPage(browser)
      await fresh.goto(await emailButton(email(name), /drawn/i))
      await expect(fresh.getByText("You're Secret Santa for")).toBeVisible()
      await page.close()
      people[name] = fresh
      giftees[name] = (await fresh.getByRole('heading', { level: 1 }).textContent())!.trim()
      continue
    }
    await page.reload()
    await page.getByRole('link', { name: "See who you're buying for" }).click()
    await expect(page.getByText("You're Secret Santa for")).toBeVisible()
    giftees[name] = (await page.getByRole('heading', { level: 1 }).textContent())!.trim()
  }
  expect(Object.values(giftees).sort()).toEqual(['Alex', 'Priya', 'Sam'])
  for (const [name, giftee] of Object.entries(giftees)) expect(giftee).not.toBe(name)
  expect(giftees.Sam).not.toBe('Alex')

  // With Sam -> Alex blocked, the only valid cycle is Sam -> Priya -> Alex -> Sam.
  expect(giftees).toEqual({ Sam: 'Priya', Priya: 'Alex', Alex: 'Sam' })
  await expect(people.Sam.getByText('Priya wants to be surprised')).toBeVisible()
  await expect(people.Priya.getByRole('article', { name: 'Wool socks' })).toContainText('£18 · within budget')
  await expect(people.Alex.getByRole('article', { name: 'Fancy headphones' })).toContainText('£40 · over budget')
})
