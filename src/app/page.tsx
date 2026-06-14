import { headers } from "next/headers";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { getPublishedMenu } from "@/server/catalog/service";
import { getActiveBanners } from "@/server/banners/service";
import { listBranches } from "@/server/branches/service";
import { BranchSelector } from "./_components/BranchSelector";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string }>;
}) {
  const h = await headers();
  const surface = h.get("x-surface");
  const slug = h.get("x-tenant-slug");

  if (surface === "storefront" && slug) {
    const tenant = await getTenantBySlug(slug);
    if (!tenant) {
      return <main style={{ padding: 48, fontFamily: "system-ui" }}><h1>Restaurant not found</h1></main>;
    }
    if (!isTenantServable(tenant)) {
      return (
        <main style={{ padding: 48, fontFamily: "system-ui" }}>
          <h1>{tenant.name}</h1>
          <p>This restaurant is getting ready. Check back soon!</p>
        </main>
      );
    }

    const { branch: branchId } = await searchParams;

    const [banners, menu, branches] = await Promise.all([
      getActiveBanners(tenant.id),
      getPublishedMenu(tenant.id, branchId),
      listBranches(tenant.id),
    ]);

    return (
      <main style={{ fontFamily: "system-ui" }}>
        {banners.length > 0 && (
          <section style={{ display: "flex", gap: 8, overflowX: "auto", padding: "16px 24px" }}>
            {banners.map((b) => (
              <a key={b.id} href={b.linkUrl ?? "#"}>
                <img src={b.imageUrl} alt={b.titleEn ?? ""} style={{ height: 160, borderRadius: 8 }} />
              </a>
            ))}
          </section>
        )}

        {branches.length > 1 && (
          <section style={{ padding: "8px 24px" }}>
            <BranchSelector branches={branches} currentBranchId={branchId} />
          </section>
        )}

        <section style={{ padding: "0 24px 32px" }}>
          <h1 style={{ fontSize: 28, marginBottom: 4 }}>{tenant.name}</h1>
          {menu.categories.length === 0 && <p>Menu coming soon.</p>}
          {menu.categories.map((cat) => (
            <div key={cat.id} style={{ marginBottom: 32 }}>
              <h2 style={{ fontSize: 20, borderBottom: "2px solid currentColor", paddingBottom: 4 }}>
                {cat.nameEn} / {cat.nameAr}
              </h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 16, marginTop: 12 }}>
                {cat.products.map((p) => (
                  <div key={p.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
                    {p.imageUrl && <img src={p.imageUrl} alt={p.nameEn} style={{ width: "100%", height: 160, objectFit: "cover" }} />}
                    <div style={{ padding: 12 }}>
                      <div style={{ fontWeight: 600 }}>{p.nameEn}</div>
                      <div dir="rtl" style={{ color: "#6b7280", fontSize: 14 }}>{p.nameAr}</div>
                      {p.descriptionEn && <p style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>{p.descriptionEn}</p>}
                      <div style={{ marginTop: 8, fontWeight: 700 }}>
                        {p.effectivePrice.toFixed(2)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      </main>
    );
  }

  return (
    <main style={{ padding: 48, fontFamily: "system-ui" }}>
      <h1>ServeOS</h1>
      <p>The operating system for restaurants. Online ordering, reservations, and WhatsApp commerce.</p>
    </main>
  );
}
