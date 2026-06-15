# ServeOS Landing & Auth Pages Design

**Goal:** Replace the placeholder marketing homepage and unstyled auth forms with a proper dark-themed landing page, login page, and register page — giving restaurant operators a real entry point into the product.

**Architecture:** Style three existing pages in place. No new routes, no new shared components, no new styling system. All UI uses inline styles consistent with the rest of the codebase. One bug fix: post-login redirect corrected from `/` to `/dashboard`.

**Tech Stack:** Next.js 16 App Router, React 19, inline styles, existing Server Actions.

---

## Pages

### 1. Homepage (`/`) — marketing surface

The existing `src/app/page.tsx` already branches on `x-surface`. Only the `else` branch (the marketing fallback) changes. The storefront path is untouched.

**Nav**
- Full-width, `background: #0f172a`
- Left: orange square logo (`#f97316`, 28×28px, border-radius 6px) + "ServeOS" wordmark in white
- Right: "Sign in" text link (`color: #94a3b8`) → `/login`; "Get started" button (`background: #f97316`, white text) → `/register`
- Padding: 16px 32px

**Hero**
- `background: #0f172a`, centred text, padding 80px 32px
- Headline: "Run your restaurant. Not your software." — white, 40px, font-weight 800
- Subline: "Menu, orders, WhatsApp commerce — one platform." — `#64748b`, 18px, margin-top 12px
- Two CTAs (margin-top 32px, inline-flex gap 12px):
  - "Get started free" — `background: #f97316`, white, padding 12px 24px, border-radius 6px → `/register`
  - "Sign in →" — `border: 1px solid #334155`, `color: #94a3b8`, same padding → `/login`

**Feature pillars**
- `background: #fff`, three equal columns (`display: grid; grid-template-columns: repeat(3,1fr)`), `border-top: 1px solid #f1f5f9`
- Each column: emoji (24px), bold title (`color: #0f172a`, 15px), description (`color: #6b7280`, 13px), padding 32px 24px, vertical divider between columns
- Columns:
  1. 🍽️ **Menu & Catalog** — "Products, categories, branches, and modifiers. Your full menu online."
  2. 📦 **Online Ordering** — "Cart, checkout, and real-time order tracking for your customers."
  3. 💬 **WhatsApp Commerce** — "Let customers order via WhatsApp chatbot — no app needed."

**Footer**
- `background: #0f172a`, padding 20px 32px, `display: flex; justify-content: space-between`
- Left: "© 2026 ServeOS" — `color: #475569`, 13px
- Right: "Privacy · Terms" — `color: #475569`, 13px, plain anchor tags (href="#" for now)

---

### 2. Login page (`/login`)

Full-page dark background (`background: #0f172a`, `min-height: 100vh`). Centred flex column.

**Card** (`background: #1e293b`, `border-radius: 12px`, `padding: 40px`, `width: 100%`, `max-width: 400px`)

- **Logo row** (top of card, margin-bottom 28px): orange square (24×24px) + "ServeOS" link back to `/` in white, `text-decoration: none`
- **Heading:** "Welcome back" — white, 22px, font-weight 700
- **Sub:** "Sign in to your restaurant dashboard" — `#64748b`, 14px, margin-top 4px, margin-bottom 24px
- **Error message** (rendered when `searchParams.error` is truthy): `color: #f87171`, 13px, margin-bottom 16px — "Invalid restaurant, email, or password."
- **Fields** (display grid, gap 16px):
  - Each field: label (`color: #94a3b8`, 12px, font-weight 500, display block, margin-bottom 4px) + input (`background: #0f172a`, `border: 1px solid #334155`, `border-radius: 6px`, `padding: 10px 12px`, `color: #f1f5f9`, `font-size: 14px`, `width: 100%`)
  - Restaurant: `name="slug"`, `placeholder="e.g. roma"`
  - Email: `name="email"`, `type="email"`, `placeholder="you@example.com"`
  - Password: `name="password"`, `type="password"`, `placeholder="••••••••"`
- **Submit button** (margin-top 8px, full width): "Sign in" — `background: #f97316`, white, 14px, font-weight 600, padding 11px, border-radius 6px, `border: none`, `cursor: pointer`
- **Footer link** (margin-top 20px, text-align center, 13px, `color: #64748b`): "Don't have an account? " + "Get started →" (`color: #f97316`, no underline) → `/register`

**Page component** must accept `searchParams: Promise<{ error?: string }>` and await it to read the error flag.

---

### 3. Register page (`/register`)

Same full-page dark background and card structure as login.

**Card contents:**
- **Logo row:** same as login
- **Heading:** "Create your restaurant" — white, 22px, font-weight 700
- **Sub:** "Start your free trial. No credit card required." — `#64748b`, 14px
- **Fields** (same input style as login):
  - Restaurant name: `name="restaurantName"`, `placeholder="Roma Ristorante"`
  - Subdomain: `name="slug"`, `placeholder="roma"` + helper text below input (`color: #475569`, 11px): "Your storefront will be at roma.serveos.com"
  - Country: `name="country"`, `<select>` styled to match inputs, options: Egypt / Saudi Arabia
  - Your name: `name="ownerName"`, `placeholder="Ahmed Hassan"`
  - Email: `name="email"`, `type="email"`
  - Password: `name="password"`, `type="password"`, `placeholder="Min. 8 characters"`
- **Submit:** "Start free trial" — same orange button style
- **Footer link:** "Already have an account? " + "Sign in →" (`color: #f97316`) → `/login`

---

## Bug fixes

`src/app/login/actions.ts` line 30: change `redirect("/")` → `redirect("/dashboard")`.
`src/app/register/actions.ts` line 19: change `redirect("/")` → `redirect("/dashboard")`.

Both actions currently drop the operator back on the marketing homepage after success. Without this fix there is no way to reach the dashboard after signing in or registering.

---

## Scope boundaries

- No new routes
- No CSS files or Tailwind — inline styles only, matching existing codebase style
- No forgot-password flow
- Footer links ("Privacy", "Terms") are `href="#"` placeholders — no pages behind them
- No animation or transitions
- No logo image file — the orange square div is the logo

---

## Testing

Manual smoke test only (no new server logic to unit-test):
1. Visit `localhost:3000` → see landing page with nav, hero, pillars, footer
2. Click "Sign in" → reach styled `/login` page
3. Submit bad credentials → return to `/login?error=1` with error message visible
4. Submit `owner@roma.com / owner1234 / roma` → redirect to `/dashboard`
5. Click "Get started free" from homepage → reach styled `/register` page
6. Register a new restaurant → redirect to `/dashboard`
