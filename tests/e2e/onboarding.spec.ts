import { test, expect } from "@playwright/test";

const HOST = "roma.serveos.localhost";

test("storefront serves a branded, installable PWA manifest", async ({ request }) => {
  const res = await request.get("http://localhost:3000/manifest.webmanifest", {
    headers: { host: HOST },
  });
  expect(res.ok()).toBeTruthy();
  const manifest = await res.json();
  expect(manifest.name).toBe("Pizza Roma");
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.length).toBeGreaterThan(0);
});

test("storefront home renders the restaurant brand", async ({ request }) => {
  const res = await request.get("http://localhost:3000/", { headers: { host: HOST } });
  expect(res.ok()).toBeTruthy();
  const html = await res.text();
  expect(html).toContain("Pizza Roma");
});

test("marketing host does not leak a tenant", async ({ request }) => {
  const res = await request.get("http://localhost:3000/", { headers: { host: "serveos.localhost" } });
  const html = await res.text();
  expect(html).toContain("ServeOS");
  expect(html).not.toContain("Pizza Roma");
});
